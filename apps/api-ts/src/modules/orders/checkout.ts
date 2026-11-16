import type { TenantContext } from "../../platform/database.js"
import { integer } from "../registrations/query.js"
import { z } from "zod"

const paymentMethod = z.object({ id: z.guid(), code: z.string(), name: z.string(), modality: z.string() })
function decodePaymentMethod(value: unknown) {
  const decoded = paymentMethod.safeParse(value)
  if (!decoded.success) throw Error("Invalid saved checkout payment method")
  return decoded.data
}

export async function loadCheckout(context: TenantContext, orderId: string) {
  const { client, tenantId } = context
  const saved = await client.query("SELECT customer_snapshot,entry_amount_cents,entry_payment_method_id,entry_payment_method,entry_due_on::text,manufacturing_days,delivery_notes,payment_notes,notes FROM sales_order_checkouts WHERE tenant_id=$1 AND order_id=$2", [tenantId, orderId])
  const row = saved.rows[0]
  if (!row) return undefined
  const rows = await client.query("SELECT id,number,payment_method_id,payment_method,due_on::text,amount_cents FROM sales_order_installments WHERE tenant_id=$1 AND order_id=$2 ORDER BY number", [tenantId, orderId])
  let due = row.entry_due_on
  const installments = []
  for (const item of rows.rows) {
    if (integer(item.number) === 0) { due = item.due_on; continue }
    if (item.due_on === null) throw Error("Missing saved installment due date")
    installments.push({ id: item.id, number: integer(item.number), paymentMethodId: item.payment_method_id, paymentMethod: decodePaymentMethod(item.payment_method), dueOn: item.due_on, amountCents: integer(item.amount_cents) })
  }
  const originated = await client.query<{ originated: boolean }>("SELECT EXISTS(SELECT 1 FROM receivables WHERE tenant_id=$1 AND order_id=$2) AS originated", [tenantId, orderId])
  const customer = row.customer_snapshot as Record<string, unknown>
  return {
    confirmationCreatesReceivables: !originated.rows[0]?.originated,
    entry: { amountCents: integer(row.entry_amount_cents), paymentMethodId: row.entry_payment_method_id, paymentMethod: row.entry_payment_method === null ? null : decodePaymentMethod(row.entry_payment_method), dueOn: due },
    installments, manufacturingDays: row.manufacturing_days, deliveryNotes: row.delivery_notes, paymentNotes: row.payment_notes, notes: row.notes,
    customer, stateRegistration: typeof customer.stateRegistration === "string" ? customer.stateRegistration : null,
  }
}
