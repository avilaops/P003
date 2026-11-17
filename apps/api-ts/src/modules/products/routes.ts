import { revisionValue, nextRevision, parseRevision as revision } from "../../platform/revision.js"
import { randomUUID } from "node:crypto"

import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { sameJson } from "../../platform/json.js"
import { integer } from "../registrations/query.js"
import { productInputSchema, materialize, type ProductInput as Input } from "./schema.js"

const querySchema = z.strictObject({
  q: z.string().max(160).default(""), status: z.enum(["active", "archived"]).optional(),
  category_id: z.guid().optional(), offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})


function one(value: string | string[] | undefined) { return Array.isArray(value) ? undefined : value }
function command(value: string | string[] | undefined) { if (!value) throw new Problem(428, "idempotency_required", "Informe a chave de idempotência"); const parsed = z.guid().safeParse(one(value)); if (!parsed.success) throw new Problem(422, "invalid_input", "Chave de idempotência inválida"); return parsed.data }
function cents(value: string) { const [whole, fraction = ""] = value.split("."); return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0")) }

const projection = "(SELECT main_media_id FROM product_catalog_profiles WHERE tenant_id=products.tenant_id AND product_id=products.id) AS main_media_id,COALESCE((SELECT (data->>'upholsteryConfigurable')::boolean FROM registration_settings WHERE tenant_id=products.tenant_id AND section='products'),true) AS upholstery_configurable,id,sku,name,unit,ncm,cest,price_cents,status,revision,category_id,structure_colors,swing_arm_colors,finishing_palette,upholstery_colors,plate_holder_colors,plate_holder_types,plate_holder_type,photo_data_url,(COALESCE(photo_data_url,'')<>'' OR EXISTS(SELECT 1 FROM product_catalog_profiles WHERE tenant_id=products.tenant_id AND product_id=products.id AND main_media_id IS NOT NULL)) AS has_photo"

function price(cents: unknown) {
  const value = BigInt(String(cents))
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`
}

function product(row: Record<string, unknown>) {
  const types = Array.isArray(row.plate_holder_types) ? [...row.plate_holder_types] as string[] : []
  if (types.length === 0 && row.plate_holder_type === "standard") types.push("Standard")
  if (types.length === 0 && row.plate_holder_type === "olympic") types.push("Olímpico")
  const legacy = types.length === 1 ? types[0] === "Standard" ? "standard" : types[0] === "Olímpico" ? "olympic" : null : null
  return {
    photoUrl: row.main_media_id ? `/api/erp/products/${String(row.id)}/media/${String(row.main_media_id)}` : null,
    upholsteryConfigurable: row.upholstery_configurable, id: row.id, revision: revisionValue(row.revision),
    hasPhoto: row.has_photo, ...(row.category_id ? { categoryId: String(row.category_id) } : {}),
    ...(row.photo_data_url == null ? {} : { photoDataUrl: row.photo_data_url }), sku: row.sku, name: row.name, unit: row.unit,
    ncm: row.ncm, cest: row.cest, basePrice: price(row.price_cents), status: row.status,
    structureColors: row.structure_colors ?? [], swingArmColors: row.swing_arm_colors ?? [],
    finishingPalette: row.finishing_palette ?? "", upholsteryColors: row.upholstery_colors ?? [],
    plateHolderColors: row.plate_holder_colors ?? [], plateHolderTypes: types, ...(legacy === null ? {} : { plateHolderType: legacy }),
  }
}

export function registerProductRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/products", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query)
    if (!parsed.success) throw new Problem(422, "invalid_input", "Filtros inválidos")
    const query = { ...parsed.data, q: parsed.data.q.trim() }
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      const rows = await context.client.query("SELECT (SELECT main_media_id FROM product_catalog_profiles WHERE tenant_id=products.tenant_id AND product_id=products.id) AS main_media_id,COALESCE((SELECT (data->>'upholsteryConfigurable')::boolean FROM registration_settings WHERE tenant_id=products.tenant_id AND section='products'),true) AS upholstery_configurable,id,sku,name,unit,ncm,cest,price_cents,status,revision,category_id,structure_colors,swing_arm_colors,finishing_palette,upholstery_colors,plate_holder_colors,plate_holder_types,plate_holder_type,NULL::text AS photo_data_url,(COALESCE(photo_data_url,'')<>'' OR EXISTS(SELECT 1 FROM product_catalog_profiles WHERE tenant_id=products.tenant_id AND product_id=products.id AND main_media_id IS NOT NULL)) AS has_photo FROM products WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND (strpos(lower(name),lower($3))>0 OR strpos(lower(sku),lower($3))>0) AND ($6::uuid IS NULL OR category_id=$6) ORDER BY name,id LIMIT $4 OFFSET $5", [context.tenantId, query.status ?? null, query.q, query.limit, query.offset, query.category_id ?? null])
      const settings = await context.client.query<{ data: { upholsteryConfigurable?: boolean } }>("SELECT data FROM registration_settings WHERE tenant_id=$1 AND section='products'", [context.tenantId])
      const count = await context.client.query<{ total: string }>("SELECT count(*)::text AS total FROM products WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND (strpos(lower(name),lower($3))>0 OR strpos(lower(sku),lower($3))>0) AND ($4::uuid IS NULL OR category_id=$4)", [context.tenantId, query.status ?? null, query.q, query.category_id ?? null])
      return { upholsteryConfigurable: settings.rows[0]?.data.upholsteryConfigurable !== false, tenantId: context.tenantId, canEdit: context.permissions.includes("catalog.products.manage"), data: rows.rows.map(product), total: integer(count.rows[0]?.total ?? 0), offset: query.offset, limit: query.limit }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.get<{ Params: { id: string } }>("/api/v1/products/:id", async (request, reply) => {
    if (!z.guid().safeParse(request.params.id).success) throw new Problem(404, "not_found", "Produto não encontrado")
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      const loaded = await context.client.query(`SELECT ${projection} FROM products WHERE tenant_id=$1 AND id=$2`, [context.tenantId, request.params.id])
      if (!loaded.rows[0]) throw new Problem(404, "not_found", "Produto não encontrado")
      return { tenantId: context.tenantId, canEdit: context.permissions.includes("catalog.products.manage"), data: product(loaded.rows[0]) }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })

  app.post("/api/v1/products", { bodyLimit: 2_097_152 }, async (request, reply) => {
    const key = command(request.headers["idempotency-key"]), parsed = productInputSchema.safeParse(request.body)
    if (!parsed.success) throw new Problem(422, "invalid_input", "Cadastro inválido ou campos desconhecidos")
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.manage")
      requirePermission(context, "catalog.products.read")
      const input = parsed.data, requestData = input
      const replay = await context.client.query<{ scope: string; request: unknown; result: Record<string, unknown> }>("SELECT scope,request,result FROM domain_commands WHERE tenant_id=$1 AND auth_subject=$2 AND command_key=$3", [context.tenantId, context.identity.subject, key])
      if (replay.rows[0]) { if (replay.rows[0].scope !== "product.create" || !sameJson(replay.rows[0].request, requestData)) throw new Problem(409, "domain_conflict", "Esta chave de idempotência já foi usada com outros dados"); return replay.rows[0].result }
      await validateSettings(context, input)
      const id = randomUUID(), data = materialize(input)
      await validateCategory(context, data.categoryId)
      await context.client.query("INSERT INTO products(id,tenant_id,sku,name,unit,ncm,cest,price_cents,status,structure_colors,upholstery_colors,plate_holder_colors,plate_holder_types,plate_holder_type,photo_data_url,category_id,swing_arm_colors,finishing_palette) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)", [id, context.tenantId, data.sku, data.name, data.unit, data.ncm, data.cest, cents(data.basePrice).toString(), data.status, data.structureColors, data.upholsteryColors, data.plateHolderColors, data.plateHolderTypes, legacyType(data.plateHolderTypes), data.photoDataUrl, data.categoryId, data.swingArmColors, data.finishingPalette])
      const loaded = await context.client.query(`SELECT ${projection} FROM products WHERE tenant_id=$1 AND id=$2`, [context.tenantId, id])
      const result = { tenantId: context.tenantId, canEdit: true, data: product(loaded.rows[0]!) }
      await context.client.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,entity_id,request_id,details) SELECT $1,id,'product.created','product',$3,$4,$5 FROM identities WHERE auth_subject=$2", [context.tenantId, context.identity.subject, id, one(request.headers["x-request-id"]) ?? null, { revision: 1, sku: data.sku }])
      await context.client.query("INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'product',$2,'product.created',$3)", [context.tenantId, id, { revision: 1, sku: data.sku }])
      await context.client.query("INSERT INTO domain_commands(tenant_id,auth_subject,command_key,scope,request,result) VALUES($1,$2,$3,'product.create',$4,$5)", [context.tenantId, context.identity.subject, key, requestData, result])
      return result
    })
    return reply.code(201).header("cache-control", "no-store").header("etag", `"${(body.data as { revision: number }).revision}"`).send(body)
  })

  app.put<{ Params: { id: string } }>("/api/v1/products/:id", { bodyLimit: 2_097_152 }, async (request, reply) => {
    const expected = revision(request.headers["if-match"]), parsed = productInputSchema.safeParse(request.body)
    if (!parsed.success || !z.guid().safeParse(request.params.id).success) throw new Problem(422, "invalid_input", "Cadastro inválido ou campos desconhecidos")
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.manage")
      requirePermission(context, "catalog.products.read")
      await validateSettings(context, parsed.data)
      const loaded = await context.client.query(`SELECT ${projection} FROM products WHERE tenant_id=$1 AND id=$2`, [context.tenantId, request.params.id])
      if (!loaded.rows[0]) throw new Problem(404, "not_found", "Produto não encontrado")
      const previous = product(loaded.rows[0]) as Record<string, unknown>
      if (revisionValue(previous.revision) !== expected) throw new Problem(412, "revision_conflict", "O produto foi alterado por outra pessoa")
      const data = materialize({ ...parsed.data, categoryId: parsed.data.categoryId ?? previous.categoryId as string | undefined, photoDataUrl: parsed.data.photoDataUrl ?? previous.photoDataUrl as string | undefined, structureColors: parsed.data.structureColors ?? previous.structureColors as string[], swingArmColors: parsed.data.swingArmColors ?? previous.swingArmColors as string[], finishingPalette: parsed.data.finishingPalette ?? previous.finishingPalette as "" | "dhz-hammerforce-pro" | "dhz-sforce" | "dhz-combined", upholsteryColors: parsed.data.upholsteryColors ?? previous.upholsteryColors as string[], plateHolderColors: parsed.data.plateHolderColors ?? previous.plateHolderColors as string[], plateHolderTypes: parsed.data.plateHolderTypes ?? previous.plateHolderTypes as string[] })
      if (data.categoryId !== (previous.categoryId ?? null)) await validateCategory(context, data.categoryId)
      if (data.unit !== previous.unit) { const movement = await context.client.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM stock_movements WHERE tenant_id=$1 AND product_id=$2) AS exists", [context.tenantId, request.params.id]); if (movement.rows[0]?.exists) throw new Problem(409, "domain_conflict", "Unidade não pode mudar após movimentação de estoque") }
      if (data.status === "archived") { const balance = await context.client.query<{ quantity: string }>("SELECT COALESCE((SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2),0)::text AS quantity", [context.tenantId, request.params.id]); if (balance.rows[0]?.quantity !== undefined && balance.rows[0].quantity !== "0") throw new Problem(409, "domain_conflict", "Regularize o saldo antes de arquivar o produto") }
      await context.client.query("UPDATE products SET sku=$3,name=$4,unit=$5,ncm=$6,cest=$7,price_cents=$8,status=$9,revision=$10,structure_colors=$11,upholstery_colors=$12,plate_holder_colors=$13,plate_holder_types=$14,plate_holder_type=$15,photo_data_url=$16,category_id=$17,swing_arm_colors=$18,finishing_palette=$19,updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, request.params.id, data.sku, data.name, data.unit, data.ncm, data.cest, cents(data.basePrice).toString(), data.status, nextRevision(expected), data.structureColors, data.upholsteryColors, data.plateHolderColors, data.plateHolderTypes, legacyType(data.plateHolderTypes), data.photoDataUrl, data.categoryId, data.swingArmColors, data.finishingPalette])
      const next = await context.client.query(`SELECT ${projection} FROM products WHERE tenant_id=$1 AND id=$2`, [context.tenantId, request.params.id])
      await context.client.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,entity_id,request_id,details) SELECT $1,id,'product.updated','product',$3,$4,$5 FROM identities WHERE auth_subject=$2", [context.tenantId, context.identity.subject, request.params.id, one(request.headers["x-request-id"]) ?? null, { previousRevision: expected, revision: nextRevision(expected) }])
      await context.client.query("INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'product',$2,'product.updated',$3)", [context.tenantId, request.params.id, { previousRevision: expected, revision: nextRevision(expected) }])
      return { tenantId: context.tenantId, canEdit: true, data: product(next.rows[0]!) }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })
}
function legacyType(types: readonly string[]) { return types.length === 1 ? types[0] === "Standard" ? "standard" : types[0] === "Olímpico" ? "olympic" : "" : "" }
async function validateCategory(context: Parameters<Parameters<typeof authorizeRequest>[2]>[0], id: string | null) { if (!id) return; const found = await context.client.query("SELECT 1 AS found FROM product_categories WHERE tenant_id=$1 AND id=$2 AND status='active'", [context.tenantId, id]); if (!found.rows[0]) throw new Problem(422, "invalid_input", "Categoria inválida ou arquivada") }
async function validateSettings(context: Parameters<Parameters<typeof authorizeRequest>[2]>[0], input: Pick<Input, "ncm" | "cest" | "upholsteryColors">) { const result = await context.client.query<{ data: { requireNcm?: boolean; requireCest?: boolean; upholsteryConfigurable?: boolean } }>("SELECT data FROM registration_settings WHERE tenant_id=$1 AND section='products'", [context.tenantId]); const settings = result.rows[0]?.data ?? {}; if (settings.requireNcm && !input.ncm || settings.requireCest && !input.cest || settings.upholsteryConfigurable === false && input.upholsteryColors?.length) throw new Problem(422, "invalid_input", "Cadastro incompatível com as configurações da empresa") }
