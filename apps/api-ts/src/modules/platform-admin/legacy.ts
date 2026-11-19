import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AccessDependencies } from "../../platform/access.js"
import { authorizedDomain, invalid, notFound } from "../../platform/domain.js"

const PERMISSION = "platform.legacy.read"
const querySchema = z.strictObject({
  collection: z.string().max(100).optional(),
  offset: z.string().regex(/^\d{1,6}$/).optional(),
  afterCollection: z.string().min(1).max(100).optional(),
  afterId: z.guid().optional(),
})
const inlineTypes = new Set(["image/png", "image/jpeg", "image/webp", "application/xml"])

function attachmentName(raw: string) {
  const ascii = raw.replace(/[^\x20-\x7e]/g, "_").replace(/["\;%]/g, "_").slice(0, 120) || "arquivo"
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw).slice(0, 360)}`
}

export function registerLegacyRoutes(app: FastifyInstance, dependencies: AccessDependencies) {
  app.get("/api/v1/legacy-history", async (request, reply) => {
    reply.header("cache-control", "no-store")
    return authorizedDomain(request, dependencies, PERMISSION, PERMISSION, false, async context => {
      const parsed = querySchema.safeParse(request.query)
      if (!parsed.success) throw invalid("Filtro inválido")
      const query = parsed.data
      const offset = Number(query.offset ?? 0)
      if (offset > 100000) throw invalid("Filtro inválido")
      if ((query.afterCollection === undefined) !== (query.afterId === undefined)
        || (query.afterCollection !== undefined && (offset !== 0 || (query.collection !== undefined && query.collection !== query.afterCollection)))) throw invalid("Cursor inválido")
      const tenant = context.tenantId
      const collections = await context.client.query<{ name: string; count: number | string }>("SELECT collection AS name,count(*) AS count FROM legacy_history WHERE tenant_id=$1 GROUP BY collection ORDER BY collection", [tenant])
      const total = await context.client.query<{ total: string | number }>("SELECT count(*) AS total FROM legacy_history WHERE tenant_id=$1 AND ($2::text IS NULL OR collection=$2)", [tenant, query.collection ?? null])
      const cursor = query.afterId !== undefined
      const rows = await context.client.query<{ record: { id: string; collection: string; title: string; details: unknown; files: unknown[] } }>(
        `SELECT jsonb_build_object('id',h.id,'collection',h.collection,'title',h.title,'details',h.details,
          'files',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'filename',f.filename,'mediaType',f.media_type) ORDER BY f.id)
          FROM legacy_files f WHERE f.tenant_id=h.tenant_id AND f.history_id=h.id),'[]'::jsonb)) AS record
         FROM legacy_history h WHERE h.tenant_id=$1 AND ($2::text IS NULL OR h.collection=$2)
          AND ($3::text IS NULL OR (h.collection,h.id)>($3::text,$4::uuid))
         ORDER BY h.collection,h.id LIMIT 26 OFFSET $5`,
        [tenant, query.collection ?? null, query.afterCollection ?? null, query.afterId ?? null, cursor ? 0 : offset])
      const hasMore = rows.rows.length > 25
      const data = rows.rows.slice(0, 25).map(row => row.record)
      const last = data.at(-1)
      return {
        collections: collections.rows.map(row => ({ name: row.name, count: Number(row.count) })),
        data, total: Number(total.rows[0]!.total), offset, limit: 25,
        nextCursor: hasMore && last ? { collection: last.collection, id: last.id } : null,
      }
    })
  })

  app.get<{ Params: { id: string } }>("/api/v1/legacy-history/files/:id", async (request, reply) => {
    const file = await authorizedDomain(request, dependencies, PERMISSION, PERMISSION, false, async context => {
      if (!z.guid().safeParse(request.params.id).success) throw notFound()
      const result = await context.client.query<{ content: Buffer; media_type: string; filename: string }>("SELECT content,media_type,filename FROM legacy_files WHERE tenant_id=$1 AND id=$2", [context.tenantId, request.params.id.toLowerCase()])
      if (!result.rows[0]) throw notFound()
      return result.rows[0]
    })
    return reply
      .header("content-type", inlineTypes.has(file.media_type) ? file.media_type : "application/octet-stream")
      .header("cache-control", "no-store")
      .header("content-disposition", attachmentName(file.filename))
      .header("x-content-type-options", "nosniff")
      .send(file.content)
  })
}
