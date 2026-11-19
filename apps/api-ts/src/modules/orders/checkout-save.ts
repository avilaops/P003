import { loadTerm,verifyPaymentTerm,termReference,type FrozenTerm } from "../commercial/payment-term.js"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { signed64 } from "../../platform/numbers.js"
import { Problem } from "../../platform/problem.js"
import { validateDate } from "../sales/fixed.js"

export const checkoutInputSchema = z.strictObject({
  paymentTerm:termReference.optional(),
  entry: z.strictObject({ paymentMethodId: normalizedDatabaseId.nullable().default(null), dueOn: z.string().nullable().default(null) }),
  installments: z.array(z.strictObject({ paymentMethodId: normalizedDatabaseId, dueOn: z.string(), amountCents: signed64 })),
  manufacturingDays: z.number().int().min(0).max(65535).nullable().default(null), deliveryNotes: z.string(), paymentNotes: z.string(), notes: z.string(), stateRegistration: z.string().nullable().default(null),
})
export type CheckoutInput = z.infer<typeof checkoutInputSchema>
type PaymentMethod = { id: string; code: string; name: string; modality: string }
function invalid(title: string): never { throw new Problem(422, "invalid_input", title) }
function text(raw: string, limit: number) {
  const value = raw.trim()
  if (Array.from(value).length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) invalid("Observações excedem o limite ou contêm caracteres inválidos")
  return value
}
async function method(context: AuthorizedContext, id: string) {
  const row = (await context.client.query<{ data: PaymentMethod }>("SELECT jsonb_build_object('id',id,'code',code,'name',name,'modality',modality) AS data FROM payment_methods WHERE tenant_id=$1 AND id=$2 AND status='active'", [context.tenantId, id])).rows[0]
  if (!row) invalid("Selecione uma forma de pagamento ativa desta empresa")
  return row.data
}
export async function saveCheckout(context: AuthorizedContext, order: string, customer: string, total: bigint, entry: bigint, input: CheckoutInput, frozenTerm?:FrozenTerm|null) {
  const paymentTerm=frozenTerm??(input.paymentTerm ? await loadTerm(context,input.paymentTerm) : null)
  if (paymentTerm) verifyPaymentTerm(total,entry,paymentTerm,input)
  if (total < 1n || total > 99999999999999n || entry < 0n || entry > total || input.installments.length > 120) invalid("Confira total, entrada e quantidade de parcelas")
  if (input.manufacturingDays !== null && input.manufacturingDays > 3650) invalid("Prazo de fabricação deve ter até 3650 dias")
  const deliveryNotes = text(input.deliveryNotes, 2000), paymentNotes = text(input.paymentNotes, 2000), notes = text(input.notes, 10000), stateRegistration = input.stateRegistration === null ? null : text(input.stateRegistration, 40) || null
  if (stateRegistration !== null && /\p{Cc}/u.test(stateRegistration)) invalid("Inscrição estadual contém caracteres inválidos")
  const due = input.entry.dueOn === null ? null : validateDate(input.entry.dueOn)
  const entryMethod = input.entry.paymentMethodId === null ? null : await method(context, input.entry.paymentMethodId)
  let sum = entry
  const prepared: { number: number; kind: string; due: string | null; amount: bigint; method: PaymentMethod }[] = []
  if (entry > 0n) {
    if (!entryMethod) invalid("Informe a forma de pagamento da entrada")
    prepared.push({ number: 0, kind: "entry", due, amount: entry, method: entryMethod })
  }
  for (const [index, item] of input.installments.entries()) {
    const amount = BigInt(item.amountCents)
    if (amount < 1n || amount > 99999999999999n) invalid("Toda parcela exige valor positivo em centavos")
    sum += amount
    prepared.push({ number: index + 1, kind: "balance", due: validateDate(item.dueOn), amount, method: await method(context, item.paymentMethodId) })
  }
  if (sum !== total) invalid("Entrada e parcelas devem somar exatamente o total do pedido")
  const { client, tenantId } = context
  const matches = (await client.query("SELECT EXISTS(SELECT 1 FROM sales_orders WHERE tenant_id=$1 AND id=$2 AND customer_id=$3 AND status='draft' AND amount_cents=$4) AS present", [tenantId, order, customer, total])).rows[0]?.present
  if (!matches) throw new Problem(409, "domain_conflict", "Condições exigem o rascunho e total atuais deste cliente")
  const savedCustomer = (await client.query<{ data: Record<string, unknown> }>("SELECT jsonb_build_object('id',id,'revision',revision,'personType',person_type,'legalName',legal_name,'tradeName',trade_name,'taxId',tax_id,'email',email,'phone',phone,'addresses',addresses,'contacts',contacts) AS data FROM parties WHERE tenant_id=$1 AND id=$2 AND status='active' AND is_customer", [tenantId, customer])).rows[0]?.data
  if (!savedCustomer) throw new Problem(409, "domain_conflict", "Selecione um cliente ativo desta empresa")
  savedCustomer.stateRegistration = stateRegistration
  await client.query("INSERT INTO sales_order_checkouts(tenant_id,order_id,customer_snapshot,entry_amount_cents,entry_payment_method_id,entry_payment_method,entry_due_on,manufacturing_days,delivery_notes,payment_notes,notes,payment_term_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [tenantId, order, savedCustomer, entry, input.entry.paymentMethodId, entryMethod, due, input.manufacturingDays, deliveryNotes, paymentNotes, notes,paymentTerm])
  for (const item of prepared) await client.query("INSERT INTO sales_order_installments(id,tenant_id,order_id,number,kind,payment_method_id,payment_method,due_on,amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID(), tenantId, order, item.number, item.kind, item.method.id, item.method, item.due, item.amount])
}
