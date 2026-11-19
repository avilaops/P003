import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AccessDependencies } from "../../platform/access.js"
import { authorizedDomain, invalid } from "../../platform/domain.js"
import { registerLegacyRoutes } from "./legacy.js"
import { registerMailSettingsRoutes, type MailSettingsIO } from "./mail-settings.js"
import { buildOpenApiDocument } from "../../platform/openapi.js"
import { registerServiceKeyRoutes } from "./service-keys.js"

export type PlatformAdminDependencies = { mail?: MailSettingsIO }

const control = /[\u0000-\u001f\u007f-\u009f]/
const filter = z.string().max(120).refine(value => Buffer.byteLength(value) <= 120 && !control.test(value))
const auditQuery = z.strictObject({
  q: filter.optional(), action: filter.optional(), entity: filter.optional(), category: z.string().optional(),
  startDate: z.string().optional(), endDate: z.string().optional(), before: z.guid().optional(),
})

function day(value: string | undefined) {
  if (value === undefined) return null
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const date = parsed && new Date(Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3])))
  if (!parsed || !date || date.toISOString().slice(0, 10) !== value) throw invalid("Data inválida; use AAAA-MM-DD")
  return value
}

export function registerPlatformAdminRoutes(app: FastifyInstance, dependencies: AccessDependencies, io: PlatformAdminDependencies = {}) {
  const ready = async (reply: { code(status: number): unknown }) => {
    const client = await dependencies.pool.connect().catch(() => undefined)
    if (!client) return false
    try { await client.query("SELECT 1"); return true } catch { return false } finally { client.release() }
  }
  // Público, como no Rust: alias da prontidão (consulta o banco).
  app.get("/api/health", async (_request, reply) => {
    reply.header("cache-control", "no-store")
    return (await ready(reply)) ? { status: "ready" } : reply.code(503).send({ status: "unavailable" })
  })

  let document: unknown
  app.get("/openapi.json", async () => document ??= buildOpenApiDocument(app))

  app.get("/api/v1/permissions", async (request, reply) => {
    reply.header("cache-control", "no-store")
    return authorizedDomain(request, dependencies, "platform.roles.read", "platform.roles.read", false, async context => ({
      data: (await context.client.query<{ code: string; description: string }>("SELECT code, description FROM permissions ORDER BY code")).rows,
    }))
  })

  app.get("/api/v1/audit", async (request, reply) => {
    reply.header("cache-control", "no-store")
    return authorizedDomain(request, dependencies, "platform.audit.read", "platform.audit.read", false, async context => {
      const parsed = auditQuery.safeParse(request.query)
      if (!parsed.success) throw invalid("Filtros de auditoria inválidos")
      const query = parsed.data
      if (query.category !== undefined && query.category !== "deletions") throw invalid("Categoria de auditoria inválida")
      const start = day(query.startDate), end = day(query.endDate)
      if (start && end && start > end) throw invalid("Data final deve ser igual ou posterior à inicial")
      let cursor: { occurred_at: Date; id: string } | undefined
      if (query.before) {
        cursor = (await context.client.query<{ occurred_at: Date; id: string }>("SELECT occurred_at,id FROM audit_log WHERE tenant_id=$1 AND id=$2", [context.tenantId, query.before.toLowerCase()])).rows[0]
        if (!cursor) throw invalid("Página de auditoria inválida; atualize a consulta")
      }
      // Projeção deliberada: detalhes, identificadores da entidade e metadados da requisição não saem daqui.
      const rows = (await context.client.query<{ id: string; occurred_at: string; actor: string | null; action: string; entity_type: string }>(`
        SELECT a.id, to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
            i.display_name AS actor, a.action, a.entity_type
        FROM audit_log a LEFT JOIN identities i ON i.id=a.identity_id
        WHERE a.tenant_id=$1
          AND ($2::text IS NULL OR strpos(lower(a.action || ' ' || a.entity_type || ' ' || coalesce(i.display_name,'')),lower($2))>0)
          AND ($3::text IS NULL OR a.action=$3)
          AND ($4::text IS NULL OR a.entity_type=$4)
          AND ($5::date IS NULL OR a.occurred_at >= ($5::date::timestamp AT TIME ZONE 'UTC'))
          AND ($6::date IS NULL OR a.occurred_at < (($6::date + 1)::timestamp AT TIME ZONE 'UTC'))
          AND ($7::timestamptz IS NULL OR (a.occurred_at,a.id)<($7::timestamptz,$8::uuid))
          AND ($9::text IS NULL OR ($9='deletions' AND (a.action LIKE '%.deleted' OR a.action LIKE '%.removed')))
        ORDER BY a.occurred_at DESC,a.id DESC LIMIT 26`,
      [context.tenantId, query.q || null, query.action || null, query.entity || null, start, end, cursor?.occurred_at ?? null, cursor?.id ?? null, query.category ?? null])).rows
      const more = rows.length > 25
      const data = rows.slice(0, 25).map(row => ({ id: row.id, occurredAt: row.occurred_at, actor: row.actor, action: row.action, entityType: row.entity_type }))
      return { tenantId: context.tenantId, data, nextCursor: more ? data.at(-1)?.id ?? null : null }
    })
  })

  registerMailSettingsRoutes(app, dependencies, io.mail)
  registerServiceKeyRoutes(app, dependencies)
  registerLegacyRoutes(app, dependencies)
}
