import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { canonicalJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { orderInputSchema } from "../orders/schema.js"
import { prepareOrder, storeLines } from "../orders/prepare.js"
import { policySchema, publishedCostSchema, quote, quoteInputSchema, type QuoteInput } from "./model.js"

const calculator = "commercial-quote-v1-unit-cents"
const uuid = z.guid().transform(value => value.toLowerCase())
const createSchema = z.strictObject({
  quote: quoteInputSchema, digest: z.string(), customerId: uuid, dueDate: z.string(),
  structureColor: z.string().nullable().optional(), swingArmColor: z.string().nullable().optional(), plateHolderColor: z.string().nullable().optional(), plateHolderType: z.string().nullable().optional(), upholsteryColor: z.string().nullable().optional(),
})

function line(code: string) {
  if (code !== "imported" && code !== "national") throw new Problem(422, "invalid_input", "Linha comercial inválida")
  return code
}
const sellsCosts = (context: AuthorizedContext) => context.permissions.includes("platform.company.manage") && context.permissions.includes("sales.approvals.director")

// Only a published table version that still matches the active product can be quoted.
async function prepare(context: AuthorizedContext, code: string, input: QuoteInput) {
  const row = (await context.client.query<Record<string, unknown>>("SELECT v.version,v.policy_snapshot,i.product_snapshot,i.cost_snapshot,i.price_without_ipi_cents FROM price_table_versions v JOIN price_table_items i ON i.tenant_id=v.tenant_id AND i.version_id=v.id JOIN products p ON p.tenant_id=i.tenant_id AND p.id=i.product_id WHERE v.tenant_id=$1 AND v.id=$2 AND v.product_line=$3 AND i.product_id=$4 AND p.status='active' AND p.unit=i.product_snapshot->>'unit'", [context.tenantId, input.versionId, code, input.productId])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
  const policy = policySchema.safeParse(row.policy_snapshot), cost = publishedCostSchema.safeParse(row.cost_snapshot)
  if (!policy.success) throw new Problem(409, "domain_conflict", "Política publicada incompatível")
  if (!cost.success) throw new Problem(409, "domain_conflict", "Custo publicado incompatível")
  const result = quote(input, BigInt(String(row.price_without_ipi_cents)), cost.data, policy.data)
  const digest = createHash("sha256").update(canonicalJson({ tenantId: context.tenantId, line: code, input, calculator, sale: result.sale, director: result.director })).digest("hex")
  return { line: code, ...result, digest, product: row.product_snapshot, version: Number(row.version) }
}
type Prepared = Awaited<ReturnType<typeof prepare>>
// Cost data never enters a seller response.
function redact(prepared: Prepared, input: QuoteInput, director: boolean, tenantId: string) {
  return { tenantId, line: prepared.line, versionId: input.versionId, version: prepared.version, product: prepared.product, input, digest: prepared.digest, sale: prepared.sale, ...(director ? { director: prepared.director } : {}) }
}

export function registerSalesSimulator(app: FastifyInstance, dependencies: AppDependencies) {
  const base = "/api/v1/sales-simulator/:line"
  app.get<{ Params: { line: string } }>(base, async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read")
      const code = line(request.params.line), query = z.strictObject({ versionId: uuid.optional() }).safeParse(request.query)
      if (!query.success) throw new Problem(422, "invalid_input", "Versão inválida")
      const { client, tenantId } = context
      const versions = (await client.query("SELECT jsonb_build_object('id',id,'version',version,'publishedAt',published_at) AS data FROM price_table_versions WHERE tenant_id=$1 AND product_line=$2 ORDER BY version DESC", [tenantId, code])).rows.map(row => row.data)
      const version = query.data.versionId ?? (await client.query("SELECT active_price_version_id FROM commercial_settings WHERE tenant_id=$1 AND product_line=$2", [tenantId, code])).rows[0]?.active_price_version_id ?? null
      let data = null
      if (version) {
        const meta = (await client.query("SELECT jsonb_build_object('id',id,'version',version,'publishedAt',published_at,'originState',policy_snapshot->>'originState','freeDiscountBps',policy_snapshot->'freeDiscountBps','minimumDownPaymentBps',policy_snapshot->'minimumDownPaymentBps','ipiBps',policy_snapshot->'ipiBps') AS data FROM price_table_versions WHERE tenant_id=$1 AND id=$2 AND product_line=$3", [tenantId, version, code])).rows[0]?.data
        if (!meta) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
        const items = (await client.query("SELECT jsonb_build_object('productId',i.product_id,'sku',i.product_snapshot->>'sku','name',i.product_snapshot->>'name','unit',i.product_snapshot->>'unit','priceWithoutIpiCents',i.price_without_ipi_cents,'priceWithIpiCents',i.price_with_ipi_cents,'structureColors',COALESCE(p.structure_colors,'{}'::text[]),'swingArmColors',COALESCE(p.swing_arm_colors,'{}'::text[]),'finishingPalette',p.finishing_palette,'upholsteryColors',COALESCE(p.upholstery_colors,'{}'::text[]),'upholsteryConfigurable',COALESCE((SELECT (data->>'upholsteryConfigurable')::boolean FROM registration_settings WHERE tenant_id=p.tenant_id AND section='products'),true)) AS data FROM price_table_items i JOIN products p ON p.tenant_id=i.tenant_id AND p.id=i.product_id WHERE i.tenant_id=$1 AND i.version_id=$2 AND p.status='active' AND p.unit=i.product_snapshot->>'unit' ORDER BY i.product_snapshot->>'sku',i.product_id", [tenantId, version])).rows.map(row => row.data)
        data = { ...meta, items }
      }
      return { tenantId, line: code, canCreate: context.permissions.includes("sales.orders.manage"), versions, data }
    }, false)
    return reply.header("cache-control", "no-store").send(body)
  })
  app.post<{ Params: { line: string } }>(base + "/quote", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read")
      const parsed = quoteInputSchema.safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Preencha as condições sem campos desconhecidos")
      const prepared = await prepare(context, line(request.params.line), parsed.data)
      return redact(prepared, parsed.data, sellsCosts(context), context.tenantId)
    }, false)
    return reply.header("cache-control", "no-store").send(body)
  })
  app.post<{ Params: { line: string } }>(base + "/orders", async (request, reply) => {
    const key = commandKey(request.headers["idempotency-key"])
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read"); requirePermission(context, "sales.orders.manage")
      const parsed = createSchema.safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Dados do pedido inválidos")
      const input = parsed.data, code = line(request.params.line), scope = "order.simulated"
      const command = { line: code, input }
      const repeated = await replay(context, key, scope, command)
      if (repeated) return repeated
      const prepared = await prepare(context, code, input.quote)
      if (prepared.digest !== input.digest) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      const order = await prepareOrder(context, orderInputSchema.parse({ customerId: input.customerId, dueDate: input.dueDate, items: [{ productId: input.quote.productId, quantity: `${input.quote.quantity}.000000`, structureColor: input.structureColor, swingArmColor: input.swingArmColor, plateHolderColor: input.plateHolderColor, plateHolderType: input.plateHolderType, upholsteryColor: input.upholsteryColor }] }), undefined, undefined, true)
      const sku = (prepared.product as Record<string, unknown> | null)?.sku, name = (prepared.product as Record<string, unknown> | null)?.name
      if (typeof sku !== "string") throw new Problem(409, "domain_conflict", "SKU publicado inválido")
      if (typeof name !== "string") throw new Problem(409, "domain_conflict", "Nome publicado inválido")
      // The published quote, not the catalog, prices the order.
      const total = BigInt(prepared.sale.invoiceTotalCents), first = order.lines[0]!
      Object.assign(first, { price: BigInt(prepared.sale.unitWithIpiCents), amount: total, sku, name, priceOrigin: undefined })
      const id = randomUUID()
      await context.client.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,$4,$5,$6,$7,'draft')", [id, context.tenantId, input.customerId, order.customerName, order.customerTaxId, order.due, total])
      await storeLines(context, id, order.lines)
      await context.client.query("INSERT INTO order_pricing_snapshots(tenant_id,order_id,version_id,snapshot,needs_approval) VALUES($1,$2,$3,$4,$5)", [context.tenantId, id, input.quote.versionId, redact(prepared, input.quote, true, context.tenantId), prepared.sale.needsApproval])
      await record(context, request.headers, "sales_order", id, "order.created", { revision: 1, source: "sales_simulator", versionId: input.quote.versionId, needsApproval: prepared.sale.needsApproval })
      const result = { tenantId: context.tenantId, id, revision: 1, status: "draft", needsApproval: prepared.sale.needsApproval }
      await remember(context, key, scope, command, result)
      return result
    })
    return reply.code(201).header("cache-control", "no-store").header("etag", '"1"').send(body)
  })
}
