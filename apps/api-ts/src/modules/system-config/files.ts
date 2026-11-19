import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AccessDependencies } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { authorizedDomain, conflict, invalid, notFound, staleRevision } from "../../platform/domain.js"
import { parseRevision, revisionValue } from "../../platform/revision.js"
import { hasControl, reply, validId } from "./http.js"

const READ = "system.files.read", MANAGE = "system.files.manage"
const iso = "to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"
const querySchema = z.strictObject({
  q: z.string().optional(), origin: z.string().optional(), status: z.string().optional(),
  offset: z.string().regex(/^-?\d+$/).default("0"), limit: z.string().regex(/^-?\d+$/).default("25"),
})
const filterSql = "($2::text IS NULL OR filename ILIKE '%' || $2 || '%' OR media_type ILIKE '%' || $2 || '%' OR sha256 ILIKE $2 || '%') AND ($3::text IS NULL OR origin=$3) AND ($4::text IS NULL OR status=$4)"

type FileRow = { id: string; origin: string; filename: string; media_type: string; byte_size: number | string; sha256: string; status: string; revision: number | string; version_count: number | string; created_at: string }
const present = (row: FileRow) => ({ id: row.id, origin: row.origin, filename: row.filename, mediaType: row.media_type, byteSize: revisionValue(row.byte_size), sha256: row.sha256, status: row.status, revision: revisionValue(row.revision), versionCount: revisionValue(row.version_count), createdAt: row.created_at })
const safeTypes = ["image/png", "image/jpeg", "image/webp", "application/xml", "application/pdf"]

export function registerFiles(app: FastifyInstance, dependencies: AccessDependencies) {
  app.get("/api/v1/system/files", async (request, response) => {
    const parsed = querySchema.safeParse(request.query)
    if (!parsed.success) throw invalid("Filtros de arquivos inválidos")
    const q = parsed.data.q?.trim() || null
    const { origin = null, status = null } = parsed.data
    const offset = Number(parsed.data.offset), limit = Number(parsed.data.limit)
    if (q && (Buffer.byteLength(q) > 120 || hasControl(q))) throw invalid("Busca de arquivos inválida")
    if (origin && !["system", "legacy"].includes(origin)) throw invalid("Origem de arquivo inválida")
    if (status && !["pending", "available", "quarantined", "archived"].includes(status)) throw invalid("Situação de arquivo inválida")
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid("Paginação inválida")
    const body = await authorizedDomain(request, dependencies, READ, MANAGE, false, async (context, canEdit) => {
      const catalog = `WITH catalog AS (
        SELECT f.id,'system'::text origin,f.original_name filename,f.media_type,f.byte_size,f.sha256,f.status,f.revision,
          (SELECT count(*) FROM system_config.file_versions v WHERE v.tenant_id=f.tenant_id AND v.file_id=f.id) version_count,f.created_at
        FROM system_config.files f WHERE f.tenant_id=$1
        UNION ALL
        SELECT f.id,'legacy',f.filename,f.media_type,octet_length(f.content)::bigint,f.sha256,'available',1,1,h.imported_at
        FROM legacy_files f JOIN legacy_history h ON h.tenant_id=f.tenant_id AND h.id=f.history_id WHERE f.tenant_id=$1)`
      const rows = await context.client.query<FileRow>(`${catalog} SELECT id,origin,filename,media_type,byte_size,sha256,status,revision,version_count,${iso} created_at FROM catalog WHERE ${filterSql} ORDER BY created_at DESC,id DESC LIMIT $5 OFFSET $6`, [context.tenantId, q, origin, status, limit, offset])
      const total = await context.client.query<{ count: string }>(`${catalog} SELECT count(*) FROM catalog WHERE ${filterSql}`, [context.tenantId, q, origin, status])
      return { tenantId: context.tenantId, data: rows.rows.map(present), total: revisionValue(total.rows[0]?.count ?? 0), offset, limit, canEdit }
    })
    return reply(response, 200, body)
  })

  app.post<{ Params: { id: string } }>("/api/v1/system/files/:id/archive", async (request, response) => {
    const expected = parseRevision(request.headers["if-match"])
    const data = await authorizedDomain(request, dependencies, READ, MANAGE, true, async context => {
      const id = request.params.id
      if (!validId(id)) throw notFound()
      const updated = await context.client.query("UPDATE system_config.files SET status='archived',revision=revision+1 WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND status<>'archived' RETURNING id", [context.tenantId, id, expected])
      if (!updated.rows.length) {
        const current = (await context.client.query<{ revision: number | string; status: string }>("SELECT revision,status FROM system_config.files WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])).rows[0]
        if (!current) throw notFound()
        if (current.status === "archived") throw conflict("Arquivo já está arquivado")
        if (BigInt(current.revision) !== BigInt(expected)) throw staleRevision()
        throw conflict("Arquivo não pode ser arquivado")
      }
      await record(context, request.headers, "system_file", id, "system.file.archived", { revision: BigInt(expected) + 1n })
      const row = (await context.client.query<FileRow>(`SELECT id,'system'::text origin,original_name filename,media_type,byte_size,sha256,status,revision,(SELECT count(*) FROM system_config.file_versions v WHERE v.tenant_id=f.tenant_id AND v.file_id=f.id) version_count,${iso} created_at FROM system_config.files f WHERE tenant_id=$1 AND id=$2`, [context.tenantId, id])).rows[0]
      if (!row) throw notFound()
      return present(row)
    })
    return reply(response, 200, { data }, data.revision)
  })

  app.get<{ Params: { id: string } }>("/api/v1/system/files/:id/content", async (request, response) => {
    const row = await authorizedDomain(request, dependencies, READ, MANAGE, false, async context => {
      if (!validId(request.params.id)) throw notFound()
      const found = (await context.client.query<{ content: Buffer; media_type: string; filename: string }>("SELECT content,media_type,filename FROM legacy_files WHERE tenant_id=$1 AND id=$2", [context.tenantId, request.params.id])).rows[0]
      if (!found) throw notFound()
      return found
    })
    // Tipos fora da lista segura são servidos como binário para o navegador nunca interpretá-los.
    const type = safeTypes.includes(row.media_type) ? row.media_type : "application/octet-stream"
    const ascii = row.filename.replace(/[^\x20-\x7e]|["\\%;]/g, "_")
    return response.code(200)
      .header("content-type", type).header("cache-control", "no-store").header("x-content-type-options", "nosniff")
      .header("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
      .send(Buffer.from(row.content))
  })
}
