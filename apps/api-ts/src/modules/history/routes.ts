import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { referenceAudit } from "../reference-data/routes.js"

// Histórico genérico de qualquer cadastro, a partir do audit_log. Novo cadastro entra aqui com uma linha.
const sources: Record<string, { entityType: string; read: string }> = {
  party: { entityType: "party", read: "catalog.parties.read" },
  product: { entityType: "product", read: "catalog.products.read" },
  ...referenceAudit,
}
const query = z.strictObject({ before: z.guid().optional() })

export function registerHistoryRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get<{ Params: { entity: string; id: string }; Querystring: { before?: string } }>("/api/v1/history/:entity/:id", async (request, reply) => {
    const source = Object.hasOwn(sources, request.params.entity) ? sources[request.params.entity] : undefined
    if (!source || !z.guid().safeParse(request.params.id).success) throw new Problem(404, "not_found", "Histórico não encontrado")
    const parsed = query.safeParse(request.query)
    if (!parsed.success) throw new Problem(422, "invalid_input", "Página de histórico inválida")
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, source.read)
      let cursor: { occurred_at: Date; id: string } | undefined
      if (parsed.data.before) {
        cursor = (await context.client.query<{ occurred_at: Date; id: string }>("SELECT occurred_at,id FROM audit_log WHERE tenant_id=$1 AND id=$2 AND entity_type=$3 AND entity_id=$4", [context.tenantId, parsed.data.before.toLowerCase(), source.entityType, request.params.id.toLowerCase()])).rows[0]
        if (!cursor) throw new Problem(422, "invalid_input", "Página de histórico inválida; atualize a consulta")
      }
      const rows = (await context.client.query<{ id: string; occurred_at: string; actor: string | null; action: string; revision: number | null; changes: Record<string, unknown> | null }>(`
        SELECT a.id, to_char(a.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, i.display_name AS actor, a.action,
               (a.details->>'revision')::int AS revision, a.details->'changes' AS changes
        FROM audit_log a LEFT JOIN identities i ON i.id=a.identity_id
        WHERE a.tenant_id=$1 AND a.entity_type=$2 AND a.entity_id=$3 AND ($4::timestamptz IS NULL OR (a.occurred_at,a.id)<($4::timestamptz,$5::uuid))
        ORDER BY a.occurred_at DESC,a.id DESC LIMIT 26`, [context.tenantId, source.entityType, request.params.id.toLowerCase(), cursor?.occurred_at ?? null, cursor?.id ?? null])).rows
      const data = rows.slice(0, 25).map(row => ({ id: row.id, occurredAt: row.occurred_at, actor: row.actor, action: row.action, revision: row.revision, changes: row.changes ?? {} }))
      return { tenantId: context.tenantId, entity: request.params.entity, data, nextCursor: rows.length > 25 ? data.at(-1)?.id ?? null : null }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
}
