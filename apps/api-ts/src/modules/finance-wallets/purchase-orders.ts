import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { queryInteger } from "../registrations/query.js"
import { decimal, fixed, validateDate } from "../sales/fixed.js"
import { pathId } from "./documents.js"
import { fiscalOrigin, purchaseOrder, purchaseSummary } from "./purchase-receipts.js"
import { conflict, currentRevision, invalid, missing } from "./snapshot.js"

const read = "purchasing.orders.read",
  manage = "purchasing.orders.manage",
  base = "/api/v1/purchase-orders"
const item = z.strictObject({
  productId: z.guid().transform(pathId),
  quantity: z.string().transform((n) => decimal(fixed(n, 6), 6)),
  unitCost: z.string().transform((n) => decimal(fixed(n, 2), 2)),
})
const input = z.strictObject({
  supplierId: z.guid().transform(pathId),
  dueDate: z.string().transform(validateDate),
  items: z.array(item).min(1).max(100),
})
const page = z.object({ limit: queryInteger(1, 100).default(25), offset: queryInteger(0, 100000).default(0) })
type Purchase = Awaited<ReturnType<typeof purchaseOrder>>
type Line = { id: string; name: string; sku: string; unit: string; quantity: bigint; cost: bigint; amount: bigint }
type PurchaseInput = z.infer<typeof input>

async function prepare(ctx: AuthorizedContext, draft: PurchaseInput, previous?: Purchase) {
  const supplier = (
    await ctx.client.query<{ legal_name: string; tax_id: string }>(
      "SELECT legal_name,tax_id FROM parties WHERE tenant_id=$1 AND id=$2 AND is_supplier AND status='active'",
      [ctx.tenantId, draft.supplierId],
    )
  ).rows[0]
  if (!supplier) conflict("Selecione um fornecedor ativo desta empresa")
  const ids = draft.items.map((row) => row.productId)
  if (new Set(ids).size !== ids.length) invalid("Agrupe a quantidade de cada produto")
  const products = (
    await ctx.client.query<{ id: string; name: string; sku: string; unit: string; status: string }>(
      "SELECT id,name,sku,unit,status FROM products WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
      [ctx.tenantId, ids],
    )
  ).rows
  const lines: Line[] = [],
    max = 99999999999999n
  let total = 0n
  for (const row of draft.items) {
    const product = products.find((p) => p.id === row.productId)
    if (!product) missing()
    if (product.status !== "active") conflict("O produto precisa estar ativo")
    if (previous?.items.some((old) => old.productId === product.id && old.unit !== product.unit))
      conflict("A unidade do produto mudou. Remova o item antes de substituí-lo")
    const quantity = fixed(row.quantity, 6),
      cost = fixed(row.unitCost, 2),
      amount = (quantity * cost + 500000n) / 1000000n
    if (!quantity) invalid("Informe uma quantidade positiva")
    total += amount
    if (total > max) invalid("Total fora do limite")
    lines.push({ ...product, quantity, cost, amount })
  }
  if (!total) invalid("O pedido exige valor total positivo")
  return { supplier, lines, total }
}

async function checkFiscalDraft(ctx: AuthorizedContext, id: string, supplierId: string, taxId: string, lines: Line[]) {
  const args = [ctx.tenantId, id],
    origin = (
      await ctx.client.query(
        "SELECT l.supplier_id,n.issuer_document FROM fiscal_received_purchase_links l JOIN fiscal_received_nfes n ON (n.tenant_id,n.id)=(l.tenant_id,l.received_nfe_id) WHERE l.tenant_id=$1 AND l.purchase_order_id=$2",
        args,
      )
    ).rows[0]
  if (!origin) return
  const fiscal = (
    await ctx.client.query(
      "SELECT product_id,unit,quantity_micros,unit_cost_cents,landed_cents FROM fiscal_received_item_costs WHERE tenant_id=$1 AND purchase_order_id=$2",
      args,
    )
  ).rows
  if (
    origin.supplier_id !== supplierId ||
    origin.issuer_document !== taxId ||
    fiscal.length !== lines.length ||
    lines.some(
      (line) =>
        !fiscal.some(
          (src) =>
            src.product_id === line.id &&
            src.unit === line.unit &&
            BigInt(String(src.quantity_micros)) === line.quantity &&
            BigInt(String(src.unit_cost_cents)) === line.cost &&
            BigInt(String(src.landed_cents)) === line.amount,
        ),
    )
  )
    conflict(
      "A compra vinculada ao XML exige a preservação do fornecedor, produtos, unidades, quantidades e custos fiscais",
    )
}

async function verifyConfirmation(ctx: AuthorizedContext, id: string) {
  await fiscalOrigin(ctx, id)
  const row = (
    await ctx.client.query(
      `SELECT p.is_supplier AND p.status='active' AS active,
    s.minimum_order_amount_cents>o.amount_cents AS below_minimum,
    o.due_date>(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date+s.maximum_payment_term_days::int AS exceeds_term,
    s.require_supplier_contact AND nullif(btrim(p.email),'') IS NULL AND nullif(btrim(p.phone),'') IS NULL AS contact_missing,
    EXISTS(SELECT 1 FROM purchase_order_lines l JOIN products pr ON (pr.tenant_id,pr.id)=(l.tenant_id,l.product_id) WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id AND (pr.status<>'active' OR pr.unit<>l.unit)) AS product_invalid
    FROM purchase_orders o JOIN parties p ON (p.tenant_id,p.id)=(o.tenant_id,o.supplier_id) LEFT JOIN purchase_settings s ON s.tenant_id=o.tenant_id WHERE o.tenant_id=$1 AND o.id=$2`,
      [ctx.tenantId, id],
    )
  ).rows[0]!
  if (!row.active) conflict("O fornecedor deve estar ativo para confirmar")
  if (row.below_minimum) conflict("Pedido abaixo do valor mínimo configurado nas preferências de compras")
  if (row.exceeds_term) conflict("O vencimento excede o prazo máximo configurado para compras")
  if (row.contact_missing) conflict("Informe o e-mail ou o telefone do fornecedor para confirmar")
  if (row.product_invalid) conflict("O produto deve estar ativo e conservar a unidade do pedido")
}

export function registerPurchaseOrders(app: FastifyInstance, deps: AppDependencies) {
  app.get(base, async (req, reply) => {
    const body = await authorizeRequest(req, deps, async (ctx) => {
      requirePermission(ctx, read)
      const q = page.safeParse(req.query)
      if (!q.success) invalid("Paginação inválida")
      const { limit, offset } = q.data
      const data = (
        await ctx.client.query(
          purchaseSummary + " WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3",
          [ctx.tenantId, limit, offset],
        )
      ).rows.map((row) => ({ ...row, revision: revisionValue(row.revision) }))
      const total = Number(
        (await ctx.client.query("SELECT count(*) AS total FROM purchase_orders WHERE tenant_id=$1", [ctx.tenantId]))
          .rows[0]!.total,
      )
      return { tenantId: ctx.tenantId, canEdit: ctx.permissions.includes(manage), data, total, offset, limit }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  app.get<{ Params: { id: string } }>(base + "/:id", async (req, reply) => {
    const body = await authorizeRequest(req, deps, (ctx) => {
      requirePermission(ctx, read)
      return purchaseOrder(ctx, pathId(req.params.id))
    })
    return reply
      .header("cache-control", "no-store")
      .header("etag", '"' + body.data.revision + '"')
      .send(body)
  })
  for (const method of ["POST", "PUT"] as const)
    app.route<{ Params: { id?: string } }>({
      method,
      url: method === "POST" ? base : base + "/:id",
      handler: async (req, reply) => {
        const creating = method === "POST",
          expected = creating ? 1 : parseRevision(req.headers["if-match"]),
          scope = creating ? "purchase.create" : "purchase.update"
        const key = creating || req.headers["idempotency-key"] ? commandKey(req.headers["idempotency-key"]) : null
        const body = await authorizeRequest(req, deps, async (ctx) => {
          requirePermission(ctx, read)
          requirePermission(ctx, manage)
          const parsed = input.safeParse(req.body)
          if (!parsed.success) invalid("Informe o fornecedor, vencimento e de um a cem produtos")
          const draft = parsed.data,
            id = creating ? randomUUID() : pathId(req.params.id!),
            intent = creating ? draft : { id, revision: expected, input: draft }
          if (key) {
            const saved = await replay(ctx, key, scope, intent)
            if (saved) return saved
          }
          const old = creating ? undefined : await purchaseOrder(ctx, id)
          if (old) {
            currentRevision(old.data.revision, expected)
            if (old.data.status !== "draft") conflict("Somente o rascunho pode ser editado")
          }
          const { supplier, lines, total } = await prepare(ctx, draft, old),
            revision = creating ? 1 : nextRevision(expected)
          const args = [
            ctx.tenantId,
            id,
            draft.supplierId,
            supplier.legal_name,
            supplier.tax_id,
            draft.dueDate,
            total,
            revision,
          ]
          if (creating)
            await ctx.client.query(
              "INSERT INTO purchase_orders(tenant_id,id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,revision,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'draft')",
              args,
            )
          else {
            await checkFiscalDraft(ctx, id, draft.supplierId, supplier.tax_id, lines)
            await ctx.client.query("DELETE FROM purchase_order_lines WHERE tenant_id=$1 AND order_id=$2", [
              ctx.tenantId,
              id,
            ])
            await ctx.client.query(
              "UPDATE purchase_orders SET supplier_id=$3,supplier_name=$4,supplier_tax_id=$5,due_date=$6,amount_cents=$7,revision=$8,updated_at=now() WHERE tenant_id=$1 AND id=$2",
              args,
            )
          }
          for (const [index, l] of lines.entries())
            await ctx.client.query(
              "INSERT INTO purchase_order_lines(tenant_id,order_id,product_id,line_number,sku,name,unit,quantity_micros,cost_cents,amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
              [ctx.tenantId, id, l.id, index + 1, l.sku, l.name, l.unit, l.quantity, l.cost, l.amount],
            )
          await record(
            ctx,
            req.headers,
            "purchase_order",
            id,
            creating ? "purchase.created" : "purchase.updated",
            creating ? { amount: decimal(total, 2), revision } : { previousRevision: expected, revision },
          )
          const result = await purchaseOrder(ctx, id)
          if (key) await remember(ctx, key, scope, intent, result)
          return result
        })
        return reply
          .code(creating ? 201 : 200)
          .header("cache-control", "no-store")
          .header("etag", '"' + (body.data as { revision: unknown }).revision + '"')
          .send(body)
      },
    })
  const statuses = { confirm: "confirmed", cancel: "cancelled", close: "closed" } as const
  for (const action of ["confirm", "cancel", "close"] as const)
    app.post<{ Params: { id: string } }>(base + "/:id/" + action, async (req, reply) => {
      const key = commandKey(req.headers["idempotency-key"]),
        expected = parseRevision(req.headers["if-match"]),
        scope = "purchase." + action
      const body = await authorizeRequest(req, deps, async (ctx) => {
        requirePermission(ctx, read)
        requirePermission(ctx, manage)
        const input = z.strictObject({ reason: z.string().nullish() }).safeParse(req.body ?? {})
        if (!input.success) invalid("Comando de compra inválido")
        const reason = action === "confirm" ? null : (input.data.reason ?? "").trim()
        if (reason !== null && (reason.length < 3 || reason.length > 200 || /\p{Cc}/u.test(reason)))
          invalid("Informe uma justificativa de 3 a 200 caracteres")
        const id = pathId(req.params.id),
          intent = { id, revision: expected, reason },
          saved = await replay(ctx, key, scope, intent)
        if (saved) return saved
        const old = await purchaseOrder(ctx, id)
        currentRevision(old.data.revision, expected)
        const previousStatus = old.data.status,
          status = statuses[action]
        if (
          (action === "confirm" && previousStatus !== "draft") ||
          (action === "cancel" && (!["draft", "confirmed"].includes(previousStatus) || old.receiptCount > 0)) ||
          (action === "close" && previousStatus !== "partially_received")
        )
          conflict("Transição não permitida na situação atual do pedido")
        if (action === "confirm") await verifyConfirmation(ctx, id)
        const revision = nextRevision(expected)
        await ctx.client.query(
          "UPDATE purchase_orders SET status=$3,revision=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, id, status, revision],
        )
        await record(ctx, req.headers, "purchase_order", id, "purchase." + status, {
          previousRevision: expected,
          revision,
          previousStatus,
          status,
          reason,
        })
        const result = await purchaseOrder(ctx, id)
        await remember(ctx, key, scope, intent, result)
        return result
      })
      return reply
        .header("cache-control", "no-store")
        .header("etag", '"' + (body.data as { revision: unknown }).revision + '"')
        .send(body)
    })
}
