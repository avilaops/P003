import { revisionValue, nextRevision, parseRevision as expectedRevision } from "../../platform/revision.js"
import { randomUUID } from "node:crypto"

import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { databaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { sameJson } from "../../platform/json.js"
import { integer, parseListQuery } from "../registrations/query.js"

const definitions = {
  warehouses: { table: "warehouses", event: "warehouse", read: "inventory.stock.read", manage: "inventory.stock.manage", extras: ["location"] },
  "product-categories": { table: "product_categories", event: "product_category", read: "catalog.categories.read", manage: "catalog.categories.manage", extras: ["parent_id", "sort_order"] },
  "product-groups": { table: "product_groups", event: "product_group", read: "catalog.products.read", manage: "catalog.products.manage", extras: [] },
  "tag-groups": { table: "tag_groups", event: "tag_group", read: "catalog.products.read", manage: "catalog.products.manage", extras: [] },
  tags: { table: "tags", event: "tag", read: "catalog.products.read", manage: "catalog.products.manage", extras: ["group_id"] },
} as const

const baseInput = z.object({
  code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).transform(value => value.toUpperCase()),
  name: z.string().trim().refine(value => [...value].length > 0 && [...value].length <= 200 && !/\p{Cc}/u.test(value)),
  status: z.enum(["active", "archived"]),
  notes: z.string().trim().refine(value => [...value].length <= 1000 && !/\p{Cc}/u.test(value)).nullable().optional().transform(value => value || null),
}).strict()

const inputSchemas = {
  warehouses: baseInput.extend({ location: z.string().trim().refine(value => [...value].length <= 200 && !/\p{Cc}/u.test(value)).nullish().transform(value => value || null) }).strict(),
  "product-categories": baseInput.extend({ parentId: databaseId.nullable().optional().default(null), sortOrder: z.number().int().min(0).max(999_999) }).strict(),
  "product-groups": baseInput,
  "tag-groups": baseInput,
  tags: baseInput.extend({ groupId: z.guid().nullable().optional().default(null) }).strict(),
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

function output(row: Record<string, unknown>, extras: readonly string[]) {
  const value: Record<string, unknown> = { id: row.id, revision: revisionValue(row.revision), code: row.code, name: row.name, status: row.status, notes: row.notes }
  if (extras.includes("parent_id")) value.parentId = row.parent_id
  if (extras.includes("sort_order")) value.sortOrder = integer(row.sort_order)
  if (extras.includes("group_id")) value.groupId = row.group_id
  if (extras.includes("location")) value.location = row.location
  return value
}

function revisionOf(snapshot: Record<string, unknown>) { return String((snapshot.data as Record<string, unknown>).revision) }

async function validateRelations(context: AuthorizedContext, resource: string, id: string, input: Record<string, unknown>) {
  const { client, tenantId } = context
  if (resource === "product-categories") {
    if (input.parentId) {
      const parent = await client.query("SELECT status FROM product_categories WHERE tenant_id=$1 AND id=$2", [tenantId, input.parentId])
      if (!parent.rows[0]) throw new Problem(409, "domain_conflict", "Categoria superior não pertence a esta empresa")
      if (input.status === "active" && parent.rows[0].status !== "active") throw new Problem(409, "domain_conflict", "Categoria ativa exige categoria superior ativa")
      const cycle = await client.query<{ exists: boolean }>("WITH RECURSIVE ancestors AS (SELECT id,parent_id FROM product_categories WHERE tenant_id=$1 AND id=$2 UNION SELECT p.id,p.parent_id FROM product_categories p JOIN ancestors a ON p.id=a.parent_id WHERE p.tenant_id=$1) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=$3) AS exists", [tenantId, input.parentId, id])
      if (cycle.rows[0]?.exists) throw new Problem(409, "domain_conflict", "A categoria superior criaria um ciclo")
    }
    if (input.status === "archived") {
      const children = await client.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM product_categories WHERE tenant_id=$1 AND parent_id=$2 AND status='active') AS exists", [tenantId, id])
      if (children.rows[0]?.exists) throw new Problem(409, "domain_conflict", "Arquive ou mova as subcategorias ativas antes da categoria superior")
    }
  }
  if (resource === "tags" && input.groupId) {
    const group = await client.query("SELECT status FROM tag_groups WHERE tenant_id=$1 AND id=$2", [tenantId, input.groupId])
    if (!group.rows[0]) throw new Problem(409, "domain_conflict", "Grupo de tags não pertence a esta empresa")
    if (input.status === "active" && group.rows[0].status !== "active") throw new Problem(409, "domain_conflict", "Tag ativa exige grupo ativo")
  }
  if (resource === "tag-groups" && input.status === "archived") {
    const active = await client.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM tags WHERE tenant_id=$1 AND group_id=$2 AND status='active') AS exists", [tenantId, id])
    if (active.rows[0]?.exists) throw new Problem(409, "domain_conflict", "Arquive ou mova as tags ativas antes do grupo")
  }
}

export function registerReferenceRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  for (const [resource, definition] of Object.entries(definitions)) {
    const schema = inputSchemas[resource as keyof typeof inputSchemas]
    const idSchema = databaseId
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
      if (!idSchema.safeParse(request.params.id).success) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
      const data = await authorizeRequest(request, dependencies, async context => {
        requirePermission(context, definition.read)
        const row = await load(context.client, context.tenantId, request.params.id)
        if (!row) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
        return { tenantId: context.tenantId, canEdit: context.permissions.includes(definition.manage), data: output(row, definition.extras) }
      })
      return reply.header("cache-control", "no-store").header("etag", `"${revisionOf(data)}"`).send(data)
    })

    app.post(`/api/v1/${resource}`, async (request, reply) => {
      const key = commandKey(request.headers["idempotency-key"])
      const parsed = schema.safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Cadastro inválido ou campos desconhecidos")
      const scope = `${definition.event}.created`
      const commandRequest = { id: null, revision: null, input: parsed.data }
      const data = await authorizeRequest(request, dependencies, async context => {
        requirePermission(context, definition.manage)
        requirePermission(context, definition.read)
        const replay = await context.client.query<{ scope: string; request: unknown; result: Record<string, unknown> }>("SELECT scope,request,result FROM domain_commands WHERE tenant_id=$1 AND auth_subject=$2 AND command_key=$3", [context.tenantId, context.identity.subject, key])
        if (replay.rows[0]) {
          if (replay.rows[0].scope !== scope || !sameJson(replay.rows[0].request, commandRequest)) throw new Problem(409, "domain_conflict", "Esta chave de idempotência já foi usada com outros dados")
          return { value: replay.rows[0].result, replayed: true }
        }
        await context.client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [context.tenantId])
        const recordId = randomUUID()
        const values = parsed.data as Record<string, unknown>
        await validateRelations(context, resource, recordId, values)
        const extras = definition.extras
        const columns = ["id", "tenant_id", "code", "name", "status", "notes", "revision", ...extras]
        const extraValues = extras.map(column => values[column === "parent_id" ? "parentId" : column === "sort_order" ? "sortOrder" : column === "group_id" ? "groupId" : column])
        const parameters = [recordId, context.tenantId, values.code, values.name, values.status, values.notes, 1, ...extraValues]
        await context.client.query(`INSERT INTO ${definition.table}(${columns.join(",")}) VALUES(${parameters.map((_, index) => `$${index + 1}`).join(",")})`, parameters)
        const row = await load(context.client, context.tenantId, recordId)
        if (!row) throw new Problem(500, "persistence_error", "Não foi possível carregar o cadastro criado")
        const result = { tenantId: context.tenantId, canEdit: true, data: output(row, definition.extras) }
        const details = { revision: 1, previousRevision: null, status: parsed.data.status }
        await context.client.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,entity_id,request_id,details) SELECT $1,id,$3,$4,$5,$6,$7 FROM identities WHERE auth_subject=$2", [context.tenantId, context.identity.subject, scope, definition.table, recordId, singleHeader(request.headers["x-request-id"]) ?? null, details])
        await context.client.query("INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5)", [context.tenantId, definition.table, recordId, scope, details])
        await context.client.query("INSERT INTO domain_commands(tenant_id,auth_subject,command_key,scope,request,result) VALUES($1,$2,$3,$4,$5,$6)", [context.tenantId, context.identity.subject, key, scope, commandRequest, result])
        return { value: result, replayed: false }
      })
      if (data.replayed) reply.header("idempotency-replayed", "true")
      return reply.code(201).header("cache-control", "no-store").header("etag", `"${revisionOf(data.value)}"`).send(data.value)
    })

    app.put<{ Params: { id: string } }>(`/api/v1/${resource}/:id`, async (request, reply) => {
      const key = commandKey(request.headers["idempotency-key"])
      const expected = expectedRevision(request.headers["if-match"])
      const parsed = schema.safeParse(request.body)
      if (!idSchema.safeParse(request.params.id).success) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
      if (!parsed.success) throw new Problem(422, "invalid_input", "Cadastro inválido ou campos desconhecidos")
      const scope = `${definition.event}.updated`
      const data = await authorizeRequest(request, dependencies, async context => {
        requirePermission(context, definition.manage)
        requirePermission(context, definition.read)
        const replay = await context.client.query<{ scope: string; request: unknown; result: Record<string, unknown> }>("SELECT scope,request,result FROM domain_commands WHERE tenant_id=$1 AND auth_subject=$2 AND command_key=$3", [context.tenantId, context.identity.subject, key])
        const commandRequest = { id: request.params.id, revision: expected, input: parsed.data }
        if (replay.rows[0]) {
          if (replay.rows[0].scope !== scope || !sameJson(replay.rows[0].request, commandRequest)) throw new Problem(409, "domain_conflict", "Esta chave de idempotência já foi usada com outros dados")
          return { value: replay.rows[0].result, replayed: true }
        }
        await context.client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [context.tenantId])
        const current = await load(context.client, context.tenantId, request.params.id)
        if (!current) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
        if (revisionValue(current.revision) !== expected) throw new Problem(412, "revision_conflict", "O cadastro foi alterado por outra pessoa")
        const values = parsed.data as Record<string, unknown>
        await validateRelations(context, resource, request.params.id, values)
        const assignments = ["code", "name", "status", "notes", ...definition.extras]
        const updateValues = assignments.map(column => values[column === "parent_id" ? "parentId" : column === "sort_order" ? "sortOrder" : column === "group_id" ? "groupId" : column])
        const updated = await context.client.query(`UPDATE ${definition.table} SET ${assignments.map((column, index) => `${column}=$${index + 3}`).join(",")},revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND revision=$${updateValues.length + 3} RETURNING 1 AS affected`, [context.tenantId, request.params.id, ...updateValues, expected])
        if (!updated.rows[0]) throw new Problem(412, "revision_conflict", "O cadastro foi alterado por outra pessoa")
        const row = await load(context.client, context.tenantId, request.params.id)
        if (!row) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
        const result = { tenantId: context.tenantId, canEdit: true, data: output(row, definition.extras) }
        const details = { revision: nextRevision(expected), previousRevision: expected, status: parsed.data.status }
        await context.client.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,entity_id,request_id,details) SELECT $1,id,$3,$4,$5,$6,$7 FROM identities WHERE auth_subject=$2", [context.tenantId, context.identity.subject, scope, definition.table, request.params.id, singleHeader(request.headers["x-request-id"]) ?? null, details])
        await context.client.query("INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5)", [context.tenantId, definition.table, request.params.id, scope, details])
        await context.client.query("INSERT INTO domain_commands(tenant_id,auth_subject,command_key,scope,request,result) VALUES($1,$2,$3,$4,$5,$6)", [context.tenantId, context.identity.subject, key, scope, commandRequest, result])
        return { value: result, replayed: false }
      })
      if (data.replayed) reply.header("idempotency-replayed", "true")
      return reply.header("cache-control", "no-store").header("etag", `"${revisionOf(data.value)}"`).send(data.value)
    })
  }
}
