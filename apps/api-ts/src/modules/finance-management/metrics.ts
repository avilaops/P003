import { unallocated } from "./commission-book.js"

// Recover the sales principal from replacement titles and exclude refinanced interest.
// Each ancestor contributes its share, including subsequent renegotiations.
export const commissionMetrics = `WITH RECURSIVE period AS (
  SELECT COALESCE($2::date,date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date) AS start
), entries AS (
  SELECT e.* FROM commission_entries e,period p WHERE e.tenant_id=$1 AND e.competence=p.start
), replacements AS (
  SELECT p.finance_operation_id AS operation_id,sum(p.open_cents)::numeric AS remaining
  FROM finance_portfolio p WHERE p.tenant_id=$1 AND p.side='receivable' AND p.finance_operation_id IS NOT NULL GROUP BY p.finance_operation_id
  UNION ALL
  SELECT r.finance_operation_id,t.remaining*i.principal_cents/(o.principal_cents+o.interest_cents)
  FROM replacements t JOIN finance_operations o ON o.tenant_id=$1 AND o.id=t.operation_id
  JOIN finance_operation_items i ON i.tenant_id=o.tenant_id AND i.operation_id=o.id
  JOIN receivables r ON r.tenant_id=i.tenant_id AND r.id=i.receivable_id WHERE r.finance_operation_id IS NOT NULL
), replaced_sales AS (
  SELECT r.order_id,sum(t.remaining*i.principal_cents/(o.principal_cents+o.interest_cents)) AS remaining
  FROM replacements t JOIN finance_operations o ON o.tenant_id=$1 AND o.id=t.operation_id
  JOIN finance_operation_items i ON i.tenant_id=o.tenant_id AND i.operation_id=o.id
  JOIN receivables r ON r.tenant_id=i.tenant_id AND r.id=i.receivable_id WHERE r.order_id IS NOT NULL GROUP BY r.order_id
), remaining AS (
  SELECT t.*,o.amount_cents AS gross, greatest(0,o.amount_cents-coalesce((
    SELECT sum(CASE p.kind WHEN 'receipt' THEN p.amount_cents ELSE -p.amount_cents END) FROM receivables r
    JOIN receivable_payments p ON p.tenant_id=r.tenant_id AND p.receivable_id=r.id WHERE r.tenant_id=o.tenant_id AND r.order_id=o.id),0)
    +coalesce(round(rs.remaining),0)) AS outstanding
  FROM order_commission_terms t JOIN sales_orders o ON o.tenant_id=t.tenant_id AND o.id=t.order_id LEFT JOIN replaced_sales rs ON rs.order_id=o.id
  WHERE t.tenant_id=$1 AND o.status IN('accepted','confirmed','completed')
), policy_lines AS (
  SELECT r.*,l.trigger_event,l.commission_rate AS applied_rate,l.weight_cents,sum(l.weight_cents) OVER (PARTITION BY r.order_id) AS weight
  FROM remaining r JOIN order_commission_lines l ON l.tenant_id=r.tenant_id AND l.order_id=r.order_id WHERE r.use_policies
), projections AS (
  SELECT round(round(outstanding*1000000.0/(1000000+ipi_rate))*commission_rate/1000000) AS cents FROM remaining WHERE NOT use_policies
  UNION ALL SELECT round(CASE trigger_event WHEN 'receipt' THEN outstanding ELSE gross END * weight_cents/nullif(weight,0) * applied_rate/(1000000+ipi_rate))
  FROM policy_lines l WHERE trigger_event='receipt' OR NOT EXISTS(SELECT 1 FROM fiscal_nfe_documents d WHERE d.tenant_id=l.tenant_id AND d.source_order_id=l.order_id AND d.environment='production' AND d.status IN('authorized','cancelled'))
)
SELECT jsonb_build_object('month',(SELECT to_char(start,'YYYY-MM') FROM period),
 'receivedBaseCents',(SELECT COALESCE(sum(base_cents),0) FROM entries WHERE kind IN ('receipt','reversal')),
 'commissionCents',(SELECT COALESCE(sum(amount_cents),0) FROM entries),'sellerCount',(SELECT count(DISTINCT seller_staff_id) FROM entries),
 'outstandingCents',(SELECT COALESCE(sum(e.amount_cents),0) FROM commission_entries e WHERE e.tenant_id=$1 AND ${unallocated}),
 'futureCents',(SELECT COALESCE(sum(cents),0) FROM projections))`
