import { randomUUID } from "node:crypto"

import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { sameJson } from "../../platform/json.js"
import { integer, parseListQuery } from "../registrations/query.js"

const definitions = {
  "product-categories": { table: "product_categories", read: "catalog.categories.read", manage: "catalog.categories.manage", extras: ["parent_id", "sort_order"] },
  "product-groups": { table: "product_groups", read: "catalog.products.read", manage: "catalog.products.manage", extras: [] },
  "tag-groups": { table: "tag_groups", read: "catalog.products.read", manage: "catalog.products.manage", extras: [] },
  tags: { table: "tags", read: "catalog.products.read", manage: "catalog.products.manage", extras: ["group_id"] },
} as const

const baseInput = z.object({
  code: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._/-]+$/).transform(value => value.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  status: z.enum(["active", "archived"]),
  notes: z.string().trim().max(2000).nullable(),
}).strict()

const inputSchemas = {
  "product-categories": baseInput.extend({ parentId: z.string().uuid().nullable(), sortOrder: z.number().int().min(0).max(1_000_000) }).strict(),
  "product-groups": baseInput,
  "tag-groups": baseInput,
  tags: baseInput.extend({ groupId: z.string().uuid().nullable() }).strict(),
} as const

function singleHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? undefined : value
}

function commandKey(value: string | string[] | undefined) {
  const parsed = z.string().uuid().safeParse(singleHeader(value))
  if (singleHeader(value) === undefined) throw new Problem(428, "idempotency_required", "Informe a chave de idempotência")
  if (!parsed.success) throw new Problem(422, "invalid_input", "Chave de idempotência inválida")
  return parsed.data
}

function expectedRevision(value: string | string[] | undefined) {
  if (value === undefined) throw new Problem(428, "revision_required", "Recarregue o cadastro antes de salvar")
  const match = /^"([1-9][0-9]*)"$/.exec(singleHeader(value) ?? "")
  const parsed = match?.[1] ? Number(match[1]) : Number.NaN
  if (!Number.isSafeInteger(parsed)) throw new Problem(400, "invalid_revision", "Revisão inválida")
  return parsed
}

function output(row: Record<string, unknown>, extras: readonly string[]) {
  const value: Record<string, unknown> = { id: row.id, revision: integer(row.revision), code: row.code, name: row.name, status: row.status, notes: row.notes }
  if (extras.includes("parent_id")) value.parentId = row.parent_id
  if (extras.includes("sort_order")) value.sortOrder = integer(row.sort_order)
  if (extras.includes("group_id")) value.groupId = row.group_id
  return value
}

export function registerReferenceRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  for (const [resource, definition] of Object.entries(definitions)) {
    const schema = inputSchemas[resource as keyof typeof inputSchemas]
    const projection = ["id", "revision", "code", "name", "status", "notes", ...definition.extras].join(",")
    const load = async (client: Parameters<Parameters<typeof authorizeRequest>[2]>[0]["client"], tenantId: string, id: string) => {
      const result = await client.query<Record<string, unknown>>(`SELECT ${projection} FROM ${definition.table} WHERE tenant_id=$1 AND id=$2`, [tenantId, id])
      return result.rows[0]
    }

    app.get(`/api/v1/${resource}`, async (request, reply) => {
      const query = parseListQuery(request.query)
      const body = await authorizeRequest(request, dependencies, async context => {
        requirePermission(context, definition.read)
        const rows = await context.client.query(`SELECT ${projection} FROM ${definition.table} WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND (strpos(lower(name),lower($3))>0 OR strpos(lower(code),lower($3))>0) ORDER BY name,id LIMIT $4 OFFSET $5`, [context.tenantId, query.status ?? null, query.q, query.limit, query.offset])
        const count = await context.client.query<{ total: string }>(`SELECT count(*)::text AS total FROM ${definition.table} WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND (strpos(lower(name),lower($3))>0 OR strpos(lower(code),lower($3))>0)`, [context.tenantId, query.status ?? null, query.q])
        return { tenantId: context.tenantId, canEdit: context.permissions.includes(definition.manage), data: rows.rows.map(row => output(row, definition.extras)), total: integer(count.rows[0]?.total ?? 0), offset: query.offset, limit: query.limit }
      })
      return reply.header("cache-control", "no-store").send(body)
    })

    app.get<{ Params: { id: string } }>(`/api/v1/${resource}/:id`, async (request, reply) => {
      if (!z.string().uuid().safeParse(request.params.id).success) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
      const data = await authorizeRequest(request, dependencies, async context => {
        requirePermission(context, definition.read)
        const row = await load(context.client, context.tenantId, request.params.id)
        if (!row) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
        return output(row, definition.extras)
      })
      return reply.header("cache-control", "no-store").header("etag", `"${String(data.revision)}"`).send(data)
    })

    app.post(`/api/v1/${resource}`, async (request, reply) => {
      const key = commandKey(request.headers["idempotency-key"])
      const parsed = schema.safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Cadastro inválido ou campos desconhecidos")
      const scope = `${resource}.create`
      const data = await authorizeRequest(request, dependencies, async context => {
        requirePermission(context, definition.manage)
        requirePermission(context, definition.read)
        const replay = await context.client.query<{ scope: string; request: unknown; result: Record<string, unknown> }>("SELECT scope,request,result FROM domain_commands WHERE tenant_id=$1 AND auth_subject=$2 AND command_key=$3", [context.tenantId, context.identity.subject, key])
        if (replay.rows[0]) {
          if (replay.rows[0].scope !== scope || !sameJson(replay.rows[0].request, parsed.data)) throw new Problem(409, "domain_conflict", "Esta chave de idempotência já foi usada com outros dados")
          return { value: replay.rows[0].result, replayed: true }
        }
        await context.client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [context.tenantId])
        const recordId = randomUUID()
        const values = parsed.data as Record<string, unknown>
        const extras = definition.extras
        const columns = ["id", "tenant_id", "code", "name", "status", "notes", ...extras]
        const extraValues = extras.map(column => values[column === "parent_id" ? "parentId" : column === "sort_order" ? "sortOrder" : "groupId"])
        const parameters = [recordId, context.tenantId, values.code, values.name, values.status, values.notes, ...extraValues]
        await context.client.query(`INSERT INTO ${definition.table}(${columns.join(",")}) VALUES(${parameters.map((_, index) => `$${index + 1}`).join(",")})`, parameters)
        const row = await load(context.client, context.tenantId, recordId)
        if (!row) throw new Problem(500, "persistence_error", "Não foi possível carregar o cadastro criado")
        const result = output(row, definition.extras)
        await context.client.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,entity_id,request_id,details) SELECT $1,id,$3,$4,$5,$6,$7 FROM identities WHERE auth_subject=$2", [context.tenantId, context.identity.subject, `${resource}.created`, resource, recordId, singleHeader(request.headers["x-request-id"]) ?? null, { id: recordId }])
        await context.client.query("INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5)", [context.tenantId, resource, recordId, `${resource}.created`, { id: recordId }])
        await context.client.query("INSERT INTO domain_commands(tenant_id,auth_subject,command_key,scope,request,result) VALUES($1,$2,$3,$4,$5,$6)", [context.tenantId, context.identity.subject, key, scope, parsed.data, result])
        return { value: result, replayed: false }
      })
      return reply.code(data.replayed ? 200 : 201).header("cache-control", "no-store").header("etag", `"${String(data.value.revision)}"`).header("idempotency-replayed", String(data.replayed)).send(data.value)
    })

    app.put<{ Params: { id: string } }>(`/api/v1/${resource}/:id`, async (request, reply) => {
      const key = commandKey(request.headers["idempotency-key"])
      const expected = expectedRevision(request.headers["if-match"])
      const parsed = schema.safeParse(request.body)
      if (!z.string().uuid().safeParse(request.params.id).success) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
      if (!parsed.success) throw new Problem(422, "invalid_input", "Cadastro inválido ou campos desconhecidos")
      const scope = `${resource}.update`
      const data = await authorizeRequest(request, dependencies, async context => {
        requirePermission(context, definition.manage)
        requirePermission(context, definition.read)
        const replay = await context.client.query<{ scope: string; request: unknown; result: Record<string, unknown> }>("SELECT scope,request,result FROM domain_commands WHERE tenant_id=$1 AND auth_subject=$2 AND command_key=$3", [context.tenantId, context.identity.subject, key])
        const commandRequest = { id: request.params.id, revision: expected, ...parsed.data }
        if (replay.rows[0]) {
          if (replay.rows[0].scope !== scope || !sameJson(replay.rows[0].request, commandRequest)) throw new Problem(409, "domain_conflict", "Esta chave de idempotência já foi usada com outros dados")
          return { value: replay.rows[0].result, replayed: true }
        }
        await context.client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [context.tenantId])
        const current = await load(context.client, context.tenantId, request.params.id)
        if (!current) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
        if (integer(current.revision) !== expected) throw new Problem(412, "revision_conflict", "O cadastro foi alterado por outra pessoa")
        const values = parsed.data as Record<string, unknown>
        const assignments = ["code", "name", "status", "notes", ...definition.extras]
        const updateValues = assignments.map(column => values[column === "parent_id" ? "parentId" : column === "sort_order" ? "sortOrder" : column === "group_id" ? "groupId" : column])
        const updated = await context.client.query(`UPDATE ${definition.table} SET ${assignments.map((column, index) => `${column}=$${index + 3}`).join(",")},revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND revision=$${updateValues.length + 3} RETURNING 1 AS affected`, [context.tenantId, request.params.id, ...updateValues, expected])
        if (!updated.rows[0]) throw new Problem(412, "revision_conflict", "O cadastro foi alterado por outra pessoa")
        const row = await load(context.client, context.tenantId, request.params.id)
        if (!row) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
        const result = output(row, definition.extras)
        await context.client.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,entity_id,request_id,details) SELECT $1,id,$3,$4,$5,$6,$7 FROM identities WHERE auth_subject=$2", [context.tenantId, context.identity.subject, `${resource}.updated`, resource, request.params.id, singleHeader(request.headers["x-request-id"]) ?? null, { id: request.params.id }])
        await context.client.query("INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5)", [context.tenantId, resource, request.params.id, `${resource}.updated`, { id: request.params.id }])
        await context.client.query("INSERT INTO domain_commands(tenant_id,auth_subject,command_key,scope,request,result) VALUES($1,$2,$3,$4,$5,$6)", [context.tenantId, context.identity.subject, key, scope, commandRequest, result])
        return { value: result, replayed: false }
      })
      return reply.header("cache-control", "no-store").header("etag", `"${String(data.value.revision)}"`).header("idempotency-replayed", String(data.replayed)).send(data.value)
    })
  }
}
