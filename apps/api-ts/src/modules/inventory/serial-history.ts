import type { FastifyInstance } from "fastify"
import {z} from "zod"
import {type AccessDependencies,type AuthorizedContext,authorizeRequest,requirePermission} from "../../platform/access.js"
import {normalizedDatabaseId} from "../../platform/database-id.js"
import {Problem} from "../../platform/problem.js"
import {queryInteger} from "../registrations/query.js"

const filter=z.strictObject({productId:normalizedDatabaseId,serial:z.string().min(1).max(120),offset:queryInteger(0,100000).default(0)})
const documentQuery=z.strictObject({documentId:normalizedDatabaseId,offset:queryInteger(0,100000).default(0)})
type SerialSource = {productId:string;serialNumber:string;orderId:string|null;movementId:string|null;stockEventId:string|null;lotId:string|null;delivered:boolean}
export async function warrantySerialHistory(ctx:AuthorizedContext,serial:string) {
  // Assignments can precede shipment. Only an issue belonging to the last sale proves delivery.
  const result=await ctx.client.query<SerialSource>(`WITH units AS (
    SELECT product_id,serial FROM stock_serials WHERE tenant_id=$1 AND upper(serial)=upper(trim($2))
    UNION SELECT a.product_id,unit FROM stock_serial_assignments a CROSS JOIN LATERAL unnest(a.serials) unit
      WHERE a.tenant_id=$1 AND a.kind='sale' AND a.direction='issue' AND upper(unit)=upper(trim($2))
  ) SELECT u.product_id AS "productId",u.serial AS "serialNumber",e.order_id AS "orderId",m.id AS "movementId",
    e.id::text AS "stockEventId",m.sales_invoice_lot_id AS "lotId",
    coalesce(s.status IN ('sold','service') AND e.status='sold' AND m.id IS NOT NULL,false) AS delivered
    FROM units u LEFT JOIN stock_serials s ON (s.tenant_id,s.product_id,s.serial)=($1,u.product_id,u.serial)
    LEFT JOIN LATERAL (SELECT h.id,h.status,h.order_id,h.movement_id FROM stock_serial_events h
      WHERE (h.tenant_id,h.product_id,h.serial)=($1,u.product_id,u.serial) AND (h.status='sold' OR h.sales_partial_return_id IS NOT NULL)
      ORDER BY h.id DESC LIMIT 1) e ON true
    LEFT JOIN stock_movements m ON (m.tenant_id,m.id,m.product_id,m.source_order_id)=($1,e.movement_id,u.product_id,e.order_id) AND m.direction='issue'
    ORDER BY u.product_id,u.serial`,[ctx.tenantId,serial])
  return result.rows
}

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
        coalesce(e.warranty_id,so.case_id) AS "warrantyId",so.id AS "serviceOrderId",e.order_id AS "orderId",e.pos_sale_id AS "posSaleId",m.inventory_count_id AS "countId"
        FROM stock_serial_events e JOIN warehouses w ON (w.tenant_id,w.id)=(e.tenant_id,e.warehouse_id)
        LEFT JOIN stock_movements m ON (m.tenant_id,m.id)=(e.tenant_id,e.movement_id)
        LEFT JOIN warranty_service_order_parts part ON (part.tenant_id,part.stock_movement_id)=(e.tenant_id,e.movement_id)
        LEFT JOIN warranty_service_orders so ON (so.tenant_id,so.id)=(part.tenant_id,part.service_order_id)
        WHERE e.tenant_id=$1 AND e.product_id=$2 AND e.serial=$3 ORDER BY e.id DESC LIMIT 26 OFFSET $4`,
        [ctx.tenantId,productId,serial,offset])
      return {tenantId:ctx.tenantId,productId,serial,data:result.rows.slice(0,25),hasMore:result.rows.length>25}
    })
  })
}
