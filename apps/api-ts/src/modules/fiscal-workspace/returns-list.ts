import type {FastifyInstance} from "fastify"
import {z} from "zod"
import {authorizeRequest,requirePermission,type AccessDependencies} from "../../platform/access.js"
import {invalid} from "./draft-data.js"
const params=z.strictObject({q:z.string().trim().max(150).default(""),environment:z.enum(["production","homologation"]).optional(),
  status:z.enum(["pending","ready","declined","withdrawn","applied","simulated"]).optional(),offset:z.coerce.number().int().min(0).max(2147483647).default(0)})
export function registerSalesReturns(app:FastifyInstance,deps:AccessDependencies){
  app.get("/api/v1/fiscal/sales-returns",async(r,reply)=>authorizeRequest(r,deps,async c=>{
    requirePermission(c,"sales.orders.read");requirePermission(c,"fiscal.nfe.read")
    const q=params.safeParse(r.query)
    if(!q.success)return invalid("Confira os filtros das devoluções")
    const page=(await c.client.query(`WITH records AS (
      SELECT p.id,p.order_id AS "orderId",p.lot_id AS "lotId",p.original_key AS "originalKey",p.id AS "draftId",p.received_id::text AS "receivedId",p.status,p.reason,p.environment,p.created_at AS date,'own' AS origin FROM sales_self_return_plans p WHERE p.tenant_id=$1
      UNION ALL SELECT r.id,l.order_id,r.lot_id,d.access_key,NULL,r.received_nfe_id::text,'applied',r.reason,l.environment,r.created_at,'received' FROM sales_partial_returns r
          JOIN sales_invoice_lots l ON (l.tenant_id,l.id)=(r.tenant_id,r.lot_id) JOIN fiscal_nfe_documents d ON (d.tenant_id,d.id)=(l.tenant_id,l.draft_id)
          WHERE r.tenant_id=$1 AND NOT EXISTS(SELECT FROM sales_self_return_plans p WHERE p.tenant_id=r.tenant_id AND p.return_id=r.id)
      UNION ALL SELECT r.id,r.order_id,r.lot_id,d.access_key,NULL,r.received_id::text,CASE WHEN r.status='rejected' THEN 'declined' ELSE 'pending' END,r.reason,'production',r.requested_at,'received'
        FROM sales_return_requests r JOIN sales_invoice_lots l ON (l.tenant_id,l.id)=(r.tenant_id,r.lot_id) JOIN fiscal_nfe_documents d ON (d.tenant_id,d.id)=(l.tenant_id,l.draft_id) WHERE r.tenant_id=$1 AND r.status<>'approved'
      ), filtered AS MATERIALIZED (SELECT records.*,o.number::text AS "orderNumber",o.customer_name AS customer FROM records JOIN sales_orders o ON o.tenant_id=$1 AND o.id=records."orderId"
        WHERE ($2::text IS NULL OR environment=$2) AND ($3::text IS NULL OR records.status=$3) AND strpos(lower(concat_ws(' ',o.number,o.customer_name,"originalKey",reason)),lower($4))>0),
      page AS (SELECT * FROM filtered ORDER BY date DESC,id DESC LIMIT 25 OFFSET $5)
      SELECT (SELECT count(*)::int FROM filtered) AS total,coalesce(jsonb_agg(to_jsonb(page) ORDER BY date DESC,id DESC),'[]') AS data FROM page`,[c.tenantId,q.data.environment,q.data.status,q.data.q,q.data.offset])).rows[0]
    return reply.header("cache-control","no-store").send({tenantId:c.tenantId,...page})
  }))
}
