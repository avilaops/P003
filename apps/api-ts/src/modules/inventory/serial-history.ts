import type { FastifyInstance } from "fastify"
import {z} from "zod"
import {type AccessDependencies,authorizeRequest,requirePermission} from "../../platform/access.js"
import {normalizedDatabaseId} from "../../platform/database-id.js"
import {Problem} from "../../platform/problem.js"
import {queryInteger} from "../registrations/query.js"

const filter=z.strictObject({productId:normalizedDatabaseId,serial:z.string().min(1).max(120),offset:queryInteger(0,100000).default(0)})
const documentQuery=z.strictObject({documentId:normalizedDatabaseId,offset:queryInteger(0,100000).default(0)})
export function registerSerialHistory(app:FastifyInstance,deps:AccessDependencies) {
  app.get("/api/v1/stock/serials/document",(req,reply)=>{
    reply.header("cache-control","no-store")
    return authorizeRequest(req,deps,async ctx=>{
      const sales=ctx.permissions.includes("sales.orders.read")
      if(!sales)requirePermission(ctx,"fiscal.nfe.read")
      const parsed=documentQuery.safeParse(req.query)
      if(!parsed.success)throw new Problem(422,"invalid_input","Informe o pedido da consulta")
      const {documentId,offset}=parsed.data
      const args=[ctx.tenantId,documentId,offset,sales]
      const {rows}=await ctx.client.query(`WITH document AS (
        SELECT id FROM sales_orders WHERE tenant_id=$1 AND id=$2 AND ($4 OR EXISTS(
          SELECT 1 FROM fiscal_nfe_drafts f WHERE f.tenant_id=$1 AND f.details->>'sourceOrderId'=$2::uuid::text)
          OR EXISTS(SELECT 1 FROM fiscal_nfe_documents f WHERE f.tenant_id=$1 AND f.source_order_id=$2))
        ), units AS (
          SELECT product_id,unnest(serials) AS serial FROM stock_serial_assignments WHERE tenant_id=$1 AND kind='sale' AND document_id IN (SELECT id FROM document)
          UNION SELECT product_id,serial FROM stock_serial_events WHERE tenant_id=$1 AND order_id IN (SELECT id FROM document) AND status IN ('reserved','sold')
        ) SELECT u.product_id AS "productId",p.sku,u.serial FROM units u JOIN products p ON (p.tenant_id,p.id)=($1,u.product_id)
          ORDER BY p.sku,u.product_id,u.serial LIMIT 26 OFFSET $3`,args)
      return {tenantId:ctx.tenantId,documentId,data:rows.slice(0,25),hasMore:rows.length>25}
    })
  })
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
