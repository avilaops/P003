import { randomUUID } from "node:crypto"
import type { AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, revisionValue } from "../../platform/revision.js"
import { decimal } from "../sales/fixed.js"
import { conflict } from "./acceptance.js"

export type CommandHeaders = Record<string, string | string[] | undefined>
export async function hasCheckout(context: AuthorizedContext, id: string) {
  return Boolean((await context.client.query("SELECT EXISTS(SELECT 1 FROM sales_order_checkouts WHERE tenant_id=$1 AND order_id=$2) AS present", [context.tenantId, id])).rows[0]?.present)
}

export async function verifyReceivables(context: AuthorizedContext, id: string) {
  const valid = await context.client.query("SELECT NOT EXISTS(SELECT 1 FROM sales_order_installments i LEFT JOIN receivables r ON r.tenant_id=i.tenant_id AND r.order_id=i.order_id AND r.order_installment_id=i.id WHERE i.tenant_id=$1 AND i.order_id=$2 AND (r.id IS NULL OR r.status='cancelled' OR r.amount_cents<>i.amount_cents OR r.due_date<>i.due_on)) AND NOT EXISTS(SELECT 1 FROM receivables WHERE tenant_id=$1 AND order_id=$2 AND order_installment_id IS NULL) AND (SELECT sum(amount_cents) FROM sales_order_installments WHERE tenant_id=$1 AND order_id=$2)=(SELECT amount_cents FROM sales_orders WHERE tenant_id=$1 AND id=$2) AS valid", [context.tenantId, id])
  if (!valid.rows[0]?.valid) conflict("Concilie os títulos das parcelas antes de concluir o pedido")
}

export async function originateSchedule(context: AuthorizedContext, headers: CommandHeaders, order: string, accepted: boolean) {
  const { client, tenantId } = context
  if (!await hasCheckout(context, order)) {
    if (accepted) conflict("Aceitar encomenda exige checkout completo")
    return
  }
  const existing = await client.query("SELECT EXISTS(SELECT 1 FROM receivables WHERE tenant_id=$1 AND order_id=$2) AS present", [tenantId, order])
  if (existing.rows[0]?.present) conflict("Pedido já possui títulos; concilie antes de originar parcelas")
  await client.query("UPDATE sales_order_installments SET due_on=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date WHERE tenant_id=$1 AND order_id=$2 AND kind='entry' AND due_on IS NULL", [tenantId, order])
  const rows = await client.query("SELECT i.id,i.due_on::text,i.amount_cents,c.customer_snapshot->>'legalName' AS customer FROM sales_order_installments i JOIN sales_order_checkouts c ON c.tenant_id=i.tenant_id AND c.order_id=i.order_id WHERE i.tenant_id=$1 AND i.order_id=$2 ORDER BY i.number", [tenantId, order])
  for (const row of rows.rows) {
    const id = randomUUID()
    await client.query("INSERT INTO receivables(id,tenant_id,order_id,order_installment_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,$4,$5,$6,$7,'open')", [id, tenantId, order, row.id, row.customer, row.due_on, row.amount_cents])
    await record(context, headers, "receivable", id, "receivable.created", { orderId: order, orderInstallmentId: row.id, amount: decimal(BigInt(String(row.amount_cents)), 2), revision: 1, source: accepted ? "accepted_order_schedule" : "confirmed_order_schedule" })
  }
  await verifyReceivables(context, order)
}

export async function originateOnCompletion(context: AuthorizedContext, headers: CommandHeaders, order: string) {
  if (await hasCheckout(context, order)) return verifyReceivables(context, order)
  const origin = (await context.client.query("SELECT id,customer_name,due_date::text,amount_cents FROM sales_orders WHERE tenant_id=$1 AND id=$2 AND status='confirmed'", [context.tenantId, order])).rows[0]
  if (!origin) conflict("A origem do recebível exige um pedido confirmado desta empresa")
  const amount = BigInt(String(origin.amount_cents)), id = randomUUID()
  if (amount < 1n || amount > 99999999999999n) throw new Problem(422, "invalid_input", "Valor do recebível fora do limite")
  await context.client.query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,$4,$5,$6,'open')", [id, context.tenantId, order, origin.customer_name, origin.due_date, amount])
  await record(context, headers, "receivable", id, "receivable.created", { orderId: order, amount: decimal(amount, 2), revision: 1 })
}

export async function cancelUnpaid(context: AuthorizedContext, headers: CommandHeaders, order: string) {
  if (!await hasCheckout(context, order)) return
  const { client, tenantId } = context
  const receipts = await client.query("SELECT EXISTS(SELECT 1 FROM receivables r JOIN receivable_payments p ON p.tenant_id=r.tenant_id AND p.receivable_id=r.id WHERE r.tenant_id=$1 AND r.order_id=$2 AND p.kind='receipt' AND NOT EXISTS(SELECT 1 FROM receivable_payments reversed WHERE reversed.tenant_id=p.tenant_id AND reversed.reverses_id=p.id)) AS present", [tenantId, order])
  if (receipts.rows[0]?.present) conflict("Há recebimentos nas parcelas. Registre os estornos explicitamente antes de cancelar")
  const rows = await client.query("SELECT id,revision FROM receivables WHERE tenant_id=$1 AND order_id=$2 AND status<>'cancelled' ORDER BY id FOR UPDATE", [tenantId, order])
  for (const row of rows.rows) {
    const revision = revisionValue(row.revision), next = nextRevision(revision)
    await client.query("UPDATE receivables SET status='cancelled',payment_id=NULL,revision=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, row.id, next])
    await record(context, headers, "receivable", String(row.id), "receivable.cancelled", { orderId: order, previousRevision: revision, revision: next, source: "unshipped_order_cancellation", outstandingAmount: "0.00" })
  }
}
