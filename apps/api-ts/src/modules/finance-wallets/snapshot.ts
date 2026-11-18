import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue, type Revision } from "../../platform/revision.js"
import { decimal } from "../sales/fixed.js"

export type Wallet = "receivables" | "payables" | "financial-payables"
export const wallets: Wallet[] = ["receivables", "payables", "financial-payables"]
export function walletDefinition(wallet: Wallet) {
  const receipt = wallet === "receivables"
  return {
    receipt,
    titles: receipt ? "receivables" : "payables",
    payments: receipt ? "receivable_payments" : "payable_payments",
    foreign: receipt ? "receivable_id" : "payable_id",
    kind: receipt ? "receipt" : "payment",
    permission: receipt ? "finance.receivables" : "finance.payables",
    entity: receipt ? "receivable" : "payable",
    scope: wallet === "financial-payables" ? "financial_payable" : receipt ? "receivable" : "payable",
    purchaseOnly: wallet === "payables" ? "AND r.receipt_id IS NOT NULL" : "",
  }
}
export function missing(): never {
  throw new Problem(404, "not_found", "Registro não encontrado")
}
export function conflict(message: string): never {
  throw new Problem(409, "domain_conflict", message)
}
export function invalid(message: string): never {
  throw new Problem(422, "invalid_input", message)
}
export function currentRevision(actual: Revision, expected: Revision) {
  if (BigInt(actual) !== BigInt(expected))
    throw new Problem(412, "revision_conflict", "O registro foi alterado. Recarregue antes de salvar")
}
type Title = {
  id: string
  orderId?: string
  receiptId?: string
  staffId?: string
  status: string
  revision: Revision
  amount: string
  outstandingAmount: string
  receivedAmount?: string
  paidAmount?: string
  dueDate: string
  natureId: string | null
  costCenterId: string | null
  forecastAccountId: string | null
  competenceOn: string
}
export type Payment = {
  id: string
  kind: string
  amount: string
  interestAmount: string
  penaltyAmount: string
  surchargeAmount: string
  discountAmount: string
  netAmount: string
  method: string
  reference: string
  occurredOn: string
  financialAccountId: string | null
  accountEntryId: string | null
  financialEffect: "cash" | "non_cash" | "unclassified"
  natureId: string | null
  costCenterId: string | null
  paymentMethodId?: string
  paymentMethod?: Record<string, unknown>
  reversesId: string | null
}
export type WalletSnapshot = { tenantId: string; canEdit: boolean; data: Title; payments: Payment[] }
const money = (expr: string) => `((${expr})::numeric/100)::numeric(22,2)::text`
function titleQuery(wallet: Wallet, filter: string, history: boolean) {
  const d = walletDefinition(wallet)
  const receiptParts = `jsonb_build_object('orderId',r.order_id,'customerName',r.customer_name,'receivedAmount',${money("tot.principal")})
    ||jsonb_strip_nulls(jsonb_build_object('orderInstallmentId',r.order_installment_id,'installmentKind',i.kind,'installmentNumber',i.number,'plannedPaymentMethodId',i.payment_method_id))`
  const payableParts = `jsonb_build_object('receiptId',r.receipt_id,'supplierName',r.supplier_name,'paidAmount',${money("tot.principal")})
    ${wallet === "financial-payables" ? "||jsonb_build_object('staffId',s.staff_id,'commissionClosingId',to_jsonb(r)->>'commission_closing_id')" : ""}`
  return `SELECT r.due_date,r.id,
    jsonb_build_object('id',r.id,'dueDate',r.due_date,'amount',${money("r.amount_cents")},
      'outstandingAmount',${money("CASE WHEN r.status='cancelled' THEN 0 ELSE r.amount_cents-tot.principal END")},
      'status',r.status,'revision',r.revision,'paymentId',r.payment_id,'natureId',r.category_id,'costCenterId',r.cost_center_id,'forecastAccountId',r.forecast_account_id,'financeOperationId',to_jsonb(r)->>'finance_operation_id',
      'partyId',coalesce(${d.receipt ? "(SELECT o.customer_id FROM sales_orders o WHERE (o.tenant_id,o.id)=(r.tenant_id,r.order_id))" : "(SELECT o.supplier_id FROM purchase_receipts pr JOIN purchase_orders o ON (o.tenant_id,o.id)=(pr.tenant_id,pr.order_id) WHERE (pr.tenant_id,pr.id)=(r.tenant_id,r.receipt_id))"},(SELECT op.party_id FROM finance_operations op WHERE (op.tenant_id,op.id)=(r.tenant_id,r.finance_operation_id))), 'competenceOn',coalesce(r.competence_on,(r.created_at AT TIME ZONE 'America/Sao_Paulo')::date))
      ||${d.receipt ? receiptParts : payableParts} AS data
    ${history ? ",tot.history AS payments" : ""}
    FROM ${d.titles} r
    ${d.receipt ? "LEFT JOIN sales_order_installments i ON (i.tenant_id,i.id)=(r.tenant_id,r.order_installment_id)" : wallet === "financial-payables" ? "LEFT JOIN staff_payroll_obligations s ON (s.tenant_id,s.id)=(r.tenant_id,r.staff_obligation_id)" : ""}
    CROSS JOIN LATERAL (SELECT coalesce(sum(CASE WHEN p.kind='reversal' THEN -p.amount_cents ELSE p.amount_cents END),0) AS principal
      ${
        history
          ? `,coalesce(jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'amount',${money("p.amount_cents")},
        'interestAmount',${money("p.interest_cents")},'penaltyAmount',${money("p.penalty_cents")},'surchargeAmount',${money("p.surcharge_cents")},
        'discountAmount',${money("p.discount_cents")},'netAmount',${money("p.net_cents")},'method',p.method,'reference',p.reference,
        'occurredOn',p.occurred_on,'reversesId',p.reverses_id,'financialAccountId',p.financial_account_id,'natureId',p.category_id,
        'costCenterId',p.cost_center_id,'accountEntryId',p.account_entry_id,'recordedBy',p.recorded_by,'discountApprovedBy',p.discount_approved_by,
        'proofName',p.proof_metadata->>'filename','proofPath',CASE WHEN p.proof_metadata IS NOT NULL THEN '/api/erp/wallet-payment-files/${wallet}/'||r.id||'/'||p.id END,
        'financialEffect',coalesce(p.financial_effect,CASE WHEN p.financial_account_id IS NULL THEN 'unclassified' ELSE 'cash' END))
        ${d.receipt ? "||jsonb_strip_nulls(jsonb_build_object('paymentMethodId',p.payment_method_id,'paymentMethod',p.payment_method))" : ""}
        ORDER BY p.created_at,p.id),'[]') AS history`
          : ""
      }
      FROM ${d.payments} p WHERE p.tenant_id=r.tenant_id AND p.${d.foreign}=r.id) tot
    WHERE r.tenant_id=$1 ${d.purchaseOnly} ${filter}`
}
export async function loadWallet(context: AuthorizedContext, wallet: Wallet, id: string): Promise<WalletSnapshot> {
  const row = (
    await context.client.query<{ data: Title; payments: Payment[] }>(titleQuery(wallet, "AND r.id=$2", true), [
      context.tenantId,
      id,
    ])
  ).rows[0]
  if (!row) missing()
  return {
    tenantId: context.tenantId,
    canEdit: context.permissions.includes(walletDefinition(wallet).permission + ".manage"),
    data: row.data,
    payments: row.payments,
  }
}
export async function listWallet(context: AuthorizedContext, wallet: Wallet, offset: number, limit: number) {
  const d = walletDefinition(wallet)
  const rows = await context.client.query<{ data: Title[]; total: string }>(
    `SELECT (SELECT count(*) FROM ${d.titles} r WHERE tenant_id=$1 ${d.purchaseOnly}) AS total,
       coalesce((SELECT jsonb_agg(data ORDER BY due_date,id) FROM (${titleQuery(wallet, "ORDER BY r.due_date,r.id LIMIT $2 OFFSET $3", false)}) page),'[]') AS data`,
    [context.tenantId, limit, offset],
  )
  return {
    tenantId: context.tenantId,
    canEdit: context.permissions.includes(d.permission + ".manage"),
    data: rows.rows[0]!.data,
    total: revisionValue(rows.rows[0]!.total),
    offset,
    limit,
  }
}
const signed = (v: bigint) => (v < 0n ? "-" + decimal(-v, 2) : decimal(v, 2))
export async function orderFinance(context: AuthorizedContext, orderId: string) {
  const order = (
    await context.client.query<{ status: string; amount_cents: string; items: { data: Title; payments: Payment[] }[] }>(
      `SELECT o.status,o.amount_cents,coalesce((SELECT jsonb_agg(jsonb_build_object('data',q.data,'payments',q.payments) ORDER BY q.due_date,q.id)
      FROM (${titleQuery("receivables", "AND r.order_id=$2", true)}) q),'[]') AS items FROM sales_orders o WHERE o.tenant_id=$1 AND o.id=$2`,
      [context.tenantId, orderId],
    )
  ).rows[0]
  if (!order) missing()
  let title = 0n,
    received = 0n,
    outstanding = 0n,
    inconsistent = false
  for (const { data } of order.items) {
    const due = BigInt(data.amount.replace(".", "")),
      paid = BigInt(data.receivedAmount!.replace(".", "")),
      left = BigInt(data.outstandingAmount.replace(".", ""))
    title += due
    received += paid
    outstanding += left
    inconsistent ||=
      paid < 0n ||
      left < 0n ||
      paid > due ||
      (data.status === "paid" && paid !== due) ||
      (data.status === "open" && paid >= due) ||
      (data.status === "cancelled" && order.status !== "cancelled")
  }
  const amount = BigInt(order.amount_cents),
    canEdit = context.permissions.includes("finance.receivables.manage")
  const state =
    order.status === "cancelled"
      ? "cancelled"
      : !order.items.length
        ? "not_originated"
        : inconsistent || title !== amount
          ? "inconsistent"
          : !outstanding
            ? "paid"
            : received > 0n
              ? "partial"
              : "open"
  return {
    tenantId: context.tenantId,
    orderId,
    orderStatus: order.status,
    orderAmount: signed(amount),
    titleAmount: signed(title),
    receivedAmount: signed(received),
    outstandingAmount: signed(state === "cancelled" ? 0n : state === "not_originated" ? amount : outstanding),
    state,
    canEdit,
    receivables: order.items.map((item) => ({ tenantId: context.tenantId, canEdit, ...item })),
  }
}
