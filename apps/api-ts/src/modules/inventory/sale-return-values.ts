import type { TenantContext } from "../../platform/database.js"

type CostContext = Pick<TenantContext,"client"|"tenantId">
export type ReturnedSaleQuantity = {
  issue_id:string
  receipt_id:string|null
  issued:string
  returned:string
  restocked_before:string
}

// A full invoice materialized after shipment uses the untagged issue from closing the order.
// Early partial shipments and returns recorded their document IDs in the movement audit.
export async function returnedSaleQuantities({client,tenantId}:CostContext, products:readonly string[]) {
  const {rows}=await client.query<ReturnedSaleQuantity>(`
    WITH returned AS MATERIALIZED (
      SELECT l.order_id,l.legacy_full,l.id AS lot_id,r.id AS return_id,r.created_at,r.destination,s.product_id,i.quantity_micros
      FROM sales_partial_returns r JOIN sales_invoice_lots l ON (l.tenant_id,l.id)=(r.tenant_id,r.lot_id)
      JOIN sales_partial_return_items i ON (i.tenant_id,i.return_id,i.lot_id)=(r.tenant_id,r.id,l.id)
      JOIN sales_order_lines s ON (s.tenant_id,s.order_id,s.line_number)=(l.tenant_id,l.order_id,i.line_number)
      WHERE r.tenant_id=$1 AND l.environment='production' AND s.product_id=ANY($2::uuid[])
    ), relevant_movements AS MATERIALIZED (
      SELECT m.id,m.source_order_id AS order_id,m.product_id,m.direction,m.quantity_micros,m.created_at,
        coalesce(m.sales_invoice_lot_id::text, CASE WHEN m.direction='issue' THEN (
          SELECT a.details->>'lotId' FROM audit_log a WHERE a.tenant_id=$1 AND a.entity_type='stock_movement'
            AND a.entity_id=m.id::text AND a.action='stock.moved' AND a.details ? 'lotId' LIMIT 1) END) AS lot,
        coalesce(m.sales_partial_return_id::text, CASE WHEN m.direction='receipt' THEN (
          SELECT a.details->>'returnId' FROM audit_log a WHERE a.tenant_id=$1 AND a.entity_type='stock_movement'
            AND a.entity_id=m.id::text AND a.action='stock.moved' AND a.details ? 'returnId' LIMIT 1) END) AS return_id
      FROM stock_movements m WHERE m.tenant_id=$1 AND m.reverses_id IS NULL
        AND EXISTS(SELECT FROM returned r WHERE (r.order_id,r.product_id)=(m.source_order_id,m.product_id))
    ), shipments AS (
      SELECT m.*,sum(quantity_micros) OVER (PARTITION BY order_id,product_id,lot ORDER BY created_at,id) AS shipped_end
      FROM relevant_movements m WHERE direction='issue'
    ), returns AS (
      SELECT r.*,CASE WHEN r.legacy_full THEN NULL ELSE r.lot_id::text END AS lot,m.id AS receipt_id,
        sum(r.quantity_micros) OVER (PARTITION BY r.order_id,r.product_id,CASE WHEN r.legacy_full THEN NULL ELSE r.lot_id END
          ORDER BY r.created_at,r.return_id) AS returned_end
      FROM returned r LEFT JOIN relevant_movements m ON r.destination='stock'
        AND (m.order_id,m.product_id,m.return_id)=(r.order_id,r.product_id,r.return_id::text) AND m.direction='receipt'
    ), allocated AS (
      SELECT s.id AS issue_id,s.quantity_micros AS issued,r.receipt_id,r.created_at,r.return_id,
        least(s.shipped_end,r.returned_end)-greatest(s.shipped_end-s.quantity_micros,r.returned_end-r.quantity_micros) AS quantity
      FROM shipments s JOIN returns r ON (s.order_id,s.product_id)=(r.order_id,r.product_id)
        AND s.lot IS NOT DISTINCT FROM r.lot
        AND s.shipped_end>r.returned_end-r.quantity_micros AND r.returned_end>s.shipped_end-s.quantity_micros
    )
    SELECT issue_id,receipt_id,issued::text,quantity::text AS returned,
      coalesce(sum(quantity) FILTER(WHERE receipt_id IS NOT NULL) OVER (PARTITION BY issue_id
        ORDER BY created_at,return_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::text AS restocked_before
    FROM allocated`,[tenantId,products])
  return rows
}
