import type { FastifyInstance } from "fastify"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { integer, parseListQuery } from "../registrations/query.js"

const definitions = {
  "product-categories": { table: "product_categories", read: "catalog.categories.read", manage: "catalog.categories.manage", extras: ["parent_id", "sort_order"] },
  "product-groups": { table: "product_groups", read: "catalog.products.read", manage: "catalog.products.manage", extras: [] },
  "tag-groups": { table: "tag_groups", read: "catalog.products.read", manage: "catalog.products.manage", extras: [] },
  tags: { table: "tags", read: "catalog.products.read", manage: "catalog.products.manage", extras: ["group_id"] },
} as const

function output(row: Record<string, unknown>, extras: readonly string[]) {
  const value: Record<string, unknown> = { id: row.id, revision: integer(row.revision), code: row.code, name: row.name, status: row.status, notes: row.notes }
  if (extras.includes("parent_id")) value.parentId = row.parent_id
  if (extras.includes("sort_order")) value.sortOrder = integer(row.sort_order)
  if (extras.includes("group_id")) value.groupId = row.group_id
  return value
}

export function registerReferenceRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  for (const [resource, definition] of Object.entries(definitions)) {
    app.get(`/api/v1/${resource}`, async (request, reply) => {
      const query = parseListQuery(request.query)
      const body = await authorizeRequest(request, dependencies, async context => {
        requirePermission(context, definition.read)
        const projection = ["id", "revision", "code", "name", "status", "notes", ...definition.extras].join(",")
        const rows = await context.client.query(`SELECT ${projection} FROM ${definition.table} WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND (strpos(lower(name),lower($3))>0 OR strpos(lower(code),lower($3))>0) ORDER BY name,id LIMIT $4 OFFSET $5`, [context.tenantId, query.status ?? null, query.q, query.limit, query.offset])
        const count = await context.client.query<{ total: string }>(`SELECT count(*)::text AS total FROM ${definition.table} WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND (strpos(lower(name),lower($3))>0 OR strpos(lower(code),lower($3))>0)`, [context.tenantId, query.status ?? null, query.q])
        return { tenantId: context.tenantId, canEdit: context.permissions.includes(definition.manage), data: rows.rows.map(row => output(row, definition.extras)), total: integer(count.rows[0]?.total ?? 0), offset: query.offset, limit: query.limit }
      })
      return reply.header("cache-control", "no-store").send(body)
    })
  }
}
