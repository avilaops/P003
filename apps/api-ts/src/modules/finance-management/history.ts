import {consumeInvoices,onPurchaseReceipt,onPurchaseReversal,onSettlement} from "./accrual.js"
import {type Context,type Headers} from "./shared.js"

// Read immutable operational sources for periods that predate this module. Historic
// receipt commissions already have their own ledger and must never be accrued twice.
export async function recoverAccountingHistory(context:Context,headers:Headers) {
  const {client,tenantId}=context
  await client.query(`INSERT INTO finance_invoice_events(tenant_id,invoice_id,event_type,occurred_on)
    SELECT tenant_id,id,'authorized',left(issued_at,10)::date FROM fiscal_nfe_documents
    WHERE tenant_id=$1 AND environment='production' AND source_order_id IS NOT NULL AND status IN('authorized','cancelled')
    ON CONFLICT DO NOTHING`,[tenantId])
  await client.query(`INSERT INTO finance_invoice_events(tenant_id,invoice_id,event_type,occurred_on)
    SELECT d.tenant_id,d.id,'cancelled',coalesce((SELECT (max(f.updated_at) AT TIME ZONE 'America/Sao_Paulo')::date FROM fiscal_nfe_events f
       WHERE f.tenant_id=d.tenant_id AND f.document_id=d.id AND f.kind='cancelamento' AND f.status='registered'),
       (d.updated_at AT TIME ZONE 'America/Sao_Paulo')::date)
    FROM fiscal_nfe_documents d WHERE d.tenant_id=$1 AND d.environment='production' AND d.source_order_id IS NOT NULL AND d.status='cancelled'
    ON CONFLICT DO NOTHING`,[tenantId])
  await consumeInvoices(context,headers)
  const purchases=await client.query(`SELECT p.id FROM purchase_receipts p WHERE p.tenant_id=$1 AND p.amount_cents>0
    AND NOT EXISTS(SELECT 1 FROM accounting_events e WHERE e.tenant_id=p.tenant_id AND e.event_type='purchase.receipt' AND e.source_id=p.id)`,[tenantId])
  for(const row of purchases.rows) await onPurchaseReceipt(context,headers,String(row.id))
  const reversed=await client.query(`SELECT p.id FROM purchase_receipt_reversals p JOIN purchase_receipts r ON r.tenant_id=p.tenant_id AND r.id=p.receipt_id
    WHERE p.tenant_id=$1 AND r.amount_cents>0 AND NOT EXISTS(SELECT 1 FROM accounting_events e WHERE e.tenant_id=p.tenant_id AND e.event_type='purchase.receipt.reversal' AND e.source_id=p.id)`,[tenantId])
  for(const row of reversed.rows) await onPurchaseReversal(context,headers,String(row.id))
  for(const wallet of ["receivable","payable"] as const) {
    const events=await client.query(`SELECT p.id FROM ${wallet}_payments p WHERE p.tenant_id=$1
      AND NOT EXISTS(SELECT 1 FROM accounting_events e WHERE e.tenant_id=p.tenant_id AND e.source_id=p.id AND e.event_type LIKE $2)
      ORDER BY (p.kind='reversal'),p.occurred_on,p.id`,[tenantId,wallet+".%"])
    for(const row of events.rows) await onSettlement(context,headers,wallet,String(row.id),true)
  }
}
