import { createHash } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record } from "../../platform/commands.js"
import { canonicalJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"

// The explicit publication of the catalog: a preview without prices, then a retryable publish keyed by Idempotency-Key.
async function snapshot(context: AuthorizedContext): Promise<unknown[]> {
  const { rows } = await context.client.query<{ data: unknown[] }>("SELECT COALESCE(jsonb_agg(jsonb_build_object('code',p.sku,'nome',p.name,'colecao',c.collection,'grupo_muscular',c.muscle_group,'linha',c.technical_category,'dim',c.dimensions_mm,'descricao',c.description,'peso',c.weight,'bateria',c.weight_stack,'url',c.public_path,'imageKey',replace(f.storage_key,'r2://ludus-equipamentos-midias/',''),'revision',c.revision) ORDER BY p.sku),'[]'::jsonb) AS data FROM product_catalog_profiles c JOIN products p ON (p.tenant_id,p.id)=(c.tenant_id,c.product_id) JOIN product_media_assets m ON (m.tenant_id,m.id,m.product_id)=(c.tenant_id,c.main_media_id,c.product_id) JOIN system_config.files f ON (f.tenant_id,f.id)=(m.tenant_id,m.file_id) WHERE c.tenant_id=$1 AND p.status='active' AND f.status='available' AND m.variant<>'source'", [context.tenantId])
  return rows[0]!.data
}
const fingerprint = (products: unknown) => createHash("sha256").update(canonicalJson(products)).digest("hex")
const publishSchema = z.strictObject({ previewHash: z.string() })
const configured = (dependencies: AppDependencies, tenantId: string) => dependencies.catalogMedia?.tenantId === tenantId ? dependencies.catalogMedia : undefined

export function registerCatalogPublication(app: FastifyInstance, dependencies: AppDependencies) {
  const url = "/api/v1/catalog-publication"
  app.get(url, async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      const products = await snapshot(context)
      const publication = (await context.client.query("SELECT jsonb_build_object('id',id,'sequence',sequence,'publishedAt',published_at) AS data FROM catalog_publications WHERE tenant_id=$1 AND status='published' ORDER BY sequence DESC LIMIT 1", [context.tenantId])).rows[0]?.data ?? null
      return { tenantId: context.tenantId, canEdit: context.permissions.includes("catalog.products.manage"), configured: configured(dependencies, context.tenantId) !== undefined, previewHash: fingerprint(products), products, publication }
    }, false)
    return reply.header("cache-control", "no-store").send(body)
  })
  app.post(url, async (request, reply) => {
    const key = commandKey(request.headers["idempotency-key"])
    const parsed = publishSchema.safeParse(request.body)
    // First transaction: the exact snapshot is saved before any network I/O, so a retry never publishes a later draft.
    const tenantId = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read"); requirePermission(context, "catalog.products.manage")
      if (!parsed.success) throw new Problem(422, "invalid_input", "Informe o hash da prévia sem campos desconhecidos")
      if (!configured(dependencies, context.tenantId)) throw new Problem(409, "domain_conflict", "Publicação não configurada para esta empresa")
      const old = (await context.client.query<{ snapshot: { products: unknown } }>("SELECT snapshot FROM catalog_publications WHERE tenant_id=$1 AND id=$2", [context.tenantId, key])).rows[0]
      if (old) {
        if (fingerprint(old.snapshot.products) !== parsed.data.previewHash) throw new Problem(409, "domain_conflict", "Esta chave já pertence a outra prévia")
        return context.tenantId
      }
      const products = await snapshot(context)
      if (fingerprint(products) !== parsed.data.previewHash) throw new Problem(409, "domain_conflict", "O catálogo mudou. Revise a prévia antes de publicar")
      if (products.length === 0 || products.length > 1000) throw new Problem(422, "invalid_input", "Catálogo vazio ou acima do limite")
      await context.client.query("INSERT INTO catalog_publications(tenant_id,id,snapshot) VALUES($1,$2,$3)", [context.tenantId, key, { id: key, products }])
      return context.tenantId
    })
    // Second transaction: the pending row stays locked while the Worker is called.
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read"); requirePermission(context, "catalog.products.manage")
      const gateway = configured(dependencies, tenantId) ?? (() => { throw new Problem(409, "domain_conflict", "Publicação não configurada para esta empresa") })()
      const row = (await context.client.query<{ snapshot: Record<string, unknown>; sequence: string; status: string }>("SELECT snapshot,sequence::text AS sequence,status FROM catalog_publications WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, key])).rows[0]!
      const sequence = Number(row.sequence)
      if (row.status !== "published") {
        await gateway.publish({ ...row.snapshot, sequence })
        await context.client.query("UPDATE catalog_publications SET status='published',published_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, key])
        await record(context, request.headers, "catalog", key, "catalog.published", { sequence })
      }
      return { id: key, sequence, published: true }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
}
