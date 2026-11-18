import type { FastifyInstance } from "fastify"
import {z} from "zod"
import {type AccessDependencies,authorizeRequest,requirePermission} from "../../platform/access.js"
import {normalizedDatabaseId} from "../../platform/database-id.js"
import {Problem} from "../../platform/problem.js"
import {queryInteger} from "../registrations/query.js"

const filter=z.strictObject({productId:normalizedDatabaseId,serial:z.string().min(1).max(120),offset:queryInteger(0,100000).default(0)})
export function registerSerialHistory(app:FastifyInstance,deps:AccessDependencies) {
  app.get("/api/v1/stock/serials/events",(req,reply)=>{
    reply.header("cache-control","no-store")
    return authorizeRequest(req,deps,async ctx=>{
      requirePermission(ctx,"inventory.stock.read")
      const parsed=filter.safeParse(req.query)
      if (!parsed.success) throw new Problem(422,"invalid_input","Informe produto e série para consultar o histórico")
      const {productId,serial,offset}=parsed.data
      const result=await ctx.client.query(`SELECT e.id,e.status,e.occurred_at AS "occurredAt",w.name AS warehouse,
        m.id AS "movementId",m.source_purchase_receipt_id AS "receiptId",m.production_order_id AS "productionId",m.transfer_id AS "transferId",
        e.warranty_id AS "warrantyId",e.order_id AS "orderId",e.pos_sale_id AS "posSaleId",m.inventory_count_id AS "countId"
        FROM stock_serial_events e JOIN warehouses w ON (w.tenant_id,w.id)=(e.tenant_id,e.warehouse_id)
        LEFT JOIN stock_movements m ON (m.tenant_id,m.id)=(e.tenant_id,e.movement_id)
        WHERE e.tenant_id=$1 AND e.product_id=$2 AND e.serial=$3 ORDER BY e.id DESC LIMIT 26 OFFSET $4`,
        [ctx.tenantId,productId,serial,offset])
      return {tenantId:ctx.tenantId,productId,serial,data:result.rows.slice(0,25),hasMore:result.rows.length>25}
    })
  })
}
