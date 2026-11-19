import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue } from "../../platform/revision.js"
import { entityTable, mergeRecords, type MergeEntity } from "./merge.js"
import { findDuplicates } from "./similarity.js"

const entity = z.enum(["party", "product"])
const permission = (kind: MergeEntity, level: "read" | "manage") => `catalog.${kind === "party" ? "parties" : "products"}.${level}`
const SCAN_LIMIT = 3000
const mergeSchema = z.strictObject({ entity, primaryId: normalizedDatabaseId, secondaryId: normalizedDatabaseId, primaryRevision: z.number().int().positive(), secondaryRevision: z.number().int().positive() })
const invalid = (text: string): never => { throw new Problem(422, "invalid_input", text) }

type Row = { id: string; name: string; email: string | null; phone: string | null; status: string; revision: string | number; sku: string | null }
const select: Record<MergeEntity, string> = {
  party: "SELECT id,legal_name AS name,email,phone,status,revision,tax_id AS sku FROM parties WHERE tenant_id=$1 AND status='active' ORDER BY legal_name,id LIMIT $2",
  product: "SELECT id,name,NULL::text AS email,NULL::text AS phone,status,revision,sku FROM products WHERE tenant_id=$1 AND status='active' ORDER BY name,id LIMIT $2",
}
const completeness: Record<MergeEntity, { sql: string; labels: Record<string, string> }> = {
  party: {
    sql: `SELECT id,legal_name AS name,
      array_remove(ARRAY[CASE WHEN jsonb_array_length(addresses)=0 THEN 'address' END, CASE WHEN person_type='juridica' AND fiscal IS NULL THEN 'stateRegistration' END, CASE WHEN email IS NULL AND phone IS NULL THEN 'contact' END],NULL) AS missing
      FROM parties WHERE tenant_id=$1 AND status='active'`,
    labels: { address: "Sem endereço", stateRegistration: "Sem dados fiscais (IE)", contact: "Sem e-mail nem telefone" },
  },
  product: {
    sql: `SELECT id,name,array_remove(ARRAY[CASE WHEN photo_data_url IS NULL THEN 'photo' END, CASE WHEN ncm IS NULL THEN 'ncm' END, CASE WHEN category_id IS NULL THEN 'category' END],NULL) AS missing
      FROM products WHERE tenant_id=$1 AND status='active'`,
    labels: { photo: "Sem foto", ncm: "Sem NCM", category: "Sem categoria" },
  },
}

async function load(context: AuthorizedContext, kind: MergeEntity, id: string) {
  const { rows } = await context.client.query<Row>(`SELECT id,status,revision FROM ${entityTable[kind]} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [context.tenantId, id])
  return rows[0]
}

export function registerDataQualityRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  const root = "/api/v1/data-quality"

  app.get(root + "/:entity/duplicates", async (request, reply) => {
    const parsed = z.strictObject({ entity }).safeParse(request.params)
    if (!parsed.success) return invalid("Tipo de cadastro inválido: use party ou product")
    const kind = parsed.data.entity
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, permission(kind, "read"))
      const { rows } = await context.client.query<Row>(select[kind], [context.tenantId, SCAN_LIMIT + 1])
      const scanned = rows.slice(0, SCAN_LIMIT), byId = new Map(scanned.map(row => [row.id, row]))
      const view = (id: string) => { const row = byId.get(id)!; return { id, name: row.name, code: row.sku, revision: revisionValue(row.revision) } }
      const data = findDuplicates(scanned).map(pair => ({ a: view(pair.a), b: view(pair.b), reasons: pair.reasons, score: pair.score }))
      return { tenantId: context.tenantId, entity: kind, canMerge: context.permissions.includes(permission(kind, "manage")), truncated: rows.length > SCAN_LIMIT, data }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.get(root + "/:entity/completeness", async (request, reply) => {
    const parsed = z.strictObject({ entity }).safeParse(request.params)
    if (!parsed.success) return invalid("Tipo de cadastro inválido: use party ou product")
    const kind = parsed.data.entity
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, permission(kind, "read"))
      const { rows } = await context.client.query<{ id: string; name: string; missing: string[] }>(completeness[kind].sql + " ORDER BY 2,1", [context.tenantId])
      const incomplete = rows.filter(row => row.missing.length > 0)
      const counts = Object.fromEntries(Object.entries(completeness[kind].labels).map(([key, label]) => [key, { label, total: rows.filter(row => row.missing.includes(key)).length }]))
      return { tenantId: context.tenantId, entity: kind, total: rows.length, incomplete: incomplete.length, counts, data: incomplete.slice(0, 100) }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.post(root + "/merge", async (request, reply) => {
    const key = commandKey(request.headers["idempotency-key"])
    const parsed = mergeSchema.safeParse(request.body)
    if (!parsed.success) return invalid("Confira os registros e as revisões informadas")
    const input = parsed.data
    if (input.primaryId === input.secondaryId) return invalid("Escolha dois registros diferentes")
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, permission(input.entity, "manage")); requirePermission(context, permission(input.entity, "read"))
      const scope = "data-quality.merge", saved = await replay(context, key, scope, input)
      if (saved) return saved
      const [primary, secondary] = await Promise.all([load(context, input.entity, input.primaryId), load(context, input.entity, input.secondaryId)])
      if (!primary || !secondary) throw new Problem(404, "not_found", "Registro não encontrado")
      if (revisionValue(primary.revision) !== input.primaryRevision || revisionValue(secondary.revision) !== input.secondaryRevision) throw new Problem(412, "revision_conflict", "Um dos registros foi alterado. Atualize a lista de duplicados")
      if (secondary.status !== "active" || primary.status !== "active") throw new Problem(409, "domain_conflict", "Mescle apenas registros ativos")
      const moved = await mergeRecords(context, input.entity, input.primaryId, input.secondaryId)
      const table = entityTable[input.entity]
      if (input.entity === "party") await context.client.query("UPDATE parties p SET is_customer=p.is_customer OR s.is_customer, is_supplier=p.is_supplier OR s.is_supplier, revision=p.revision+1, updated_at=now() FROM parties s WHERE p.tenant_id=$1 AND s.tenant_id=$1 AND p.id=$2 AND s.id=$3", [context.tenantId, input.primaryId, input.secondaryId])
      await context.client.query(`UPDATE ${table} SET status='archived',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2`, [context.tenantId, input.secondaryId])
      const primaryRevision = revisionValue((await load(context, input.entity, input.primaryId))!.revision)
      const result = { tenantId: context.tenantId, entity: input.entity, primaryId: input.primaryId, secondaryId: input.secondaryId, primaryRevision, moved }
      await record(context, request.headers, input.entity, input.primaryId, `${input.entity}.merged`, { absorbed: input.secondaryId, moved })
      await record(context, request.headers, input.entity, input.secondaryId, `${input.entity}.archived_by_merge`, { into: input.primaryId })
      await remember(context, key, scope, input, result)
      return result
    })
    return reply.header("cache-control", "no-store").header("etag", `"${String((body as { primaryRevision: unknown }).primaryRevision)}"`).send(body)
  })
}
