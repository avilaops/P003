import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { integer } from "../registrations/query.js"

const querySchema = z.strictObject({
  q: z.string().max(160).default(""), status: z.enum(["active", "archived"]).optional(),
  category_id: z.string().uuid().optional(), offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

function price(cents: unknown) {
  const value = BigInt(String(cents))
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`
}

function product(row: Record<string, unknown>) {
  const types = Array.isArray(row.plate_holder_types) ? row.plate_holder_types as string[] : []
  const legacy = types.length === 1 ? types[0] === "Standard" ? "standard" : types[0] === "Olímpico" ? "olympic" : null : null
  return {
    photoUrl: row.main_media_id ? `/api/erp/products/${String(row.id)}/media/${String(row.main_media_id)}` : null,
    upholsteryConfigurable: row.upholstery_configurable, id: row.id, revision: integer(row.revision),
    hasPhoto: row.has_photo, categoryId: row.category_id ? String(row.category_id) : null,
    photoDataUrl: row.photo_data_url, sku: row.sku, name: row.name, unit: row.unit,
    ncm: row.ncm, cest: row.cest, basePrice: price(row.price_cents), status: row.status,
    structureColors: row.structure_colors ?? [], swingArmColors: row.swing_arm_colors ?? [],
    finishingPalette: row.finishing_palette ?? "", upholsteryColors: row.upholstery_colors ?? [],
    plateHolderColors: row.plate_holder_colors ?? [], plateHolderTypes: types, plateHolderType: legacy,
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
}
