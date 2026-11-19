import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision } from "../../platform/revision.js"
import { unconfiguredFreightProvider, type FreightProvider, type FreightQuoteInput } from "./provider.js"

export type FreightDependencies = { freight?: FreightProvider }

const read = "logistics.freight.read"
const manage = "logistics.freight.manage"
const base = "/api/v1/logistics/freight"
const statuses = ["contracted", "labeled", "in_transit", "delivered", "cancelled"] as const
// Só expedições separadas ou conferidas (volumes conhecidos, ainda não expedidas) podem ser cotadas e contratadas.
const quotable = ["separated", "checked"]

const quoteInput = z.strictObject({ shipmentId: z.guid() })
const contractInput = z.strictObject({ shipmentId: z.guid(), serviceCode: z.string().trim().min(1).max(60).regex(/^[\w.-]+$/) })
const listQuery = z.strictObject({
  shipmentId: z.guid().optional(), status: z.enum(statuses).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(1000000).default(0),
})
const invalid = (message: string): never => { throw new Problem(422, "invalid_input", message) }
const conflict = (message: string): never => { throw new Problem(409, "domain_conflict", message) }
function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  return result.success ? result.data : invalid("Dados de envio inválidos")
}
const caps = (ctx: AuthorizedContext) => ({ tenantId: ctx.tenantId, canEdit: ctx.permissions.includes(manage) })
const postal = (value: unknown) => typeof value === "string" && /^\d{8}$/.test(value.replace(/\D/g, "")) ? value.replace(/\D/g, "") : null

/** Peso e destino vêm da expedição (volumes do checkout), do cliente do pedido e do cadastro da empresa. */
async function quoteSource(ctx: AuthorizedContext, shipmentId: string) {
  const s = (await ctx.client.query<{ status: string; checkout_id: string | null; amount_cents: string; customer_name: string; addresses: unknown; origin: unknown }>(`
    SELECT s.status,s.checkout_id,o.amount_cents,o.customer_name,p.addresses,c.details->>'postalCode' AS origin
    FROM logistics_shipments s JOIN sales_orders o ON o.tenant_id=s.tenant_id AND o.id=s.order_id
    LEFT JOIN parties p ON p.tenant_id=o.tenant_id AND p.id=o.customer_id
    LEFT JOIN company_profiles c ON c.tenant_id=s.tenant_id
    WHERE s.tenant_id=$1 AND s.id=$2`, [ctx.tenantId, shipmentId])).rows[0]
  if (!s) throw new Problem(404, "not_found", "Expedição não encontrada")
  if (!quotable.includes(s.status)) conflict("Cote e contrate o frete com a expedição separada ou conferida, antes de expedir")
  const packages = s.checkout_id ? (await ctx.client.query<{ weightGrams: number; lengthMm: number; widthMm: number; heightMm: number }>(`
    SELECT weight_grams::int AS "weightGrams",length_mm::int AS "lengthMm",width_mm::int AS "widthMm",height_mm::int AS "heightMm"
    FROM logistics_checkout_packages WHERE tenant_id=$1 AND checkout_id=$2 ORDER BY package_number`, [ctx.tenantId, s.checkout_id])).rows : []
  if (!packages.length) conflict("Cadastre os volumes no checkout antes de cotar o frete")
  const addresses = Array.isArray(s.addresses) ? s.addresses as Record<string, unknown>[] : []
  const address = addresses.find(a => a.primary === true) ?? (addresses.length === 1 ? addresses[0] : undefined)
  const destination = postal(address?.postalCode), origin = postal(s.origin)
  if (!origin) conflict("Informe o CEP da empresa no cadastro da empresa para cotar o frete")
  if (!destination) conflict("Informe o CEP do endereço principal do cliente para cotar o frete")
  const input: FreightQuoteInput = {
    origin: { postalCode: origin! },
    destination: { postalCode: destination!, ...(typeof address?.state === "string" ? { state: address.state } : {}), ...(typeof address?.city === "string" ? { city: address.city } : {}) },
    packages, declaredValueCents: Number(s.amount_cents),
  }
  return { input, recipientName: s.customer_name }
}

type ContractRow = { id: string; shipmentId: string; status: typeof statuses[number]; revision: string | number }
async function load(ctx: AuthorizedContext, id: string) {
  const row = (await ctx.client.query<ContractRow>(`SELECT f.id,f.shipment_id AS "shipmentId",s.order_id AS "orderId",o.number::text AS "orderNumber",o.customer_name AS "customerName",
      f.provider,f.service_code AS "serviceCode",f.service_name AS "serviceName",f.carrier_name AS "carrierName",f.price_cents::int AS "priceCents",f.delivery_days AS "deliveryDays",
      f.tracking_code AS "trackingCode",f.status,f.quote_snapshot AS "quote",f.label_format AS "labelFormat",f.label_code AS "labelCode",f.labeled_at AS "labeledAt",
      f.cancelled_at AS "cancelledAt",f.revision::int AS revision,f.created_at AS "createdAt",f.updated_at AS "updatedAt"
    FROM logistics_freight_contracts f JOIN logistics_shipments s ON s.tenant_id=f.tenant_id AND s.id=f.shipment_id
    JOIN sales_orders o ON o.tenant_id=s.tenant_id AND o.id=s.order_id WHERE f.tenant_id=$1 AND f.id=$2`, [ctx.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Envio não encontrado")
  const events = (await ctx.client.query(`SELECT id,provider_event_id AS "providerEventId",occurred_at AS "occurredAt",status,description,location
    FROM logistics_freight_events WHERE tenant_id=$1 AND contract_id=$2 ORDER BY occurred_at,id`, [ctx.tenantId, id])).rows
  return { ...row, events }
}

async function lockContract(ctx: AuthorizedContext, id: string, expected: unknown) {
  const row = (await ctx.client.query<{ status: string; revision: string; provider: string; provider_reference: string; shipment_id: string }>(
    "SELECT status,revision,provider,provider_reference,shipment_id FROM logistics_freight_contracts WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [ctx.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Envio não encontrado")
  if (String(row.revision) !== String(expected)) throw new Problem(412, "revision_conflict", "O envio foi alterado. Atualize antes de confirmar.")
  if (row.status === "cancelled") conflict("O envio está cancelado")
  return row
}

async function shipmentEvent(ctx: AuthorizedContext, shipmentId: string, status: string, details: unknown) {
  await ctx.client.query("INSERT INTO logistics_shipment_events(id,tenant_id,shipment_id,status,details) VALUES($1,$2,$3,$4,$5)", [randomUUID(), ctx.tenantId, shipmentId, status, details])
}

export function registerLogisticsFreight(app: FastifyInstance, deps: AccessDependencies & FreightDependencies) {
  const provider = deps.freight ?? unconfiguredFreightProvider
  const withEtag = (value: { data: { revision: unknown } }) => `"${value.data.revision}"`

  // Comando com If-Match + Idempotency-Key sobre uma contratação existente.
  const command = (path: string, scope: string, run: (ctx: AuthorizedContext, id: string, row: Awaited<ReturnType<typeof lockContract>>) => Promise<string>) =>
    app.post<{ Params: { id: string } }>(`${base}/contracts/:id/${path}`, async (request, reply) => {
      const result = await authorizeRequest(request, deps, async ctx => {
        requirePermission(ctx, read); requirePermission(ctx, manage)
        const id = parse(z.guid(), request.params.id)
        const expected = parseRevision(request.headers["if-match"])
        if (request.body !== undefined && request.body !== null && (typeof request.body !== "object" || Object.keys(request.body).length)) invalid("Esta operação não recebe dados")
        const key = commandKey(request.headers["idempotency-key"])
        const intent = { id, revision: expected }
        const previous = await replay(ctx, key, scope, intent)
        if (previous) return { value: previous as { data: { revision: unknown } }, replayed: true }
        const row = await lockContract(ctx, id, expected)
        const event = await run(ctx, id, row)
        const value = { ...caps(ctx), data: await load(ctx, id) }
        await record(ctx, request.headers, "logistics_freight_contract", id, event, { tenantId: ctx.tenantId, data: { id, shipmentId: row.shipment_id, status: value.data.status } })
        await remember(ctx, key, scope, intent, value)
        return { value, replayed: false }
      })
      if (result.replayed) reply.header("idempotency-replayed", "true")
      return reply.header("cache-control", "no-store").header("etag", withEtag(result.value)).send(result.value)
    })

  app.post(`${base}/quotes`, async (request, reply) => {
    const result = await authorizeRequest(request, deps, async ctx => {
      requirePermission(ctx, read); requirePermission(ctx, manage)
      const { shipmentId } = parse(quoteInput, request.body)
      const { input } = await quoteSource(ctx, shipmentId)
      const options = (await provider.quote(input)).sort((a, b) => a.priceCents - b.priceCents || a.deliveryDays - b.deliveryDays)
      const weightGrams = input.packages.reduce((sum, p) => sum + p.weightGrams, 0)
      return { ...caps(ctx), data: { shipmentId, provider: provider.code, origin: input.origin, destination: input.destination, packageCount: input.packages.length, weightGrams, declaredValueCents: input.declaredValueCents, options } }
    })
    return reply.header("cache-control", "no-store").send(result)
  })

  app.get(`${base}/contracts`, async (request, reply) => {
    const result = await authorizeRequest(request, deps, async ctx => {
      requirePermission(ctx, read)
      const f = parse(listQuery, request.query)
      const rows = await ctx.client.query(`SELECT count(*) OVER()::int AS total,f.id,f.shipment_id AS "shipmentId",s.order_id AS "orderId",o.number::text AS "orderNumber",o.customer_name AS "customerName",
          f.carrier_name AS "carrierName",f.service_name AS "serviceName",f.price_cents::int AS "priceCents",f.delivery_days AS "deliveryDays",f.tracking_code AS "trackingCode",
          f.status,f.label_code AS "labelCode",f.revision::int AS revision,f.updated_at AS "updatedAt"
        FROM logistics_freight_contracts f JOIN logistics_shipments s ON s.tenant_id=f.tenant_id AND s.id=f.shipment_id
        JOIN sales_orders o ON o.tenant_id=s.tenant_id AND o.id=s.order_id
        WHERE f.tenant_id=$1 AND ($2::uuid IS NULL OR f.shipment_id=$2) AND ($3::text IS NULL OR f.status=$3)
        ORDER BY f.updated_at DESC,f.id DESC LIMIT $4 OFFSET $5`, [ctx.tenantId, f.shipmentId ?? null, f.status ?? null, f.limit, f.offset])
      return { ...caps(ctx), data: rows.rows.map(({ total: _t, ...r }) => r), total: rows.rows[0]?.total ?? 0, limit: f.limit, offset: f.offset }
    })
    return reply.header("cache-control", "no-store").send(result)
  })

  app.get<{ Params: { id: string } }>(`${base}/contracts/:id`, async (request, reply) => {
    const result = await authorizeRequest(request, deps, async ctx => {
      requirePermission(ctx, read)
      return { ...caps(ctx), data: await load(ctx, parse(z.guid(), request.params.id)) }
    })
    return reply.header("cache-control", "no-store").header("etag", withEtag(result)).send(result)
  })

  app.get<{ Params: { id: string } }>(`${base}/contracts/:id/label`, async (request, reply) => {
    const label = await authorizeRequest(request, deps, async ctx => {
      requirePermission(ctx, read)
      const row = (await ctx.client.query<{ label_format: "pdf" | "zpl" | null; label_code: string | null; label_content: Buffer | null }>(
        "SELECT label_format,label_code,label_content FROM logistics_freight_contracts WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, parse(z.guid(), request.params.id)])).rows[0]
      if (!row) throw new Problem(404, "not_found", "Envio não encontrado")
      if (!row.label_content || !row.label_format) throw new Problem(404, "not_found", "A etiqueta deste envio ainda não foi gerada")
      return row
    })
    const pdf = label.label_format === "pdf", name = (label.label_code ?? "etiqueta").replace(/[^\w.-]/g, "_") + (pdf ? ".pdf" : ".zpl")
    return reply.header("cache-control", "no-store").header("content-type", pdf ? "application/pdf" : "text/plain; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}"`).send(label.label_content)
  })

  app.post(`${base}/contracts`, async (request, reply) => {
    const result = await authorizeRequest(request, deps, async ctx => {
      requirePermission(ctx, read); requirePermission(ctx, manage)
      const input = parse(contractInput, request.body)
      const key = commandKey(request.headers["idempotency-key"])
      const scope = "logistics.freight.contracted", intent = { input }
      const previous = await replay(ctx, key, scope, intent)
      if (previous) return { value: previous as { data: { revision: unknown } }, status: 200, replayed: true }
      await ctx.client.query("SELECT 1 FROM logistics_shipments WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [ctx.tenantId, input.shipmentId])
      const { input: quote, recipientName } = await quoteSource(ctx, input.shipmentId)
      if ((await ctx.client.query("SELECT 1 FROM logistics_freight_contracts WHERE tenant_id=$1 AND shipment_id=$2 AND status<>'cancelled'", [ctx.tenantId, input.shipmentId])).rows[0])
        conflict("A expedição já possui frete contratado. Cancele o envio atual para contratar outro.")
      // Recota no momento da contratação: preço e prazo gravados são os do provedor agora, não os da tela.
      const option = (await provider.quote(quote)).find(o => o.serviceCode === input.serviceCode)
      if (!option) conflict("O serviço escolhido não está mais disponível para este envio. Refaça a cotação.")
      const id = randomUUID()
      const contracted = await provider.contract({ ...quote, serviceCode: option!.serviceCode, reference: id, recipientName })
      await ctx.client.query(`INSERT INTO logistics_freight_contracts(id,tenant_id,shipment_id,provider,provider_reference,service_code,service_name,carrier_name,price_cents,delivery_days,tracking_code,quote_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, ctx.tenantId, input.shipmentId, provider.code, contracted.providerReference, option!.serviceCode, option!.serviceName,
        option!.carrierName, option!.priceCents, option!.deliveryDays, contracted.trackingCode, { origin: quote.origin, destination: quote.destination, packages: quote.packages, declaredValueCents: quote.declaredValueCents }])
      // A transportadora e o rastreio contratados passam a valer no romaneio da expedição (L1).
      await ctx.client.query("UPDATE logistics_shipments SET carrier_name=$3,tracking_code=COALESCE($4,tracking_code),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId, input.shipmentId, option!.carrierName, contracted.trackingCode])
      await shipmentEvent(ctx, input.shipmentId, "freight_contracted", { contractId: id, carrierName: option!.carrierName, serviceName: option!.serviceName, trackingCode: contracted.trackingCode })
      const value = { ...caps(ctx), data: await load(ctx, id) }
      await record(ctx, request.headers, "logistics_freight_contract", id, scope, { tenantId: ctx.tenantId, data: { id, shipmentId: input.shipmentId, carrierName: option!.carrierName, priceCents: option!.priceCents } })
      await remember(ctx, key, scope, intent, value)
      return { value, status: 201, replayed: false }
    })
    if (result.replayed) reply.header("idempotency-replayed", "true")
    return reply.code(result.status).header("cache-control", "no-store").header("etag", withEtag(result.value)).send(result.value)
  })

  command("label", "logistics.freight.labeled", async (ctx, id, row) => {
    if (row.provider !== provider.code) conflict("O envio foi contratado em outro provedor de frete")
    const label = await provider.label(row.provider_reference)
    if (!label.content.length || label.content.length > 2_097_152) throw new Problem(502, "freight_provider_error", "O provedor de frete devolveu uma etiqueta inválida")
    await ctx.client.query(`UPDATE logistics_freight_contracts SET label_format=$3,label_code=$4,label_content=$5,labeled_at=now(),
        status=CASE WHEN status='contracted' THEN 'labeled' ELSE status END,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2`,
      [ctx.tenantId, id, label.format, label.labelCode, label.content])
    return "logistics.freight.labeled"
  })

  command("tracking", "logistics.freight.tracked", async (ctx, id, row) => {
    if (row.provider !== provider.code) conflict("O envio foi contratado em outro provedor de frete")
    const events = await provider.track(row.provider_reference)
    let added = 0
    for (const e of events) {
      const inserted = await ctx.client.query(`INSERT INTO logistics_freight_events(id,tenant_id,contract_id,provider_event_id,occurred_at,status,description,location)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,contract_id,provider_event_id) DO NOTHING RETURNING id`,
        [randomUUID(), ctx.tenantId, id, e.providerEventId, e.occurredAt, e.status, e.description.slice(0, 300), e.location?.slice(0, 200) ?? null])
      // Rastreio aparece no histórico da expedição do pedido.
      if (inserted.rows.length) { added++; await shipmentEvent(ctx, row.shipment_id, "tracking", { contractId: id, status: e.status, description: e.description.slice(0, 300), location: e.location, occurredAt: e.occurredAt }) }
    }
    const next = events.some(e => e.status === "delivered") ? "delivered" : events.length ? "in_transit" : row.status
    await ctx.client.query(`UPDATE logistics_freight_contracts SET status=CASE WHEN status='delivered' THEN status ELSE $3 END,
        revision=revision+CASE WHEN $4 OR status<>$3 THEN 1 ELSE 0 END,updated_at=now() WHERE tenant_id=$1 AND id=$2`, [ctx.tenantId, id, next, added > 0])
    return "logistics.freight.tracked"
  })

  command("cancel", "logistics.freight.cancelled", async (ctx, id, row) => {
    if (row.status !== "contracted" && row.status !== "labeled") conflict("Envio já postado ou entregue não pode ser cancelado")
    if (row.provider !== provider.code) conflict("O envio foi contratado em outro provedor de frete")
    await provider.cancel(row.provider_reference)
    await ctx.client.query("UPDATE logistics_freight_contracts SET status='cancelled',cancelled_at=now(),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, id])
    await shipmentEvent(ctx, row.shipment_id, "freight_cancelled", { contractId: id })
    return "logistics.freight.cancelled"
  })
}
