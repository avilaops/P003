import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision } from "../../platform/revision.js"

const read = "logistics.shipments.read"
const manage = "logistics.shipments.manage"
const url = "/api/v1/logistics/shipments"
const order = ["to_separate", "separated", "checked", "shipped", "delivered"] as const
const text = (min: number, max: number) => z.string().trim().min(min).max(max).regex(/^[^\u0000-\u001f\u007f]*$/)
const createInput = z.strictObject({ orderId: z.guid() })
const statusInput = z.strictObject({
  status: z.enum(order),
  carrierName: text(2, 120).optional(), vehiclePlate: text(4, 12).optional(),
  driverName: text(2, 120).optional(), trackingCode: text(4, 60).optional(),
})
const listQuery = z.strictObject({ orderId: z.guid().optional(), status: z.enum(order).optional(), limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(1000000).default(0) })
const invalid = (message: string): never => { throw new Problem(422, "invalid_input", message) }
const conflict = (message: string): never => { throw new Problem(409, "domain_conflict", message) }
function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  return result.success ? result.data : invalid("Dados de expedição inválidos")
}
const caps = (ctx: AuthorizedContext) => ({ tenantId: ctx.tenantId, canEdit: ctx.permissions.includes(manage) })

// Detalhe do pedido expedido: romaneio, volumes, transportadora e data de entrega.
type ShipmentRow = { id: string; orderId: string; checkoutId: string | null; status: typeof order[number]; carrierName: string | null; vehiclePlate: string | null; driverName: string | null; manifestNumber: string | null; shippedAt: unknown; revision: string | number }
async function load(ctx: AuthorizedContext, id: string) {
  const row = (await ctx.client.query<ShipmentRow>(`SELECT s.id,s.order_id AS "orderId",o.number::text AS "orderNumber",o.customer_name AS "customerName",s.checkout_id AS "checkoutId",s.status,
      s.carrier_name AS "carrierName",s.vehicle_plate AS "vehiclePlate",s.driver_name AS "driverName",s.tracking_code AS "trackingCode",
      s.manifest_number AS "manifestNumber",s.shipped_at AS "shippedAt",s.delivered_at AS "deliveredAt",s.revision,s.created_at AS "createdAt",s.updated_at AS "updatedAt"
    FROM logistics_shipments s JOIN sales_orders o ON o.tenant_id=s.tenant_id AND o.id=s.order_id WHERE s.tenant_id=$1 AND s.id=$2`, [ctx.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Expedição não encontrada")
  const packages = row.checkoutId ? (await ctx.client.query(`SELECT id,package_number AS "packageNumber",weight_grams AS "weightGrams",length_mm AS "lengthMm",width_mm AS "widthMm",height_mm AS "heightMm",label_code AS "labelCode",status
    FROM logistics_checkout_packages WHERE tenant_id=$1 AND checkout_id=$2 ORDER BY package_number`, [ctx.tenantId, row.checkoutId])).rows : []
  const events = (await ctx.client.query(`SELECT id,status,details,created_at AS "createdAt" FROM logistics_shipment_events WHERE tenant_id=$1 AND shipment_id=$2 ORDER BY created_at,id`, [ctx.tenantId, id])).rows
  const totalWeightGrams = packages.reduce((sum, p) => sum + BigInt(String(p.weightGrams)), 0n)
  return { ...row, packages, events, manifest: row.manifestNumber ? { number: row.manifestNumber, carrierName: row.carrierName, vehiclePlate: row.vehiclePlate, driverName: row.driverName, packageCount: packages.length, totalWeightGrams, shippedAt: row.shippedAt } : null }
}

async function addEvent(ctx: AuthorizedContext, id: string, status: string, details: unknown) {
  await ctx.client.query("INSERT INTO logistics_shipment_events(id,tenant_id,shipment_id,status,details) VALUES($1,$2,$3,$4,$5)", [randomUUID(), ctx.tenantId, id, status, details])
}

export function registerLogisticsShipments(app: FastifyInstance, deps: AccessDependencies) {
  app.get(url, async (request, reply) => {
    const result = await authorizeRequest(request, deps, async ctx => {
      requirePermission(ctx, read)
      const f = parse(listQuery, request.query)
      const rows = await ctx.client.query(`SELECT count(*) OVER()::int AS total,s.id,s.order_id AS "orderId",o.number::text AS "orderNumber",s.status,s.carrier_name AS "carrierName",s.manifest_number AS "manifestNumber",s.delivered_at AS "deliveredAt",s.revision,s.updated_at AS "updatedAt"
        FROM logistics_shipments s JOIN sales_orders o ON o.tenant_id=s.tenant_id AND o.id=s.order_id
        WHERE s.tenant_id=$1 AND ($2::uuid IS NULL OR s.order_id=$2) AND ($3::text IS NULL OR s.status=$3)
        ORDER BY s.updated_at DESC,s.id DESC LIMIT $4 OFFSET $5`, [ctx.tenantId, f.orderId ?? null, f.status ?? null, f.limit, f.offset])
      return { ...caps(ctx), data: rows.rows.map(({ total: _t, ...r }) => r), total: rows.rows[0]?.total ?? 0, limit: f.limit, offset: f.offset }
    })
    return reply.header("cache-control", "no-store").send(result)
  })

  app.get<{ Params: { id: string } }>(url + "/:id", async (request, reply) => {
    const result = await authorizeRequest(request, deps, async ctx => {
      requirePermission(ctx, read)
      return { ...caps(ctx), data: await load(ctx, parse(z.guid(), request.params.id)) }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${result.data.revision}"`).send(result)
  })

  app.post(url, async (request, reply) => {
    const result = await authorizeRequest(request, deps, async ctx => {
      requirePermission(ctx, read); requirePermission(ctx, manage)
      const input = parse(createInput, request.body)
      const key = commandKey(request.headers["idempotency-key"])
      const scope = "logistics.shipment.created", intent = { input }
      const previous = await replay(ctx, key, scope, intent)
      if (previous) return { value: previous, status: 200, replayed: true }
      const orderRow = (await ctx.client.query<{ status: string }>("SELECT status FROM sales_orders WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, input.orderId])).rows[0]
      if (!orderRow) throw new Problem(404, "not_found", "Pedido não encontrado")
      if (!["confirmed", "completed"].includes(orderRow.status)) conflict("Só pedidos confirmados podem ser expedidos")
      if ((await ctx.client.query("SELECT 1 FROM logistics_shipments WHERE tenant_id=$1 AND order_id=$2", [ctx.tenantId, input.orderId])).rows[0]) conflict("O pedido já possui expedição")
      const checkout = (await ctx.client.query<{ id: string }>("SELECT id FROM logistics_checkouts WHERE tenant_id=$1 AND order_id=$2", [ctx.tenantId, input.orderId])).rows[0]
      const id = randomUUID()
      await ctx.client.query("INSERT INTO logistics_shipments(id,tenant_id,order_id,checkout_id) VALUES($1,$2,$3,$4)", [id, ctx.tenantId, input.orderId, checkout?.id ?? null])
      await addEvent(ctx, id, "to_separate", {})
      const value = { ...caps(ctx), data: await load(ctx, id) }
      await record(ctx, request.headers, "logistics_shipment", id, scope, { tenantId: ctx.tenantId, data: { id, orderId: input.orderId } })
      await remember(ctx, key, scope, intent, value)
      return { value, status: 201 }
    })
    if (result.replayed) reply.header("idempotency-replayed", "true")
    return reply.code(result.status).header("cache-control", "no-store").header("etag", `"${(result.value as { data: { revision: unknown } }).data.revision}"`).send(result.value)
  })

  app.post<{ Params: { id: string } }>(url + "/:id/status", async (request, reply) => {
    const result = await authorizeRequest(request, deps, async ctx => {
      requirePermission(ctx, read); requirePermission(ctx, manage)
      const id = parse(z.guid(), request.params.id)
      const expected = parseRevision(request.headers["if-match"])
      const input = parse(statusInput, request.body)
      const key = commandKey(request.headers["idempotency-key"])
      const scope = "logistics.shipment.status", intent = { id, revision: expected, input }
      const previous = await replay(ctx, key, scope, intent)
      if (previous) return { value: previous, status: 200, replayed: true }
      const s = (await ctx.client.query<Record<string, any>>("SELECT * FROM logistics_shipments WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [ctx.tenantId, id])).rows[0]
      if (!s) throw new Problem(404, "not_found", "Expedição não encontrada")
      if (String(s.revision) !== String(expected)) throw new Problem(412, "revision_conflict", "A expedição foi alterada. Atualize antes de confirmar.")
      if (order.indexOf(input.status) !== order.indexOf(s.status) + 1) conflict("A situação deve avançar uma etapa por vez")
      const carrierName = input.carrierName ?? s.carrier_name
      if (input.status === "checked") {
        const done = s.checkout_id && (await ctx.client.query("SELECT 1 FROM logistics_checkouts WHERE tenant_id=$1 AND id=$2 AND status='completed'", [ctx.tenantId, s.checkout_id])).rows[0]
        if (!done) conflict("Conclua a conferência do checkout antes de marcar como conferido")
      }
      let manifest: string | null = s.manifest_number
      if (input.status === "shipped") {
        if (!carrierName) invalid("Informe a transportadora para expedir")
        const count = (await ctx.client.query<{ n: number }>("SELECT count(*)::int AS n FROM logistics_checkout_packages WHERE tenant_id=$1 AND checkout_id=$2", [ctx.tenantId, s.checkout_id])).rows[0]!.n
        if (!count) conflict("Cadastre ao menos um volume antes de expedir")
        await ctx.client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["romaneio:" + ctx.tenantId])
        const n = (await ctx.client.query<{ n: number }>("SELECT count(manifest_number)::int + 1 AS n FROM logistics_shipments WHERE tenant_id=$1", [ctx.tenantId])).rows[0]!.n
        manifest = "ROM-" + String(n).padStart(6, "0")
      }
      const updated = (await ctx.client.query<{ order_id: string }>(`UPDATE logistics_shipments SET status=$3,revision=revision+1,updated_at=now(),
          carrier_name=$4,vehicle_plate=COALESCE($5,vehicle_plate),driver_name=COALESCE($6,driver_name),tracking_code=COALESCE($7,tracking_code),manifest_number=$8,
          shipped_at=CASE WHEN $3='shipped' THEN now() ELSE shipped_at END,delivered_at=CASE WHEN $3='delivered' THEN now() ELSE delivered_at END
        WHERE tenant_id=$1 AND id=$2 RETURNING order_id`, [ctx.tenantId, id, input.status, carrierName ?? null, input.vehiclePlate ?? null, input.driverName ?? null, input.trackingCode ?? null, manifest])).rows[0]!
      await addEvent(ctx, id, input.status, { carrierName: carrierName ?? null, manifestNumber: manifest })
      const value = { ...caps(ctx), data: await load(ctx, id) }
      // A entrega confirmada é publicada para Vendas (V4) e Garantia iniciarem seus fluxos.
      await record(ctx, request.headers, "logistics_shipment", id, input.status === "delivered" ? "logistics.shipment.delivered" : scope, { tenantId: ctx.tenantId, data: { id, orderId: updated.order_id, status: input.status } })
      await remember(ctx, key, scope, intent, value)
      return { value, status: 200 }
    })
    if (result.replayed) reply.header("idempotency-replayed", "true")
    return reply.header("cache-control", "no-store").header("etag", `"${(result.value as { data: { revision: unknown } }).data.revision}"`).send(result.value)
  })
}
