import { movementOriginJoins } from "../inventory/queries.js"

export const movementLedgerQuery = {
  sql: `SELECT m.id,m.created_at,i.effective_on AS ledger_date
    FROM stock_cost_inputs i JOIN stock_movements m ON (m.tenant_id,m.id)=(i.tenant_id,i.movement_id)
    WHERE i.tenant_id=$1 AND i.effective_on BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR i.product_id=$4) AND ($5::uuid IS NULL OR m.warehouse_id=$5)
      AND ($6::text IS NULL OR m.direction=$6)`,
  order: "ledger_date DESC,created_at DESC,id DESC",
}

// Resolve documents only for the requested page. A business reversal can have
// both a source document and a reference to the reversed movement.
export function movementLedgerDetails(selected: string, paginated: boolean) {
  return `WITH selected AS (${selected})
    SELECT selected.ledger_date::text AS date,p.sku,p.name AS product,p.unit,
      coalesce(loc.name,'Sem depósito registrado') AS warehouse,coalesce(source.kind,'Manual') AS kind,
      source.document,(CASE WHEN m.direction='receipt' THEN m.quantity_micros ELSE 0 END * 0.000001)::text AS receipts,
      (CASE WHEN m.direction='issue' THEN m.quantity_micros ELSE 0 END * 0.000001)::text AS issues,m.reason
      ${paginated ? ",selected.total_rows" : ""}
    FROM selected JOIN stock_movements m ON m.tenant_id=$1 AND m.id=selected.id
    JOIN products p ON (p.tenant_id,p.id)=(m.tenant_id,m.product_id)
    LEFT JOIN warehouses loc ON (loc.tenant_id,loc.id)=(m.tenant_id,m.warehouse_id)
    ${movementOriginJoins}
    LEFT JOIN LATERAL (
      SELECT kind,document FROM (VALUES
        (1,'Transferência',m.transfer_id::text),
        (2,'Inventário',coalesce(m.inventory_count_id::text,origin.inventory_count_id)),
        (3,'Produção',m.production_order_id::text),
        (4,'Venda',m.source_order_id::text),
        (5,'Compras',m.source_purchase_receipt_id::text),
        (6,'PDV',m.source_pos_sale_id::text),
        (7,'Garantia',w.case_id::text),
        (8,'Devolução',origin.return_source_id),
        (9,'Estorno',m.reverses_id::text)
      ) refs(priority,kind,document) WHERE document IS NOT NULL ORDER BY priority LIMIT 1
    ) source ON true
    ORDER BY selected.ledger_date DESC,selected.created_at DESC,selected.id DESC`
}
