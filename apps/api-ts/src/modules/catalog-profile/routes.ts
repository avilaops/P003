import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { catalogMediaLimit } from "../../platform/catalog-media.js"
import { record } from "../../platform/commands.js"
import { databaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, revisionValue } from "../../platform/revision.js"
import { storePhoto } from "./images.js"
import { registerCatalogPending } from "./pending.js"

// Product catalog sheet (ficha técnica) and its private photo gallery, ported from the Rust catalog_publication domain.
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/
const invalidSheet = () => new Problem(422, "invalid_input", "Confira linha, grupo e dimensões em milímetros")
const invalidManufacturer = () => new Problem(422, "invalid_input", "Confira os dados do fabricante")
const invalidSource = () => new Problem(422, "invalid_input", "Confira título, endereço HTTPS e páginas da fonte")

const chars = (value: string) => [...value].length
const page = z.number().int().min(1).max(10000).nullable().optional()
const sourceSchema = z.strictObject({ title: z.string(), url: z.string(), pdfPage: page, printedPage: page })
const inputSchema = z.strictObject({
  collection: z.string(),
  muscleGroup: z.string(),
  technicalCategory: z.string(),
  dimensionsMm: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
  description: z.string(),
  weight: z.string(),
  weightStack: z.string(),
  // A deliberate null keeps the legacy photo; absence must never remove media.
  mainMediaId: databaseId.nullable(),
  // Omission preserves metadata written by newer clients; an empty string clears it.
  manufacturer: z.string().optional(),
  manufacturerModel: z.string().optional(),
  catalogProductName: z.string().optional(),
  liveArea: z.string().optional(),
  catalogSources: z.array(sourceSchema).optional(),
  newImage: z.string().nullable().optional(),
})
type CatalogInput = z.infer<typeof inputSchema>

export function validateCatalogInput(raw: unknown): CatalogInput {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success) throw invalidSheet()
  const input = parsed.data
  if (!["core", "premium"].includes(input.collection)
    || [input.muscleGroup, input.technicalCategory].some(value => !value.trim() || chars(value) > 80)
    || input.dimensionsMm.some(value => value < 1 || value > 50000)
    || chars(input.description) > 4000 || chars(input.weight) > 80 || chars(input.weightStack) > 80) throw invalidSheet()
  for (const [key, limit] of [["manufacturer", 80], ["manufacturerModel", 80], ["catalogProductName", 200], ["liveArea", 200]] as const) {
    const value = input[key]
    if (value === undefined) continue
    const trimmed = value.trim()
    if (chars(trimmed) > limit || controlCharacters.test(trimmed)) throw invalidManufacturer()
    input[key] = trimmed
  }
  if (input.catalogSources) {
    if (input.catalogSources.length > 10) throw new Problem(422, "invalid_input", "Cadastre até dez fontes do catálogo")
    for (const source of input.catalogSources) {
      source.title = source.title.trim()
      source.url = source.url.trim()
      let url: URL
      try { url = new URL(source.url) } catch { throw new Problem(422, "invalid_input", "Informe uma fonte HTTPS válida") }
      if (!source.title || chars(source.title) > 160 || controlCharacters.test(source.title) || source.url.length > 2048
        || url.protocol !== "https:" || !url.hostname || url.username || url.password) throw invalidSource()
    }
  }
  return input
}

type ProfileRow = {
  revision: string; collection: string; muscle_group: string; technical_category: string; dimensions_mm: number[]; description: string
  weight: string; weight_stack: string; public_path: string; main_media_id: string | null; manufacturer: string; manufacturer_model: string
  catalog_product_name: string; live_area: string; catalog_sources: unknown
}
const profileColumns = "revision::text AS revision,collection,muscle_group,technical_category,dimensions_mm,description,weight,weight_stack,public_path,main_media_id,manufacturer,manufacturer_model,catalog_product_name,live_area,catalog_sources"
const profileData = (row: ProfileRow) => ({
  revision: revisionValue(row.revision), collection: row.collection, muscleGroup: row.muscle_group, technicalCategory: row.technical_category,
  dimensionsMm: row.dimensions_mm, description: row.description, weight: row.weight, weightStack: row.weight_stack, publicPath: row.public_path,
  mainMediaId: row.main_media_id, manufacturer: row.manufacturer, manufacturerModel: row.manufacturer_model, catalogProductName: row.catalog_product_name,
  liveArea: row.live_area, catalogSources: row.catalog_sources,
})
async function galleryOf(context: AuthorizedContext, productId: string) {
  return (await context.client.query<{ data: unknown[] }>("SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'variant',m.variant,'version',m.version,'width',m.width_px,'height',m.height_px,'mediaType',f.media_type) ORDER BY m.version DESC,m.variant),'[]'::jsonb) AS data FROM product_media_assets m JOIN system_config.files f ON (f.tenant_id,f.id)=(m.tenant_id,m.file_id) WHERE m.tenant_id=$1 AND m.product_id=$2 AND f.status='available'", [context.tenantId, productId])).rows[0]!.data
}
const productIdOf = (value: string) => {
  const parsed = databaseId.safeParse(value)
  if (!parsed.success) throw new Problem(404, "not_found", "Produto não encontrado")
  return parsed.data.toLowerCase()
}

export function registerCatalogProfile(app: FastifyInstance, dependencies: AppDependencies) {
  const configured = (tenantId: string) => dependencies.catalogMedia?.tenantId === tenantId ? dependencies.catalogMedia : undefined
  registerCatalogPending(app, dependencies)

  app.get<{ Params: { id: string } }>("/api/v1/products/:id/catalog", async (request, reply) => {
    const productId = productIdOf(request.params.id)
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      const product = (await context.client.query<{ code: string | null }>("SELECT c.code FROM products p LEFT JOIN product_categories c ON (c.tenant_id,c.id)=(p.tenant_id,p.category_id) WHERE p.tenant_id=$1 AND p.id=$2", [context.tenantId, productId])).rows[0]
      if (!product) throw new Problem(404, "not_found", "Produto não encontrado")
      const row = (await context.client.query<ProfileRow>(`SELECT ${profileColumns} FROM product_catalog_profiles WHERE tenant_id=$1 AND product_id=$2`, [context.tenantId, productId])).rows[0]
      return {
        tenantId: context.tenantId, productId, canEdit: context.permissions.includes("catalog.products.manage"),
        data: row ? profileData(row) : null, assets: await galleryOf(context, productId),
        defaultCollection: product.code === "PREMIUM" ? "premium" : "core", mediaConfigured: configured(context.tenantId) !== undefined,
      }
    }, false)
    return reply.header("cache-control", "no-store").header("etag", `"${body.data?.revision ?? 0}"`).send(body)
  })

  app.put<{ Params: { id: string } }>("/api/v1/products/:id/catalog", { bodyLimit: 14_100_000 }, async (request, reply) => {
    const productId = productIdOf(request.params.id)
    const input = validateCatalogInput(request.body)
    const expected = request.headers["if-match"] === '"0"' ? 0 : parseRevision(request.headers["if-match"])
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      requirePermission(context, "catalog.products.manage")
      // Profile creation and updates are serialized through the existing product row.
      if (!(await context.client.query("SELECT id FROM products WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, productId])).rows[0]) throw new Problem(404, "not_found", "Produto não encontrado")
      const current = (await context.client.query<{ revision: string }>("SELECT revision::text AS revision FROM product_catalog_profiles WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE", [context.tenantId, productId])).rows[0]
      if (BigInt(current?.revision ?? 0) !== BigInt(expected)) throw new Problem(412, "revision_conflict", "A ficha foi alterada por outra pessoa")
      let mainMediaId = input.mainMediaId
      if (input.newImage) {
        const gateway = configured(context.tenantId)
        if (!gateway) throw new Problem(409, "domain_conflict", "Publicação não configurada para esta empresa")
        mainMediaId = await storePhoto(context, gateway, productId, input.collection, input.newImage)
      }
      if (mainMediaId && !(await context.client.query<{ ok: boolean }>("SELECT EXISTS(SELECT 1 FROM product_media_assets m JOIN system_config.files f ON (f.tenant_id,f.id)=(m.tenant_id,m.file_id) WHERE m.tenant_id=$1 AND m.product_id=$2 AND m.id=$3 AND m.variant IN ('webp','black','thumbnail') AND f.status='available') AS ok", [context.tenantId, productId, mainMediaId])).rows[0]!.ok)
        throw new Problem(422, "invalid_input", "Selecione uma imagem de apresentação deste produto")
      const sources = input.catalogSources === undefined ? null : JSON.stringify(input.catalogSources)
      const values = [context.tenantId, productId, input.collection, input.muscleGroup.trim(), input.technicalCategory.trim(), input.dimensionsMm, input.description, input.weight, input.weightStack, mainMediaId]
      if (!current) {
        const publicPath = `/${input.collection === "core" ? "core" : "loja"}/product-${productId}/`
        await context.client.query("INSERT INTO product_catalog_profiles(tenant_id,product_id,collection,muscle_group,technical_category,dimensions_mm,description,weight,weight_stack,main_media_id,public_path,manufacturer,manufacturer_model,catalog_product_name,live_area,catalog_sources) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
          [...values, publicPath, input.manufacturer ?? "", input.manufacturerModel ?? "", input.catalogProductName ?? "", input.liveArea ?? "", sources ?? "[]"])
      } else {
        const changed = await context.client.query("UPDATE product_catalog_profiles SET collection=$3,muscle_group=$4,technical_category=$5,dimensions_mm=$6,description=$7,weight=$8,weight_stack=$9,main_media_id=$10,manufacturer=COALESCE($11,manufacturer),manufacturer_model=COALESCE($12,manufacturer_model),catalog_product_name=COALESCE($13,catalog_product_name),live_area=COALESCE($14,live_area),catalog_sources=COALESCE($15::jsonb,catalog_sources),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND product_id=$2 AND revision=$16 RETURNING product_id",
          [...values, input.manufacturer ?? null, input.manufacturerModel ?? null, input.catalogProductName ?? null, input.liveArea ?? null, sources, String(expected)])
        if (changed.rows.length !== 1) throw new Problem(412, "revision_conflict", "A ficha foi alterada por outra pessoa")
      }
      const revision = revisionValue(BigInt(expected) + 1n)
      await record(context, request.headers, "product", productId, current ? "catalog.profile.updated" : "catalog.profile.created", { revision })
      return { saved: true, revision, mainMediaId }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body)
  })

  app.get<{ Params: { id: string; mediaId: string } }>("/api/v1/products/:id/media/:mediaId", async (request, reply) => {
    const productId = productIdOf(request.params.id)
    const mediaId = databaseId.safeParse(request.params.mediaId)
    if (!mediaId.success) throw new Problem(404, "not_found", "Imagem não encontrada")
    const file = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      const row = (await context.client.query<{ storage_key: string; media_type: string; byte_size: string }>("SELECT f.storage_key,f.media_type,f.byte_size::text AS byte_size FROM product_media_assets m JOIN system_config.files f ON (f.tenant_id,f.id)=(m.tenant_id,m.file_id) WHERE m.tenant_id=$1 AND m.product_id=$2 AND m.id=$3 AND f.status='available'", [context.tenantId, productId, mediaId.data.toLowerCase()])).rows[0]
      if (!row) throw new Problem(404, "not_found", "Imagem não encontrada")
      return { ...row, tenantId: context.tenantId }
    }, false)
    // The private object is read only after the authorization transaction has finished.
    const gateway = configured(file.tenantId)
    if (!gateway) throw new Problem(409, "domain_conflict", "Publicação não configurada para esta empresa")
    const prefix = "r2://ludus-equipamentos-midias/ludus/catalogo/"
    const key = file.storage_key.startsWith(prefix) ? file.storage_key.slice(prefix.length) : ""
    const size = Number(file.byte_size)
    if (!key || key.includes("..") || !/^[A-Za-z0-9/._-]+$/.test(key) || size > catalogMediaLimit) throw new Problem(404, "not_found", "Imagem não encontrada")
    const bytes = await gateway.readPrivate(key)
    if (bytes.byteLength !== size) throw new Problem(409, "domain_conflict", "Tamanho de imagem divergente")
    return reply.header("content-type", file.media_type).header("cache-control", "private, no-store").header("x-content-type-options", "nosniff").send(Buffer.from(bytes))
  })
}
