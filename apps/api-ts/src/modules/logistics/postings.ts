import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import type { AccessDependencies } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { databaseId } from "../../platform/database-id.js"
import { authorizedDomain, conflict, invalid, notFound, staleRevision } from "../../platform/domain.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { exact, hasControl, parseBody, POSTINGS_MANAGE, POSTINGS_READ, reply, validId } from "./shared.js"

// Porte de `apps/api/src/domains/logistics.rs`: objetos de postagem e a sua máquina de situação.
const statuses = ["prepared", "posted", "in_transit", "delivered", "cancelled"] as const
type Status = (typeof statuses)[number]
const transitions: Record<Status, readonly Status[]> = {
  prepared: ["posted", "cancelled"],
  posted: ["in_transit", "cancelled"],
  in_transit: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
}
export const allowedTransition = (current: string, next: string) => (transitions[current as Status] ?? []).includes(next as Status)

const text = (min: number, max: number) => z.string().transform(value => value.trim()).refine(value => [...value].length >= min && [...value].length <= max && !hasControl(value))
// Rust aceitava transportadora e rastreio sem limite; aqui ficam limitados e vazio vira `null`.
const optionalText = (max: number) => z.string().transform(value => value.trim()).refine(value => [...value].length <= max && !hasControl(value)).nullish().transform(value => value || null)

export const postingInputSchema = z.strictObject({
  recipientName: text(2, 200),
  service: text(2, 80),
  destinationCity: text(2, 120),
  destinationState: z.string().transform(value => value.trim().toUpperCase()).refine(value => /^[A-Z]{2}$/.test(value)),
  packageCount: z.number().int().min(1).max(999),
  weightGrams: z.number().int().min(1).max(999_999_999),
  declaredValueCents: z.number().int().min(0).max(99_999_999_999_999),
  orderId: databaseId.nullish().transform(value => value?.toLowerCase() ?? null),
  carrier: optionalText(80),
  trackingCode: optionalText(60),
})
export const postingStatusSchema = z.strictObject({ status: z.enum(statuses) })
const listQuerySchema = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
})

const columns = "id,code,order_id,recipient_name,carrier,service,tracking_code,destination_city,destination_state,package_count,weight_grams,declared_value_cents,status,revision,created_at,updated_at"
function output(row: Record<string, unknown>) {
  return {
    id: row.id, code: row.code, orderId: row.order_id, recipientName: row.recipient_name, carrier: row.carrier, service: row.service,
    trackingCode: row.tracking_code, destinationCity: row.destination_city, destinationState: row.destination_state,
    packageCount: row.package_count, weightGrams: exact(row.weight_grams), declaredValueCents: exact(row.declared_value_cents),
    status: row.status, revision: revisionValue(row.revision), createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export function registerPostings(app: FastifyInstance, dependencies: AccessDependencies) {
  app.get("/api/v1/logistics/postings", { config: { openapi: { summary: "Listar objetos de postagem", query: listQuerySchema } } }, async (request, response) => {
    const query = listQuerySchema.safeParse(request.query)
    if (!query.success) throw invalid("Consulta inválida")
    const status = query.data.status
    if (status !== undefined && !statuses.includes(status as Status)) throw invalid("Situação de postagem inválida")
    const limit = Math.min(Math.max(query.data.limit ?? 50, 1), 100)
    const offset = Math.max(query.data.offset ?? 0, 0)
    const q = query.data.q?.trim() || null
    const body = await authorizedDomain(request, dependencies, POSTINGS_READ, POSTINGS_MANAGE, false, async (context, canEdit) => {
      const rows = await context.client.query(`SELECT ${columns} FROM logistics_postings WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR strpos(lower(code),lower($3))>0 OR strpos(lower(recipient_name),lower($3))>0 OR strpos(lower(destination_city),lower($3))>0) ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`, [context.tenantId, status ?? null, q, limit, offset])
      return { tenantId: context.tenantId, canEdit, data: rows.rows.map(output), limit, offset }
    })
    return reply(response, 200, body)
  })

  app.get<{ Params: { id: string } }>("/api/v1/logistics/postings/:id", { config: { openapi: { summary: "Detalhar objeto de postagem" } } }, async (request, response) => {
    if (!validId(request.params.id)) throw notFound()
    const body = await authorizedDomain(request, dependencies, POSTINGS_READ, POSTINGS_MANAGE, false, async (context, canEdit) => {
      const row = (await context.client.query(`SELECT ${columns} FROM logistics_postings WHERE tenant_id=$1 AND id=$2`, [context.tenantId, request.params.id])).rows[0]
      if (!row) throw notFound()
      return { tenantId: context.tenantId, canEdit, data: output(row) }
    })
    return reply(response, 200, body, body.data.revision)
  })

  app.post("/api/v1/logistics/postings", { config: { openapi: { summary: "Criar objeto de postagem (Idempotency-Key obrigatória)", body: postingInputSchema, successStatus: 201 } } }, async (request, response) => {
    const key = commandKey(request.headers["idempotency-key"])
    const result = await authorizedDomain(request, dependencies, POSTINGS_READ, POSTINGS_MANAGE, true, async context => {
      const input = parseBody(postingInputSchema, request.body, "Dados da postagem inválidos")
      const previous = await replay(context, key, "logistics.posting.create", input)
      if (previous) return { replayed: true, body: previous }
      const id = randomUUID()
      const code = `OBJ-${id.replaceAll("-", "").slice(0, 8).toUpperCase()}`
      const row = (await context.client.query(`INSERT INTO logistics_postings(id,tenant_id,code,order_id,recipient_name,carrier,service,tracking_code,destination_city,destination_state,package_count,weight_grams,declared_value_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${columns}`, [id, context.tenantId, code, input.orderId, input.recipientName, input.carrier, input.service, input.trackingCode, input.destinationCity, input.destinationState, input.packageCount, input.weightGrams, input.declaredValueCents])).rows[0]!
      const body = { tenantId: context.tenantId, data: output(row) }
      await record(context, request.headers, "logistics_posting", id, "logistics.posting.created", body)
      await remember(context, key, "logistics.posting.create", input, body)
      return { replayed: false, body }
    })
    // Como no Rust: a repetição devolve 200 com o resultado gravado, sem ETag.
    return result.replayed ? reply(response, 200, result.body) : reply(response, 201, result.body, 1)
  })

  app.post<{ Params: { id: string } }>("/api/v1/logistics/postings/:id/status", { config: { openapi: { summary: "Mudar situação da postagem (If-Match e Idempotency-Key)", body: postingStatusSchema } } }, async (request, response) => {
    const key = commandKey(request.headers["idempotency-key"])
    const expected = parseRevision(request.headers["if-match"])
    if (!validId(request.params.id)) throw notFound()
    const id = request.params.id
    const result = await authorizedDomain(request, dependencies, POSTINGS_READ, POSTINGS_MANAGE, true, async context => {
      const { status } = parseBody(postingStatusSchema, request.body, "Situação de postagem inválida")
      const commandRequest = { id, status, revision: expected }
      const previous = await replay(context, key, "logistics.posting.status", commandRequest)
      if (previous) return { replayed: true, body: previous, revision: undefined }
      const current = (await context.client.query<{ status: string; revision: string }>("SELECT status,revision FROM logistics_postings WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, id])).rows[0]
      if (!current) throw notFound()
      if (revisionValue(current.revision) !== expected) throw staleRevision()
      if (!allowedTransition(current.status, status)) throw conflict("Transição de situação não permitida")
      const revision = nextRevision(expected)
      await context.client.query("UPDATE logistics_postings SET status=$3,revision=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, status, revision])
      const body = { tenantId: context.tenantId, data: { id, status, revision } }
      await record(context, request.headers, "logistics_posting", id, "logistics.posting.status_changed", body)
      await remember(context, key, "logistics.posting.status", commandRequest, body)
      return { replayed: false, body, revision }
    })
    return reply(response, 200, result.body, result.revision)
  })
}
