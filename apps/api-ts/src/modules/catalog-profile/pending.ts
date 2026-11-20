import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"

// Products whose registration still lacks information that only a person can supply (no source, no estimate).
export const pendingFields = ["catalogSheet", "manufacturer", "manufacturerModel", "description", "liveArea", "weight", "dimensions", "photo", "ncm"] as const
export type PendingField = typeof pendingFields[number]

type Row = {
  id: string; sku: string; name: string; ncm: string | null; has_profile: boolean; manufacturer: string | null; manufacturer_model: string | null
  description: string | null; live_area: string | null; weight: string | null; dimensions_mm: number[] | null; has_photo: boolean
}
const blank = (value: string | null) => !value?.trim()

export function missingFields(row: Row): PendingField[] {
  const missing: PendingField[] = []
  if (!row.has_profile) missing.push("catalogSheet")
  if (blank(row.manufacturer)) missing.push("manufacturer")
  if (blank(row.manufacturer_model)) missing.push("manufacturerModel")
  if (blank(row.description)) missing.push("description")
  if (blank(row.live_area)) missing.push("liveArea")
  if (blank(row.weight)) missing.push("weight")
  if (!row.dimensions_mm || row.dimensions_mm.length !== 3 || row.dimensions_mm.some(value => !(value > 0))) missing.push("dimensions")
  if (!row.has_photo) missing.push("photo")
  if (blank(row.ncm)) missing.push("ncm")
  return missing
}

export function registerCatalogPending(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/products/catalog-pending", { exposeHeadRoute: false }, async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      const rows = (await context.client.query<Row>(`SELECT p.id, p.sku, p.name, p.ncm, cp.product_id IS NOT NULL AS has_profile, cp.manufacturer, cp.manufacturer_model,
          cp.description, cp.live_area, cp.weight, cp.dimensions_mm,
          (cp.main_media_id IS NOT NULL OR COALESCE(p.photo_data_url,'')<>'') AS has_photo
        FROM products p LEFT JOIN product_catalog_profiles cp ON (cp.tenant_id,cp.product_id)=(p.tenant_id,p.id)
        WHERE p.tenant_id=$1 AND p.status='active' ORDER BY p.sku, p.id`, [context.tenantId])).rows
      const data = rows.map(row => ({ id: row.id, sku: row.sku, name: row.name, missing: missingFields(row) })).filter(row => row.missing.length > 0)
      const totals = Object.fromEntries(pendingFields.map(field => [field, data.filter(row => row.missing.includes(field)).length]))
      return { tenantId: context.tenantId, canEdit: context.permissions.includes("catalog.products.manage"), activeProducts: rows.length, data, totals }
    }, false)
    return reply.header("cache-control", "no-store").send(body)
  })
}
