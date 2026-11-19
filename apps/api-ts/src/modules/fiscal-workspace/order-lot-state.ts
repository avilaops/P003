import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue } from "../../platform/revision.js"

export type LotEnvironment = "production" | "homologation"
type Line = { lineNumber:number; productId:string; name:string; sku:string; unit:string; ordered:string; allocated:string; billed:string; delivered:string; available:string; returned:string }
type Lot = { id:string; draftId:string|null; legacyFull:boolean; environment:LotEnvironment; status:string; deliveredAt:string|null; accessKey:string|null; number:number|null; items:{ lineNumber:number; sku:string; quantity:string; tracked:boolean }[] }

export async function lotState(c:AuthorizedContext, order:string, environment:LotEnvironment) {
  const args=[c.tenantId,order,environment]
  const row=(await c.client.query(`SELECT status,revision FROM sales_orders WHERE tenant_id=$1 AND id=$2`,args.slice(0,2))).rows[0]
  if (!row) throw new Problem(404,"not_found","Pedido não encontrado nesta empresa")
  const lines=(await c.client.query<Line>(`
    WITH allocations AS (
      SELECT i.line_number,
        sum(i.quantity_micros) FILTER(WHERE l.delivered_at IS NOT NULL OR NOT l.withdrawn AND coalesce(e.status,'draft') NOT IN('cancelled','rejected')) AS allocated,
        sum(i.quantity_micros) FILTER(WHERE NOT l.withdrawn AND e.status='authorized') AS billed,
        sum(i.quantity_micros) FILTER(WHERE l.delivered_at IS NOT NULL) AS delivered
      FROM sales_invoice_lot_items i JOIN sales_invoice_lots l ON l.tenant_id=i.tenant_id AND l.id=i.lot_id
      LEFT JOIN fiscal_nfe_documents e ON e.tenant_id=l.tenant_id AND e.id=l.draft_id
      WHERE i.tenant_id=$1 AND i.order_id=$2 AND l.environment=$3 GROUP BY i.line_number
    ), legacy AS (
      SELECT bool_or(status NOT IN ('cancelled','rejected')) AS allocated,bool_or(status='authorized') AS billed
      FROM fiscal_nfe_documents WHERE tenant_id=$1 AND source_order_id=$2 AND environment=$3
    )
    SELECT s.line_number AS "lineNumber",s.product_id AS "productId",s.sku,s.name,s.unit,
      s.quantity_micros::text AS ordered,CASE WHEN x.allocated THEN s.quantity_micros ELSE coalesce(a.allocated,0) END::text AS allocated,
      CASE WHEN x.billed THEN s.quantity_micros ELSE coalesce(a.billed,0) END::text AS billed,
      CASE WHEN $3='production' AND o.status='completed' THEN s.quantity_micros ELSE coalesce(a.delivered,0) END::text AS delivered,
      greatest(0,CASE WHEN x.allocated THEN 0 ELSE s.quantity_micros-coalesce(a.allocated,0) END)::text AS available,
      coalesce((SELECT sum(r.quantity_micros) FROM sales_partial_return_items r JOIN sales_invoice_lots l ON l.tenant_id=r.tenant_id AND l.id=r.lot_id
          WHERE r.tenant_id=s.tenant_id AND l.order_id=s.order_id AND r.line_number=s.line_number AND l.environment=$3),0)::text AS returned
    FROM sales_order_lines s JOIN sales_orders o ON o.tenant_id=s.tenant_id AND o.id=s.order_id
      CROSS JOIN legacy x LEFT JOIN allocations a USING(line_number) WHERE s.tenant_id=$1 AND s.order_id=$2 ORDER BY s.line_number`,args)).rows
  const lots=(await c.client.query<Lot>(`SELECT l.id,l.draft_id AS "draftId",l.legacy_full AS "legacyFull",l.environment,
      CASE WHEN l.withdrawn THEN 'withdrawn' ELSE coalesce(e.status,CASE WHEN l.draft_id IS NULL THEN 'reserved' ELSE 'draft' END) END AS status,
      l.delivered_at AS "deliveredAt",e.access_key AS "accessKey",e.number,
      (SELECT jsonb_agg(jsonb_build_object('lineNumber',i.line_number,'sku',s.sku,'quantity',i.quantity_micros::text,'tracked',EXISTS(SELECT FROM stock_serial_products t WHERE t.tenant_id=i.tenant_id AND t.product_id=s.product_id)) ORDER BY i.line_number)
       FROM sales_invoice_lot_items i JOIN sales_order_lines s USING(tenant_id,order_id,line_number) WHERE i.tenant_id=l.tenant_id AND i.lot_id=l.id) AS items
    FROM sales_invoice_lots l LEFT JOIN fiscal_nfe_documents e ON e.tenant_id=l.tenant_id AND e.id=l.draft_id
    WHERE l.tenant_id=$1 AND l.order_id=$2 AND l.environment=$3 ORDER BY l.created_at DESC,l.id`,args)).rows
  const returns=(await c.client.query(`SELECT r.id,r.lot_id AS "lotId",r.received_nfe_id::text AS "receivedId",r.reason,r.destination,
      CASE WHEN $4 THEN r.credited_cents::text END AS "creditedCents",
    CASE WHEN $4 THEN (r.credited_cents-coalesce((SELECT sum(u.amount_cents) FROM sales_return_credit_applications u WHERE u.tenant_id=r.tenant_id AND u.return_id=r.id),0))::text END AS "remainingCreditCents",CASE WHEN $4 THEN r.abated_cents::text END AS "abatedCents",CASE WHEN $5 THEN r.commission_reversed_cents::text END AS "commissionReversedCents"
    FROM sales_partial_returns r JOIN sales_invoice_lots l ON l.tenant_id=r.tenant_id AND l.id=r.lot_id
    WHERE l.tenant_id=$1 AND l.order_id=$2 AND l.environment=$3 ORDER BY r.created_at DESC,r.id`,[...args,c.permissions.some(p=>p==="finance.receivables.read" || p==="finance.receivables.manage"),c.permissions.some(p=>p==="finance.commissions.read" || p==="finance.commissions.manage")])).rows
  const returnRequests=environment==="production" ? (await c.client.query(`SELECT id,received_id::text AS "receivedId",lot_id AS "lotId",reason,destination,status,
    CASE WHEN $4 THEN amount_cents::text END AS "amountCents",decision_reason AS "decisionReason",
    (requested_by<>$3 AND status='pending' AND $5) AS "canDecide" FROM sales_return_requests WHERE tenant_id=$1 AND order_id=$2 ORDER BY requested_at DESC,id`,
    [c.tenantId,order,c.authSubject,c.permissions.includes("finance.receivables.manage"),c.permissions.some(p=>p==="sales.approvals.manage" || p==="sales.approvals.director")])).rows : []
  const ownReturns=(await c.client.query(`SELECT p.id,p.lot_id AS "lotId",p.status,p.reason,p.destination,p.original_key AS "originalKey",p.received_id::text AS "receivedId",
    d.status AS "emissionStatus",p.decision_reason AS "decisionReason",
    (p.submitted_by<>$4 AND p.status='pending' AND $5) AS "canDecide" FROM sales_self_return_plans p
    LEFT JOIN fiscal_nfe_documents d ON d.tenant_id=p.tenant_id AND d.id=p.id WHERE p.tenant_id=$1 AND p.order_id=$2 AND p.environment=$3 ORDER BY p.created_at DESC,p.id`,
    [...args,c.authSubject,c.permissions.some(p=>p==="sales.approvals.manage" || p==="sales.approvals.director")])).rows
  return {ownReturns,returnRequests,tenantId:c.tenantId,orderId:order,status:String(row.status),revision:revisionValue(row.revision),environment,lines,lots,returns}
}
