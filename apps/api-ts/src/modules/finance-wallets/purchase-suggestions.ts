import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { queryInteger } from "../registrations/query.js"
import { position } from "../inventory/replenishment.js"
import { decimal, fixed, validateDate } from "../sales/fixed.js"
import { pathId } from "./documents.js"

/** Sugestões de compra (C4): necessidade do estoque (E7) + último fornecedor/preço; "Gerar pedidos" agrupa por fornecedor. */
const read = ["purchasing.orders.read", "inventory.stock.read"],
  manage = "purchasing.orders.manage"
const page = z.strictObject({ limit: queryInteger(1, 100).default(25), offset: queryInteger(0, 100000).default(0) })
const generate = z.strictObject({
  dueDate: z.string().transform(validateDate),
  items: z.array(z.strictObject({
    productId: z.guid().transform(pathId),
    quantity: z.string().transform(n => decimal(fixed(n, 6), 6)),
    supplierId: z.guid().transform(pathId).nullish(),
    unitCost: z.string().transform(n => decimal(fixed(n, 2), 2)).nullish(),
  })).min(1).max(100),
})
const invalid = (title: string): never => { throw new Problem(422, "invalid_input", title) }

async function lastPurchase(ctx: { client: { query: Function }; tenantId: string }, productId: string) {
  const row = (await ctx.client.query(
    `SELECT o.supplier_id,l.cost_cents FROM purchase_order_lines l JOIN purchase_orders o ON (o.tenant_id,o.id)=(l.tenant_id,l.order_id)
     WHERE l.tenant_id=$1 AND l.product_id=$2 AND o.status<>'cancelled' ORDER BY o.created_at DESC LIMIT 1`, [ctx.tenantId, productId])).rows[0]
  return row ? { supplierId: String(row.supplier_id), cost: BigInt(String(row.cost_cents)) } : null
}

export function registerPurchaseSuggestions(app: FastifyInstance, deps: AppDependencies) {
  const url = "/api/v1/purchase-suggestions"
  app.get(url, { config: { openapi: { summary: "Sugestões de compra por ponto de pedido", query: page } } }, async (req, reply) => {
    const body = await authorizeRequest(req, deps, async ctx => {
      if (!read.some(p => ctx.permissions.includes(p))) requirePermission(ctx, read[0]!)
      const q = page.safeParse(req.query ?? {})
      if (!q.success) invalid("Paginação inválida")
      const result = await position(ctx, { q: "", mode: "needed", offset: q.data!.offset, limit: q.data!.limit })
      const data = []
      for (const row of result.data) {
        const last = await lastPurchase(ctx, String(row.productId))
        data.push({ ...row, supplierId: last?.supplierId ?? null, lastUnitCost: last ? decimal(last.cost, 2) : null })
      }
      return { tenantId: ctx.tenantId, canGenerate: ctx.permissions.includes(manage), data, total: result.total, offset: result.offset, limit: result.limit }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  app.post(url + "/orders", { config: { openapi: { summary: "Gera pedidos de compra em rascunho, agrupados por fornecedor", body: generate, successStatus: 201 } } }, async (req, reply) => {
    const key = commandKey(req.headers["idempotency-key"])
    const body = await authorizeRequest(req, deps, async ctx => {
      requirePermission(ctx, "purchasing.orders.read"); requirePermission(ctx, manage)
      const parsed = generate.safeParse(req.body)
      if (!parsed.success) invalid("Informe a data de vencimento e de um a cem produtos com quantidade")
      const input = parsed.data!, scope = "purchase.suggestions.generate"
      const saved = await replay(ctx, key, scope, input)
      if (saved) return saved
      const groups = new Map<string, { productId: string; quantity: bigint; cost: bigint }[]>()
      if (new Set(input.items.map(i => i.productId)).size !== input.items.length) invalid("Informe cada produto uma vez")
      for (const item of input.items) {
        const last = item.supplierId && item.unitCost ? null : await lastPurchase(ctx, item.productId)
        const supplier = item.supplierId ?? last?.supplierId, cost = item.unitCost ? fixed(item.unitCost, 2) : last?.cost
        if (!supplier || cost === undefined) throw new Problem(422, "invalid_input", "Informe fornecedor e custo: o produto ainda não foi comprado")
        const quantity = fixed(item.quantity, 6)
        if (quantity <= 0n) invalid("Informe uma quantidade positiva")
        groups.set(supplier, [...(groups.get(supplier) ?? []), { productId: item.productId, quantity, cost }])
      }
      const created: { id: string; supplierId: string; amount: string }[] = []
      for (const [supplierId, lines] of groups) {
        const supplier = (await ctx.client.query<{ legal_name: string; tax_id: string }>("SELECT legal_name,tax_id FROM parties WHERE tenant_id=$1 AND id=$2 AND is_supplier AND status='active'", [ctx.tenantId, supplierId])).rows[0]
        if (!supplier) throw new Problem(409, "domain_conflict", "Selecione um fornecedor ativo desta empresa")
        const products = (await ctx.client.query<{ id: string; sku: string; name: string; unit: string }>("SELECT id,sku,name,unit FROM products WHERE tenant_id=$1 AND status='active' AND id=ANY($2::uuid[])", [ctx.tenantId, lines.map(l => l.productId)])).rows
        if (products.length !== lines.length) throw new Problem(409, "domain_conflict", "O produto precisa estar ativo")
        const amounts = lines.map(l => (l.quantity * l.cost + 500000n) / 1000000n), total = amounts.reduce((a, b) => a + b, 0n)
        if (total <= 0n || total > 99999999999999n) invalid("O pedido exige valor total positivo dentro do limite")
        const id = randomUUID()
        await ctx.client.query("INSERT INTO purchase_orders(tenant_id,id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,revision,status) VALUES($1,$2,$3,$4,$5,$6,$7,1,'draft')", [ctx.tenantId, id, supplierId, supplier.legal_name, supplier.tax_id, input.dueDate, total])
        for (const [index, l] of lines.entries()) {
          const p = products.find(x => x.id === l.productId)!
          await ctx.client.query("INSERT INTO purchase_order_lines(tenant_id,order_id,product_id,line_number,sku,name,unit,quantity_micros,cost_cents,amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [ctx.tenantId, id, l.productId, index + 1, p.sku, p.name, p.unit, l.quantity, l.cost, amounts[index]])
        }
        await record(ctx, req.headers, "purchase_order", id, "purchase.created", { amount: decimal(total, 2), revision: 1, origin: "replenishment_suggestion" })
        created.push({ id, supplierId, amount: decimal(total, 2) })
      }
      const result = { tenantId: ctx.tenantId, data: created }
      await remember(ctx, key, scope, input, result)
      return result
    })
    return reply.code(201).header("cache-control", "no-store").send(body)
  })
}
