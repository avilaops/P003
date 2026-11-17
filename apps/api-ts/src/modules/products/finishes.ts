import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"

const maxIds = 100
const guidLength = 36
const querySchema = z.strictObject({
  ids: z.string().max(maxIds * (guidLength + 1) - 1)
    .transform(value => value.split(","))
    .pipe(z.array(z.string().length(guidLength).pipe(normalizedDatabaseId)).min(1).max(maxIds))
    .transform(ids => [...new Set(ids)]),
})

type FinishRow = {
  id: string
  name: string
  structure_colors: string[]
  swing_arm_colors: string[]
  finishing_palette: string
  upholstery_colors: string[]
  upholstery_configurable: boolean
  plate_holder_colors: string[]
  plate_holder_types: string[]
  plate_holder_type: string
  weight: string | null
}

export function productPlateHolderTypes(options: unknown, legacyType: unknown): string[] {
  const types = Array.isArray(options) ? [...options] as string[] : []
  if (types.length === 0 && legacyType === "standard") types.push("Standard")
  if (types.length === 0 && legacyType === "olympic") types.push("Olímpico")
  return types
}

export function registerProductFinishesRoute(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/products/finishes", { exposeHeadRoute: false }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query)
    if (!parsed.success) throw new Problem(422, "invalid_input", "Informe de 1 a 100 identificadores válidos de produtos")
    const { ids } = parsed.data

    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.products.read")
      const { rows } = await context.client.query<FinishRow>(`
        SELECT product.id, product.name, product.structure_colors, product.swing_arm_colors,
          product.finishing_palette, product.upholstery_colors, product.plate_holder_colors,
          product.plate_holder_types, product.plate_holder_type, profile.weight,
          COALESCE((settings.data->>'upholsteryConfigurable')::boolean, true) AS upholstery_configurable
        FROM products product
        LEFT JOIN product_catalog_profiles profile
          ON profile.tenant_id=product.tenant_id AND profile.product_id=product.id
        LEFT JOIN registration_settings settings
          ON settings.tenant_id=product.tenant_id AND settings.section='products'
        WHERE product.tenant_id=$1 AND product.id=ANY($2::uuid[])
        ORDER BY array_position($2::uuid[], product.id)
      `, [context.tenantId, ids])
      const found = new Set(rows.map(row => row.id))
      return {
        tenantId: context.tenantId,
        data: rows.map(row => ({
          id: row.id,
          name: row.name,
          structureColors: row.structure_colors,
          swingArmColors: row.swing_arm_colors,
          finishingPalette: row.finishing_palette,
          upholsteryColors: row.upholstery_colors,
          upholsteryConfigurable: row.upholstery_configurable,
          plateHolderColors: row.plate_holder_colors,
          plateHolderTypes: productPlateHolderTypes(row.plate_holder_types, row.plate_holder_type),
          weight: row.weight,
        })),
        missingIds: ids.filter(id => !found.has(id)),
      }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
}
