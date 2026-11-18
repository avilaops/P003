import { revisionValue } from "../../platform/revision.js"
import { commissionManage, missing, money, type Context } from "./shared.js"

export const unallocated = `NOT EXISTS(SELECT 1 FROM commission_payment_entries p WHERE p.tenant_id=e.tenant_id AND p.entry_id=e.id)
  AND NOT EXISTS(SELECT 1 FROM commission_closing_entries c WHERE c.tenant_id=e.tenant_id AND c.entry_id=e.id)`
const balances = `SELECT s.id,s.name,COALESCE(a.revision,1) AS revision,
  COALESCE((SELECT sum(amount_cents) FROM commission_entries e WHERE e.tenant_id=s.tenant_id AND e.seller_staff_id=s.id AND ${unallocated}),0) AS open,
  COALESCE((SELECT sum(amount_cents) FROM commission_payments p WHERE p.tenant_id=s.tenant_id AND p.seller_staff_id=s.id),0) AS paid
  FROM staff s LEFT JOIN commission_accounts a ON a.tenant_id=s.tenant_id AND a.seller_staff_id=s.id
  WHERE s.tenant_id=$1 AND (s.is_seller OR a.seller_staff_id IS NOT NULL)`
function balance(row: Record<string,unknown>) {
  return { sellerStaffId:row.id,sellerName:row.name,revision:revisionValue(row.revision),openAmount:money(row.open),paidAmount:money(row.paid) }
}
export async function list(context: Context, offset: number, limit: number) {
  const rows = (await context.client.query(`WITH b AS (${balances}),p AS (SELECT * FROM b ORDER BY name,id LIMIT $2 OFFSET $3)
    SELECT (SELECT count(*) FROM b)::int AS total,COALESCE((SELECT sum(open) FROM b),0)::text AS open,COALESCE((SELECT sum(paid) FROM b),0)::text AS paid,
    COALESCE((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('open',open::text,'paid',paid::text,'revision',revision::text) ORDER BY name,id) FROM p),'[]') AS sellers`,[context.tenantId,limit,offset])).rows[0]!
  return { tenantId:context.tenantId,canEdit:context.permissions.includes(commissionManage),data:(rows.sellers as Record<string,unknown>[]).map(balance),total:rows.total,offset,limit,totals:{openAmount:money(rows.open),paidAmount:money(rows.paid)} }
}
export async function book(context: Context, id: string) {
  const {client,tenantId}=context
  const row = (await client.query(balances+" AND s.id=$2",[tenantId,id])).rows[0]
  if (!row) missing()
  const entries=(await client.query(`SELECT e.id,e.kind,e.seller_name AS "sellerName",e.order_id AS "orderId",o.number::text AS "orderNumber",
    e.receipt_id AS "receiptId",e.reversal_id AS "reversalId",e.reverses_entry_id AS "reversesEntryId",e.product_id AS "productId",pr.name AS "productName",e.invoice_id AS "invoiceId",
    to_char(e.competence,'YYYY-MM') AS competence,e.payment_due::text AS "paymentDue",round(e.amount_cents::numeric/100,2)::text AS amount,
    round(e.base_cents::numeric/100,2)::text AS "baseAmount",round(e.commission_rate::numeric/10000,4)::text AS "commissionRate",
    round(e.ipi_rate::numeric/10000,4)::text AS "ipiRate",e.reason,p.payment_id AS "paymentId",ap.id AS "payableId"
    FROM commission_entries e LEFT JOIN sales_orders o ON o.tenant_id=e.tenant_id AND o.id=e.order_id
    LEFT JOIN products pr ON pr.tenant_id=e.tenant_id AND pr.id=e.product_id
    LEFT JOIN commission_payment_entries p ON p.tenant_id=e.tenant_id AND p.entry_id=e.id
    LEFT JOIN commission_closing_entries c ON c.tenant_id=e.tenant_id AND c.entry_id=e.id
    LEFT JOIN payables ap ON ap.tenant_id=c.tenant_id AND ap.commission_closing_id=c.closing_id
    WHERE e.tenant_id=$1 AND e.seller_staff_id=$2 ORDER BY e.created_at,e.id`,[tenantId,id])).rows
  const payments=(await client.query(`SELECT id,to_char(through_competence,'YYYY-MM') AS "throughCompetence",occurred_on::text AS "occurredOn",reference,
    round(amount_cents::numeric/100,2)::text AS amount FROM commission_payments WHERE tenant_id=$1 AND seller_staff_id=$2 ORDER BY created_at,id`,[tenantId,id])).rows
  const policies=(await client.query(`SELECT p.id,p.product_id AS "productId",pr.name AS "productName",p.product_line AS "productLine",p.trigger_event AS "trigger",
    round(p.commission_rate::numeric/10000,4)::text AS "commissionRate" FROM commission_policies p LEFT JOIN products pr ON pr.tenant_id=p.tenant_id AND pr.id=p.product_id
    WHERE p.tenant_id=$1 AND p.seller_staff_id=$2 ORDER BY pr.name,p.product_line,p.id`,[tenantId,id])).rows
  const closings=(await client.query(`SELECT c.id,to_char(c.competence,'YYYY-MM') AS competence,c.due_date::text AS "dueDate",c.reason,c.approved_by AS "approvedBy",
    p.id AS "payableId",p.status,round(c.amount_cents::numeric/100,2)::text AS amount
    FROM commission_closings c JOIN payables p ON p.tenant_id=c.tenant_id AND p.commission_closing_id=c.id
    WHERE c.tenant_id=$1 AND c.seller_staff_id=$2 ORDER BY c.competence DESC`,[tenantId,id])).rows
  return {tenantId,canEdit:context.permissions.includes(commissionManage),canClose:context.permissions.includes(commissionManage)&&context.permissions.includes("finance.payables.originate"),data:balance(row),entries,payments,policies,closings}
}
export async function orderTerms(context:Context,id:string) {
  const row=(await context.client.query(`SELECT o.id AS "orderId",o.revision,(o.status<>'draft') AS locked,
    CASE WHEN t.order_id IS NULL THEN 'not_required' ELSE 'configured' END AS status,
    t.seller_staff_id AS "sellerStaffId",t.seller_name AS "sellerName",round(t.commission_rate::numeric/10000,4)::text AS "commissionRate",
    round(t.ipi_rate::numeric/10000,4)::text AS "ipiRate",t.payment_day AS "paymentDay",COALESCE(t.use_policies,false) AS "usePolicies",
    COALESCE((SELECT jsonb_agg(jsonb_build_object(\'productName\',p.name,\'trigger\',l.trigger_event,\'commissionRate\',round(l.commission_rate::numeric/10000,4)::text) ORDER BY l.line_number)
      FROM order_commission_lines l JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id),\'[]\') AS "policyLines"
    FROM sales_orders o LEFT JOIN order_commission_terms t ON t.tenant_id=o.tenant_id AND t.order_id=o.id WHERE o.tenant_id=$1 AND o.id=$2`,[context.tenantId,id])).rows[0]
  if (!row) missing()
  return {tenantId:context.tenantId,canEdit:!row.locked && context.permissions.includes("sales.orders.manage") && context.permissions.includes(commissionManage),data:{...row,revision:revisionValue(row.revision)}}
}
