import { randomUUID } from "node:crypto"
import type { AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import type { CommandHeaders } from "../orders/receivables.js"
import type { Revision } from "../../platform/revision.js"

const balanceQuery = `
WITH titles AS (
 SELECT r.id,r.order_id,r.due_date,r.status,r.amount_cents-COALESCE((
  SELECT sum(CASE p.kind WHEN 'receipt' THEN p.amount_cents ELSE -p.amount_cents END)
  FROM receivable_payments p WHERE p.tenant_id=r.tenant_id AND p.receivable_id=r.id
 ),0) AS remaining
 FROM receivables r JOIN sales_orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id
 WHERE o.tenant_id=$1 AND o.customer_id=$2 AND r.status<>'cancelled'
), commitments AS (
 SELECT o.amount_cents FROM sales_orders o
 WHERE o.tenant_id=$1 AND o.customer_id=$2 AND (o.status IN ('accepted','confirmed') OR o.id=$3)
 AND NOT EXISTS(SELECT 1 FROM titles t WHERE t.order_id=o.id)
)
SELECT (COALESCE((SELECT sum(GREATEST(remaining,0)) FROM titles),0)
 + COALESCE((SELECT sum(amount_cents) FROM commitments),0))::text AS exposure,
 COALESCE((SELECT max((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date-due_date)
 FROM titles WHERE remaining>0),0) AS past_due_days`

export function creditReasons(policy: {blocked: boolean; expired: boolean; credit_limit_cents: string | null; overdue_days: number | null}, exposure: bigint, pastDueDays: number) {
  const reasons: string[] = []
  if (policy.blocked) reasons.push("Cliente com bloqueio manual")
  if (policy.expired) reasons.push("Validade do crédito encerrada")
  if (policy.credit_limit_cents !== null && exposure > BigInt(policy.credit_limit_cents)) reasons.push("Limite de crédito excedido")
  if (policy.overdue_days !== null && pastDueDays > policy.overdue_days) reasons.push("Título em atraso além da tolerância")
  return reasons
}

/** The caller commits the pending request and returns 409 outside the transaction. */
export async function checkOrderCredit(context: AuthorizedContext, headers: CommandHeaders, id: string, customer: string, revision: Revision, status: string) {
  const { tenantId, client } = context
  const policy = (await client.query<{revision: string; blocked: boolean; expired: boolean; credit_limit_cents: string | null; overdue_days: number | null}>(
    "SELECT revision,blocked,valid_until < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date AS expired,credit_limit_cents::text,overdue_days FROM sales_customer_policies WHERE tenant_id=$1 AND customer_id=$2", [tenantId,customer])).rows[0]
  if (!policy) return null
  const balance = (await client.query<{exposure: string; past_due_days: number}>(balanceQuery,[tenantId,customer,id])).rows[0]!
  const exposure = BigInt(balance.exposure)
  const reasons = creditReasons(policy,exposure,balance.past_due_days)
  const previous = (await client.query("SELECT id,status,order_revision,policy_revision,exposure_cents,reasons FROM sales_credit_reviews WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[tenantId,id])).rows[0]
  if (previous && (BigInt(String(previous.order_revision)) === BigInt(revision) || (status === "accepted" && previous.status === "approved" && BigInt(String(previous.order_revision)) + 1n === BigInt(revision))) && BigInt(String(previous.policy_revision)) === BigInt(policy.revision)
    && JSON.stringify(previous.reasons) === JSON.stringify(reasons) && exposure <= BigInt(String(previous.exposure_cents))) {
    if (previous.status === "approved") return null
    if (["pending","rejected"].includes(String(previous.status))) return reasons.join(" • ") + (previous.status === "rejected" ? " • Liberação recusada" : " • Aguardando liberação de crédito")
  }
  if (previous?.status === "pending") await client.query("UPDATE sales_credit_reviews SET status='cancelled' WHERE tenant_id=$1 AND id=$2",[tenantId,previous.id])
  if (!reasons.length) return null
  const requestId = randomUUID()
  await client.query("INSERT INTO sales_credit_reviews(id,tenant_id,order_id,order_revision,policy_revision,exposure_cents,reasons,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[requestId,tenantId,id,revision,policy.revision,exposure,reasons,context.authSubject])
  await record(context,headers,"sales_order",id,"credit.review_requested",{requestId,requestedBy:context.authSubject,reasons})
  return reasons.join(" • ") + " • Aguardando liberação de crédito"
}
