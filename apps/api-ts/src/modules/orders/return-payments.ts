import { randomUUID } from "node:crypto"
import type { AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, revisionValue } from "../../platform/revision.js"
import { decimal } from "../sales/fixed.js"
import { conflict } from "./acceptance.js"
import type { CommandHeaders } from "./receivables.js"

type Payment = { id: string; amount_cents: string; method: string; occurred_on: string; financial_account_id: string | null }

async function reverseCommission(context: AuthorizedContext, headers: CommandHeaders, order: string, receipt: string, reversal: string, occurredOn: string, reason: string) {
  const { client, tenantId } = context
  const original = (await client.query(`SELECT id,seller_staff_id,amount_cents FROM commission_entries
    WHERE tenant_id=$1 AND order_id=$2 AND kind='receipt' AND receipt_id=$3`, [tenantId, order, receipt])).rows[0]
  if (!original) {
    if ((await client.query("SELECT 1 FROM order_commission_terms WHERE tenant_id=$1 AND order_id=$2", [tenantId, order])).rows.length) {
      conflict("Recebimento configurado sem comissão original. Concilie antes de estornar")
    }
    return
  }
  if ((await client.query("SELECT 1 FROM commission_entries WHERE tenant_id=$1 AND reverses_entry_id=$2", [tenantId, original.id])).rows.length) return
  if (occurredOn >= "2100-12-01") throw new Problem(422, "invalid_input", "Vencimento da comissão fora do intervalo permitido")
  const id = randomUUID()
  await client.query(`INSERT INTO commission_entries(id,tenant_id,seller_staff_id,seller_name,order_id,kind,reversal_id,reverses_entry_id,
      competence,payment_due,base_cents,commission_rate,ipi_rate,payment_day,amount_cents,reason)
    SELECT $1,tenant_id,seller_staff_id,seller_name,order_id,'reversal',$2,id,date_trunc('month',$3::date)::date,
      (date_trunc('month',$3::date) + interval '1 month')::date + (payment_day-1),-base_cents,commission_rate,ipi_rate,payment_day,-amount_cents,$4
    FROM commission_entries WHERE tenant_id=$5 AND id=$6`, [id, reversal, occurredOn, reason, tenantId, original.id])
  await client.query(`INSERT INTO commission_accounts(tenant_id,seller_staff_id,revision) VALUES($1,$2,2)
    ON CONFLICT(tenant_id,seller_staff_id) DO UPDATE SET revision=commission_accounts.revision+1`, [tenantId, original.seller_staff_id])
  const cents = BigInt(String(original.amount_cents))
  await record(context, headers, "commission", id, "commission.reversed", { orderId: order, reversalId: reversal, reversesEntryId: original.id,
    sellerStaffId: original.seller_staff_id, amount: (cents > 0n ? "-" : "") + decimal(cents, 2), originalPaymentPreserved: true })
}

export async function cancelCompletedReceivables(context: AuthorizedContext, headers: CommandHeaders, order: string, reason: string, occurredOn: string) {
  const { client, tenantId } = context
  const titles = await client.query("SELECT id,revision,status FROM receivables WHERE tenant_id=$1 AND order_id=$2 ORDER BY id FOR UPDATE", [tenantId, order])
  if (!titles.rows.length) conflict("Pedido concluído sem título financeiro. Concilie antes de cancelar")
  const receivableIds = titles.rows.map(row => String(row.id)), paymentReversalIds: string[] = []
  for (const title of titles.rows) {
    if (title.status === "cancelled") conflict("Título financeiro já cancelado")
    const payments = await client.query<Payment>(`SELECT p.id,p.amount_cents,p.method,p.occurred_on::text,p.financial_account_id FROM receivable_payments p
      WHERE p.tenant_id=$1 AND p.receivable_id=$2 AND p.kind='receipt' AND NOT EXISTS (
        SELECT 1 FROM receivable_payments r WHERE r.tenant_id=p.tenant_id AND r.reverses_id=p.id)
      ORDER BY p.created_at,p.id`, [tenantId, title.id])
    for (const payment of payments.rows) {
      if (occurredOn < payment.occurred_on) throw new Problem(422, "invalid_input", "Estorno não pode anteceder um recebimento original")
      if (payment.financial_account_id && (await client.query("SELECT 1 FROM pos_sessions WHERE tenant_id=$1 AND cash_account_id=$2 AND status='open'",
        [tenantId, payment.financial_account_id])).rows.length) conflict("Conta vinculada a caixa PDV aberto. Encerre a sessão antes de estornar")
      const id = randomUUID()
      await client.query(`INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on,reverses_id,financial_account_id)
        VALUES($1,$2,$3,'reversal',$4,$5,$6,$7,$8,$9)`, [id, tenantId, title.id, payment.amount_cents, payment.method, reason, occurredOn, payment.id, payment.financial_account_id])
      if (payment.financial_account_id) {
        await client.query(`INSERT INTO financial_account_entries(id,tenant_id,account_id,direction,amount_cents,occurred_on,description,reference)
          VALUES($1,$2,$3,'debit',$4,$5,'Estorno de declaração por cancelamento comercial',$6)`,
        [randomUUID(), tenantId, payment.financial_account_id, payment.amount_cents, occurredOn, reason])
      }
      await reverseCommission(context, headers, order, payment.id, id, occurredOn, reason)
      await record(context, headers, "receivable", String(title.id), "receivable.payment_reversed", { paymentId: id, reversesId: payment.id,
        amount: decimal(BigInt(payment.amount_cents), 2), source: "commercial_return", bankTransferExecuted: false })
      paymentReversalIds.push(id)
    }
    const previousRevision = revisionValue(title.revision), revision = nextRevision(previousRevision)
    await client.query("UPDATE receivables SET status='cancelled',payment_id=NULL,revision=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, title.id, revision])
    await record(context, headers, "receivable", String(title.id), "receivable.cancelled", { sourceId: order, reason, previousRevision, revision, status: "cancelled", outstandingAmount: "0.00" })
  }
  return { receivableId: receivableIds.length === 1 ? receivableIds[0] : null, receivableIds, paymentReversalIds }
}
