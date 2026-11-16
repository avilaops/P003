import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { integer } from "../registrations/query.js"
import { orderSummary, queryInput } from "../sales/shared.js"
import { loadCheckout } from "./checkout.js"

const summary = "SELECT id,number::text AS number,customer_id,customer_name,customer_tax_id,due_date::text AS due_date,(amount_cents::numeric/100)::numeric(16,2)::text AS amount,status,revision,to_json(updated_at)#>>'{}' AS updated_at,(EXISTS(SELECT 1 FROM order_pricing_snapshots s WHERE s.tenant_id=sales_orders.tenant_id AND s.order_id=sales_orders.id) OR EXISTS(SELECT 1 FROM commercial_order_quotes q WHERE q.tenant_id=sales_orders.tenant_id AND q.order_id=sales_orders.id)) AS pricing_origin FROM sales_orders"

export function registerOrderRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get<{ Params: { id: string } }>("/api/v1/orders/:id", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read")
      if (!z.string().uuid().safeParse(request.params.id).success) throw new Problem(422, "invalid_input", "Identificador inválido")
      const row = await context.client.query(`${summary} WHERE tenant_id=$1 AND id=$2`, [context.tenantId, request.params.id])
      if (!row.rows[0]) throw new Problem(404, "not_found", "Pedido não encontrado")
      const data = orderSummary(row.rows[0])
      const lines = await context.client.query("SELECT product_id,sku,name,unit,(quantity_micros::numeric/1000000)::numeric(19,6)::text AS quantity,(price_cents::numeric/100)::numeric(16,2)::text AS unit_price,(amount_cents::numeric/100)::numeric(16,2)::text AS amount,structure_color,swing_arm_color,plate_holder_color,plate_holder_type,upholstery_color,(SELECT c.weight FROM product_catalog_profiles c WHERE c.tenant_id=sales_order_lines.tenant_id AND c.product_id=sales_order_lines.product_id) AS equipment_weight FROM sales_order_lines WHERE tenant_id=$1 AND order_id=$2 ORDER BY line_number", [context.tenantId, request.params.id])
      const items = lines.rows.map(item => ({
        productId: item.product_id, sku: item.sku, name: item.name, unit: item.unit, quantity: item.quantity, unitPrice: item.unit_price, amount: item.amount, equipmentWeight: item.equipment_weight,
        ...(item.structure_color == null ? {} : { structureColor: item.structure_color }),
        ...(item.swing_arm_color == null ? {} : { swingArmColor: item.swing_arm_color }),
        ...(item.plate_holder_color == null ? {} : { plateHolderColor: item.plate_holder_color }),
        ...(item.plate_holder_type == null ? {} : { plateHolderType: item.plate_holder_type }),
        ...(item.upholstery_color == null ? {} : { upholsteryColor: item.upholstery_color }),
      }))
      const checkout = await loadCheckout(context, request.params.id)
      return { tenantId: context.tenantId, canEdit: context.permissions.includes("sales.orders.manage"), pricingOrigin: data.pricingOrigin, data, items, ...(checkout ? { checkout } : {}) }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })
  app.get("/api/v1/orders", async (request, reply) => {
    const query = queryInput(request.query, ["", "draft", "accepted", "confirmed", "completed", "cancelled"])
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read")
      const digits = /^[\d.\-/ ]*$/.test(query.q) ? query.q.replace(/\D/g, "") : ""
      const normalized = query.q.toUpperCase(), number = Number((normalized.startsWith("PV-") ? normalized.slice(3) : normalized)) || null
      const filter = "WHERE tenant_id=$1 AND ($2='' OR strpos(lower(customer_name),lower($2))>0 OR strpos(id::text,lower($2))>0 OR ($3<>'' AND strpos(customer_tax_id,$3)>0) OR number=$4) AND ($5='' OR status=$5)"
      const order = query.sort === "updated" ? "sales_orders.updated_at DESC,sales_orders.id DESC" : "sales_orders.created_at DESC,sales_orders.id DESC"
      const rows = await context.client.query(`${summary} ${filter} ORDER BY ${order} LIMIT $6 OFFSET $7`, [context.tenantId, query.q, digits, number, query.status, query.limit, query.offset])
      const count = await context.client.query<{ total: string }>(`SELECT count(*)::text AS total FROM sales_orders ${filter}`, [context.tenantId, query.q, digits, number, query.status])
      return { tenantId: context.tenantId, canEdit: context.permissions.includes("sales.orders.manage"), data: rows.rows.map(orderSummary), total: integer(count.rows[0]?.total ?? 0), offset: query.offset, limit: query.limit }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
}
