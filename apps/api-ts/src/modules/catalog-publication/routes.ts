import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { databaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, revisionValue } from "../../platform/revision.js"
import { catalogMediaFromEnvironment, type CatalogMediaGateway } from "./gateway.js"

export type CatalogPublicationDependencies = AppDependencies & { catalogMedia?: CatalogMediaGateway }

const MAX_IMAGE_BYTES = 20_000_000
const notFound = () => new Problem(404, "not_found", "Registro não encontrado nesta empresa")
const invalid = (title: string) => new Problem(422, "invalid_input", title)
const clean = (value: string) => !/\p{Cc}/u.test(value)
const chars = (value: string) => [...value].length
const optionalText = (limit: number) => z.string().transform(value => value.trim()).refine(value => chars(value) <= limit && clean(value)).optional()
const page = z.number().int().min(1).max(10_000).nullish().transform(value => value ?? null)

const source = z.strictObject({
  title: z.string().transform(value => value.trim()).refine(value => value.length > 0 && chars(value) <= 160 && clean(value)),
  url: z.string().transform(value => value.trim()).refine(value => {
    if (value.length > 2048) return false
    try { const url = new URL(value); return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "" } catch { return false }
  }),
  pdfPage: page, printedPage: page,
})

export const catalogProfileSchema = z.strictObject({
  collection: z.enum(["core", "premium"]),
  muscleGroup: z.string().refine(value => value.trim().length > 0 && chars(value) <= 80),
  technicalCategory: z.string().refine(value => value.trim().length > 0 && chars(value) <= 80),
  dimensionsMm: z.tuple([z.number().int().min(1).max(50_000), z.number().int().min(1).max(50_000), z.number().int().min(1).max(50_000)]),
  description: z.string().refine(value => chars(value) <= 4000),
  weight: z.string().refine(value => chars(value) <= 80),
  weightStack: z.string().refine(value => chars(value) <= 80),
  // A deliberate null keeps the legacy photo; the key itself is mandatory so omission never removes media.
  mainMediaId: databaseId.transform(value => value.toLowerCase()).nullable(),
  manufacturer: optionalText(80), manufacturerModel: optionalText(80),
  catalogProductName: optionalText(200), liveArea: optionalText(200),
  catalogSources: z.array(source).max(10).optional(),
  newImage: z.string().nullish(),
})

function profile(row: Record<string, unknown>) {
  return {
    revision: revisionValue(row.revision), collection: row.collection, muscleGroup: row.muscle_group, technicalCategory: row.technical_category,
    dimensionsMm: row.dimensions_mm, description: row.description, weight: row.weight, weightStack: row.weight_stack, publicPath: row.public_path,
    mainMediaId: row.main_media_id, manufacturer: row.manufacturer, manufacturerModel: row.manufacturer_model,
    catalogProductName: row.catalog_product_name, liveArea: row.live_area, catalogSources: row.catalog_sources,
  }
}

export function registerCatalogPublicationRoutes(app: FastifyInstance, dependencies: CatalogPublicationDependencies) {
  const gateway = () => dependencies.catalogMedia ?? catalogMediaFromEnvironment()
  const configured = (tenant: string) => gateway()?.tenant === tenant

  app.get<{ Params: { id: string } }>("/api/v1/products/:id/catalog", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      if (!databaseId.safeParse(request.params.id).success) throw notFound()
      const id = request.params.id.toLowerCase()
      const product = await context.client.query<{ code: string | null }>("SELECT c.code FROM products p LEFT JOIN product_categories c ON (c.tenant_id,c.id)=(p.tenant_id,p.category_id) WHERE p.tenant_id=$1 AND p.id=$2", [context.tenantId, id])
      if (!product.rows[0]) throw notFound()
      const stored = await context.client.query("SELECT revision,collection,muscle_group,technical_category,dimensions_mm,description,weight,weight_stack,public_path,main_media_id,manufacturer,manufacturer_model,catalog_product_name,live_area,catalog_sources FROM product_catalog_profiles WHERE tenant_id=$1 AND product_id=$2", [context.tenantId, id])
      const assets = await context.client.query<{ assets: unknown }>("SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'variant',m.variant,'version',m.version,'width',m.width_px,'height',m.height_px,'mediaType',f.media_type) ORDER BY m.version DESC,m.variant),'[]'::jsonb) AS assets FROM product_media_assets m JOIN system_config.files f ON (f.tenant_id,f.id)=(m.tenant_id,m.file_id) WHERE m.tenant_id=$1 AND m.product_id=$2 AND f.status='available'", [context.tenantId, id])
      const row = stored.rows[0]
      return {
        revision: row ? revisionValue(row.revision) : 0,
        body: {
          tenantId: context.tenantId, productId: id, canEdit: context.permissions.includes("catalog.products.manage"),
          data: row ? profile(row) : null, assets: assets.rows[0]?.assets ?? [],
          defaultCollection: product.rows[0].code === "PREMIUM" ? "premium" : "core", mediaConfigured: configured(context.tenantId),
        },
      }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body.body)
  })

  app.put<{ Params: { id: string } }>("/api/v1/products/:id/catalog", async (request, reply) => {
    const zero = request.headers["if-match"] === '"0"'
    const expected = zero ? 0 : parseRevision(request.headers["if-match"])
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      requirePermission(context, "catalog.products.manage")
      const parsed = catalogProfileSchema.safeParse(request.body)
      if (!parsed.success) throw invalid("Confira linha, grupo, dimensões e fontes do catálogo")
      if (!databaseId.safeParse(request.params.id).success) throw notFound()
      const id = request.params.id.toLowerCase(), input = parsed.data
      // Serialize profile creation and updates through the existing product row.
      const locked = await context.client.query("SELECT id FROM products WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, id])
      if (!locked.rows[0]) throw notFound()
      const current = (await context.client.query<{ revision: string | number }>("SELECT revision FROM product_catalog_profiles WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE", [context.tenantId, id])).rows[0]
      const stored = current ? revisionValue(current.revision) : 0
      if (stored !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      // Photo processing (resize and R2 upload) is not ported; see the PR notes.
      if (input.newImage) throw invalid("O envio de nova foto ainda não está disponível nesta API")
      if (input.mainMediaId && !(await context.client.query("SELECT 1 FROM product_media_assets m JOIN system_config.files f ON (f.tenant_id,f.id)=(m.tenant_id,m.file_id) WHERE m.tenant_id=$1 AND m.product_id=$2 AND m.id=$3 AND m.variant IN ('webp','black','thumbnail') AND f.status='available'", [context.tenantId, id, input.mainMediaId])).rows[0]) throw invalid("Selecione uma imagem de apresentação deste produto")
      const sources = input.catalogSources ? JSON.stringify(input.catalogSources) : null
      const group = input.muscleGroup.trim(), category = input.technicalCategory.trim()
      const next = Number(expected) + 1
      if (!current) {
        const path = `/${input.collection === "core" ? "core" : "loja"}/product-${id}/`
        await context.client.query("INSERT INTO product_catalog_profiles(tenant_id,product_id,collection,muscle_group,technical_category,dimensions_mm,description,weight,weight_stack,main_media_id,public_path,manufacturer,manufacturer_model,catalog_product_name,live_area,catalog_sources) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
          [context.tenantId, id, input.collection, group, category, input.dimensionsMm, input.description, input.weight, input.weightStack, input.mainMediaId, path, input.manufacturer ?? "", input.manufacturerModel ?? "", input.catalogProductName ?? "", input.liveArea ?? "", sources ?? "[]"])
      } else {
        await context.client.query("UPDATE product_catalog_profiles SET collection=$4,muscle_group=$5,technical_category=$6,dimensions_mm=$7,description=$8,weight=$9,weight_stack=$10,main_media_id=$11,manufacturer=COALESCE($12,manufacturer),manufacturer_model=COALESCE($13,manufacturer_model),catalog_product_name=COALESCE($14,catalog_product_name),live_area=COALESCE($15,live_area),catalog_sources=COALESCE($16::jsonb,catalog_sources),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND product_id=$2 AND revision=$3",
          [context.tenantId, id, expected, input.collection, group, category, input.dimensionsMm, input.description, input.weight, input.weightStack, input.mainMediaId, input.manufacturer ?? null, input.manufacturerModel ?? null, input.catalogProductName ?? null, input.liveArea ?? null, sources])
      }
      await record(context, request.headers, "product", id, current ? "catalog.profile.updated" : "catalog.profile.created", { revision: next })
      return { saved: true, revision: next, mainMediaId: input.mainMediaId }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body)
  })

  app.get<{ Params: { id: string; media_id: string } }>("/api/v1/products/:id/media/:media_id", async (request, reply) => {
    const file = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      if (!databaseId.safeParse(request.params.id).success || !databaseId.safeParse(request.params.media_id).success) throw notFound()
      const found = await context.client.query<{ storage_key: string; media_type: string; byte_size: string | number }>("SELECT f.storage_key,f.media_type,f.byte_size FROM product_media_assets m JOIN system_config.files f ON (f.tenant_id,f.id)=(m.tenant_id,m.file_id) WHERE m.tenant_id=$1 AND m.product_id=$2 AND m.id=$3 AND f.status='available'", [context.tenantId, request.params.id.toLowerCase(), request.params.media_id.toLowerCase()])
      if (!found.rows[0]) throw notFound()
      return { key: found.rows[0].storage_key, mediaType: found.rows[0].media_type, size: Number(found.rows[0].byte_size), tenant: context.tenantId }
    })
    const media = gateway()
    if (!media || media.tenant !== file.tenant) throw new Problem(409, "domain_conflict", "Publicação não configurada para esta empresa")
    const key = file.key.startsWith("r2://ludus-equipamentos-midias/ludus/catalogo/") ? file.key.slice("r2://ludus-equipamentos-midias/ludus/catalogo/".length) : undefined
    if (key === undefined || key.includes("..") || !/^[A-Za-z0-9/._-]*$/.test(key) || file.size > MAX_IMAGE_BYTES) throw notFound()
    const bytes = await media.readPrivate(key, MAX_IMAGE_BYTES).catch(() => { throw new Problem(409, "domain_conflict", "Imagem temporariamente indisponível") })
    if (bytes.length !== file.size) throw new Problem(409, "domain_conflict", "Tamanho de imagem divergente")
    return reply.header("content-type", file.mediaType).header("cache-control", "private, no-store").header("x-content-type-options", "nosniff").send(bytes)
  })
}
