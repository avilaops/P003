import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { recordWorkspace } from "../sales/record-workspace.js"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { integer } from "../registrations/query.js"
import { orderSummary, orderSearchNumber, queryInput } from "../sales/shared.js"
import { loadOrder, summary } from "./snapshot.js"
import { registerOrderCommands } from "./commands.js"
import { registerOrderTransitions } from "./transitions.js"
import { registerOrderFinance } from "./settlements.js"
import { registerSupportingDocuments } from "./supporting-documents.js"
import { registerOrderCommercialDocuments } from "./commercial-documents.js"
import { registerCompletedCancellation } from "./completed-cancellation.js"
import { registerOrderPricing } from "./pricing.js"



export function registerOrderRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  registerOrderCommands(app, dependencies)
  registerOrderTransitions(app, dependencies)
  registerOrderPricing(app, dependencies)
  registerOrderFinance(app, dependencies)
  registerSupportingDocuments(app, dependencies)
  registerOrderCommercialDocuments(app, dependencies)
  registerCompletedCancellation(app, dependencies)
  app.get<{ Params: { id: string } }>("/api/v1/orders/:id", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read")
      if (!z.guid().safeParse(request.params.id).success) throw new Problem(422, "invalid_input", "Identificador inválido")
      return loadOrder(context, request.params.id)
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })
  app.get("/api/v1/orders", async (request, reply) => {
    if ((request.query as Record<string, unknown>).view === "workspace") {
      const page=await authorizeRequest(request,dependencies,async c=>{
        requirePermission(c,"sales.orders.read")
        return recordWorkspace(c,request.query,"orders")
      })
      return reply.header("cache-control","no-store").send(page)
    }
    const query = queryInput(request.query, ["", "draft", "accepted", "confirmed", "completed", "cancelled"])
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read")
      const digits = /^[\d.\-/ ]*$/.test(query.q) ? query.q.replace(/\D/g, "") : ""
      const number = orderSearchNumber(query.q)
      const filter = "WHERE tenant_id=$1 AND ($2='' OR strpos(lower(customer_name),lower($2))>0 OR strpos(id::text,lower($2))>0 OR ($3<>'' AND strpos(customer_tax_id,$3)>0) OR number=$4) AND ($5='' OR status=$5)"
      const order = query.sort === "updated" ? "sales_orders.updated_at DESC,sales_orders.id DESC" : "sales_orders.created_at DESC,sales_orders.id DESC"
      const rows = await context.client.query(`${summary} ${filter} ORDER BY ${order} LIMIT $6 OFFSET $7`, [context.tenantId, query.q, digits, number, query.status, query.limit, query.offset])
      const count = await context.client.query<{ total: string }>(`SELECT count(*)::text AS total FROM sales_orders ${filter}`, [context.tenantId, query.q, digits, number, query.status])
      return { tenantId: context.tenantId, canEdit: context.permissions.includes("sales.orders.manage"), data: rows.rows.map(orderSummary), total: integer(count.rows[0]?.total ?? 0), offset: query.offset, limit: query.limit }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
}
