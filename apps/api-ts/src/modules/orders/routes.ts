import type { FastifyInstance } from "fastify"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { integer } from "../registrations/query.js"
import { orderSummary, queryInput } from "../sales/shared.js"

const summary = "SELECT id,number::text AS number,customer_id,customer_name,customer_tax_id,due_date::text AS due_date,(amount_cents::numeric/100)::numeric(16,2)::text AS amount,status,revision,to_json(updated_at)#>>'{}' AS updated_at,(EXISTS(SELECT 1 FROM order_pricing_snapshots s WHERE s.tenant_id=sales_orders.tenant_id AND s.order_id=sales_orders.id) OR EXISTS(SELECT 1 FROM commercial_order_quotes q WHERE q.tenant_id=sales_orders.tenant_id AND q.order_id=sales_orders.id)) AS pricing_origin FROM sales_orders"

export function registerOrderRoutes(app: FastifyInstance, dependencies: AppDependencies) {
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
