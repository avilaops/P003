import { randomUUID } from "node:crypto"
import { record } from "../../platform/commands.js"
import { orderShares } from "./receipt-origins.js"
import { capture, reverseSource } from "./journal.js"
import { bumpSeller, conflict, dueDate, lockSeller, missing, money, type Context, type Headers } from "./shared.js"

export function calculateCommission(gross: bigint, rate: bigint, ipi: bigint) {
  const denominator = 1000000n + ipi
  const round = (n: bigint) => (n + denominator / 2n) / denominator
  return { base: round(gross * 1000000n), amount: round(gross * rate) }
}
export async function freezeOrderPolicies(context: Context, order: string) {
  await context.client.query(
    `INSERT INTO order_commission_lines(tenant_id,order_id,product_id,line_number,weight_cents,trigger_event,commission_rate,policy_id)
    SELECT t.tenant_id,t.order_id,l.product_id,l.line_number,l.amount_cents,COALESCE(p.trigger_event,'receipt'),COALESCE(p.commission_rate,t.commission_rate),p.id
    FROM order_commission_terms t JOIN sales_order_lines l USING(tenant_id,order_id)
    LEFT JOIN product_costs c ON c.tenant_id=l.tenant_id AND c.product_id=l.product_id
    LEFT JOIN LATERAL (SELECT p.* FROM commission_policies p WHERE p.tenant_id=t.tenant_id AND p.seller_staff_id=t.seller_staff_id
      AND (p.product_id IS NULL OR p.product_id=l.product_id) AND (p.product_line IS NULL OR p.product_line=c.product_line)
      ORDER BY (p.product_id IS NOT NULL) DESC,(p.product_line IS NOT NULL) DESC LIMIT 1) p ON true
    WHERE t.tenant_id=$1 AND t.order_id=$2 AND t.use_policies ON CONFLICT DO NOTHING`,
    [context.tenantId, order],
  )
}
async function competenceFor(context: Context, seller: string, sourceDate: string) {
  const { rows } = await context.client.query(
    `SELECT greatest(date_trunc('month',$3::date)::date,
    (max(competence)+interval '1 month')::date)::text AS month FROM commission_closings WHERE tenant_id=$1 AND seller_staff_id=$2`,
    [context.tenantId, seller, sourceDate],
  )
  return String(rows[0]!.month)
}
const noCommission = { status: "not_required", applied: false }
async function accrue(
  context: Context,
  headers: Headers,
  event: "receipt" | "invoice",
  order: string,
  source: string,
  day: string,
  gross: bigint,
) {
  const { client, tenantId } = context
  const terms = (
    await client.query("SELECT * FROM order_commission_terms WHERE tenant_id=$1 AND order_id=$2", [tenantId, order])
  ).rows[0]
  if (!terms || (!terms.use_policies && event === "invoice")) return noCommission
  const column = event === "receipt" ? "receipt_id" : "invoice_id"
  const existing = (
    await client.query(
      `SELECT id FROM commission_entries WHERE tenant_id=$1 AND kind=$2 AND ${column}=$3 AND order_id=$4 ORDER BY id`,
      [tenantId, event, source, order],
    )
  ).rows
  if (existing.length) return { status: "applied", applied: true, entryId: String(existing[0]!.id) }
  const seller = String(terms.seller_staff_id),
    paymentDay = Number(terms.payment_day)
  const lines = terms.use_policies
    ? (
        await client.query(
          "SELECT * FROM order_commission_lines WHERE tenant_id=$1 AND order_id=$2 ORDER BY line_number",
          [tenantId, order],
        )
      ).rows
    : [{ weight_cents: 1, trigger_event: "receipt", commission_rate: terms.commission_rate, product_id: null }]
  if (!lines.length) conflict("O pedido precisa das políticas por produto congeladas no aceite")
  if (!lines.some((line) => line.trigger_event === event)) return noCommission
  const denominator = lines.reduce((sum, line) => sum + BigInt(String(line.weight_cents)), 0n)
  if (denominator <= 0n) conflict("A base total das linhas da comissão precisa ser positiva")
  await lockSeller(context, seller)
  const month = await competenceFor(context, seller, day),
    due = dueDate(month, paymentDay)
  let weight = 0n,
    allocated = 0n,
    first: string | undefined
  for (const line of lines) {
    weight += BigInt(String(line.weight_cents))
    const cumulative = (gross * weight + denominator / 2n) / denominator
    const part = cumulative - allocated
    allocated = cumulative
    if (line.trigger_event !== event) continue
    const { base, amount } = calculateCommission(
      part,
      BigInt(String(line.commission_rate)),
      BigInt(String(terms.ipi_rate)),
    )
    const id = randomUUID()
    await client.query(
      `INSERT INTO commission_entries(id,tenant_id,seller_staff_id,seller_name,order_id,kind,${column},
      product_id,source_date,competence,payment_due,base_cents,commission_rate,ipi_rate,payment_day,amount_cents,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        id,
        tenantId,
        seller,
        terms.seller_name,
        order,
        event,
        source,
        line.product_id,
        day,
        month,
        due,
        base,
        line.commission_rate,
        terms.ipi_rate,
        paymentDay,
        amount,
        event === "receipt" ? "Comissão sobre recebimento" : "Comissão sobre faturamento",
      ],
    )
    await record(context, headers, "commission", id, "commission.accrued", {
      orderId: order,
      sourceId: source,
      sellerStaffId: seller,
      amount: money(amount),
      baseAmount: money(base),
      competence: month,
      paymentDue: due,
    })
    first ??= id
  }
  await bumpSeller(context, seller)
  return { status: "applied", applied: true, entryId: first }
}
async function undoAccrual(
  context: Context,
  headers: Headers,
  event: "receipt" | "invoice",
  original: string,
  reversal: string,
  day: string,
  reason: string,
) {
  const { client, tenantId } = context
  const column = event === "receipt" ? "receipt_id" : "invoice_id"
  const entries = (
    await client.query(
      `SELECT e.*,r.id AS previous FROM commission_entries e LEFT JOIN commission_entries r
    ON r.tenant_id=e.tenant_id AND r.reverses_entry_id=e.id WHERE e.tenant_id=$1 AND e.${column}=$2 AND e.kind=$3 ORDER BY e.id`,
      [tenantId, original, event],
    )
  ).rows
  if (!entries.length) return noCommission
  const changed = new Set<string>()
  let first: string | undefined
  for (const e of entries) {
    if (e.previous) {
      first ??= String(e.previous)
      continue
    }
    const seller = String(e.seller_staff_id)
    await lockSeller(context, seller)
    const month = await competenceFor(context, seller, day)
    const id = randomUUID()
    await client.query(
      `INSERT INTO commission_entries(id,tenant_id,seller_staff_id,seller_name,order_id,kind,reversal_id,invoice_id,reverses_entry_id,
      product_id,source_date,competence,payment_due,base_cents,commission_rate,ipi_rate,payment_day,amount_cents,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        id,
        tenantId,
        seller,
        e.seller_name,
        e.order_id,
        event === "receipt" ? "reversal" : "invoice_reversal",
        event === "receipt" ? reversal : null,
        event === "invoice" ? original : null,
        e.id,
        e.product_id,
        day,
        month,
        dueDate(month, Number(e.payment_day)),
        -BigInt(String(e.base_cents)),
        e.commission_rate,
        e.ipi_rate,
        e.payment_day,
        -BigInt(String(e.amount_cents)),
        reason,
      ],
    )
    await record(context, headers, "commission", id, "commission.reversed", {
      sellerStaffId: seller,
      reversesEntryId: e.id,
      sourceId: reversal,
      originalPaymentPreserved: true,
    })
    first ??= id
    changed.add(seller)
  }
  for (const seller of changed) await bumpSeller(context, seller)
  return { status: "applied", applied: true, entryId: first }
}
// Internal hooks use the persisted source and the caller's existing authorized transaction.
export async function onSettlement(
  context: Context,
  headers: Headers,
  wallet: "receivable" | "payable",
  id: string,
  accountingOnly = false,
) {
  const { client, tenantId } = context
  const row = (
    await client.query(
      `SELECT p.*,p.occurred_on::text AS day,COALESCE(original.reference,p.reference) AS transaction_reference,${wallet === "receivable" ? "t.order_id,t.finance_operation_id" : "NULL::uuid AS order_id"} FROM ${wallet}_payments p
    LEFT JOIN ${wallet}_payments original ON original.tenant_id=p.tenant_id AND original.id=p.reverses_id
    JOIN ${wallet}s t ON t.tenant_id=p.tenant_id AND t.id=p.${wallet}_id WHERE p.tenant_id=$1 AND p.id=$2`,
      [tenantId, id],
    )
  ).rows[0]
  if (!row) missing()
  const day = String(row.day),
    document = String(row[wallet + "_id"])
  const restructure =
    row.financial_effect === "non_cash" &&
    (
      await client.query(
        "SELECT 1 FROM finance_operations WHERE tenant_id=$1 AND id::text=$2 AND kind=\'restructure\'",
        [tenantId, row.transaction_reference],
      )
    ).rows.length > 0
  if (row.kind === "reversal") {
    await reverseSource(context, headers, String(row.reverses_id), id, day, String(row.reference))
    if (wallet !== "receivable" || accountingOnly) return noCommission
    const result = await undoAccrual(
      context,
      headers,
      "receipt",
      String(row.reverses_id),
      id,
      day,
      String(row.reference),
    )
    if (!result.applied && row.order_id && !restructure) {
      const shouldExist = (
        await client.query(
          `SELECT 1 FROM order_commission_terms t WHERE t.tenant_id=$1 AND t.order_id=$2
        AND (NOT t.use_policies OR EXISTS(SELECT 1 FROM order_commission_lines l WHERE l.tenant_id=t.tenant_id AND l.order_id=t.order_id AND l.trigger_event='receipt'))`,
          [tenantId, row.order_id],
        )
      ).rows[0]
      if (shouldExist) conflict("Recebimento configurado sem comissão original. Concilie antes de estornar.")
    }
    return result
  }
  await capture(
    context,
    headers,
    wallet + "." + (row.financial_effect === "non_cash" ? "non_cash" : "cash"),
    id,
    wallet,
    document,
    day,
    row.amount_cents,
  )
  for (const part of ["interest", "penalty", "surcharge", "discount"])
    await capture(context, headers, wallet + "." + part, id, wallet, document, day, row[part + "_cents"] ?? 0)
  if (wallet !== "receivable" || restructure || accountingOnly) return noCommission
  const gross = BigInt(String(row.amount_cents))
  if (row.order_id) return accrue(context, headers, "receipt", String(row.order_id), id, day, gross)
  const shares = await orderShares(context, String(row.finance_operation_id), id, gross)
  let result: { status: string; applied: boolean; entryId?: string | undefined } = noCommission
  for (const share of shares) {
    const part = await accrue(context, headers, "receipt", share.orderId, id, day, share.cents)
    if (part.applied) result = part
  }
  return result
}
export async function onPurchaseReceipt(context: Context, headers: Headers, id: string) {
  const row = (
    await context.client.query(
      "SELECT order_id,amount_cents,occurred_on::text AS day FROM purchase_receipts WHERE tenant_id=$1 AND id=$2",
      [context.tenantId, id],
    )
  ).rows[0]
  if (!row) missing()
  await capture(
    context,
    headers,
    "purchase.receipt",
    id,
    "purchase",
    String(row.order_id),
    String(row.day),
    row.amount_cents,
  )
}
export async function onPurchaseReversal(context: Context, headers: Headers, id: string) {
  const row = (
    await context.client.query(
      "SELECT receipt_id,occurred_on::text AS day,reason FROM purchase_receipt_reversals WHERE tenant_id=$1 AND id=$2",
      [context.tenantId, id],
    )
  ).rows[0]
  if (!row) missing()
  await reverseSource(context, headers, String(row.receipt_id), id, String(row.day), String(row.reason))
}
async function undoInvoice(
  context: Context,
  headers: Headers,
  invoice: string,
  source: string,
  day: string,
  reason: string,
) {
  await undoAccrual(context, headers, "invoice", invoice, source, day, reason)
  await reverseSource(context, headers, invoice, source, day, reason)
}
export async function consumeInvoices(context: Context, headers: Headers, order?: string) {
  const { client, tenantId } = context
  const rows = (
    await client.query(
      `SELECT q.invoice_id,q.event_type,q.occurred_on::text AS day,d.source_order_id,
    COALESCE(round(((xpath(\'//*[local-name()="ICMSTot"]/*[local-name()="vNF"]/text()\',xmlparse(document d.authorized_xml)))[1]::text)::numeric*100)::bigint, draft.products_total_cents) AS amount_cents
    FROM finance_invoice_events q JOIN fiscal_nfe_documents d ON d.tenant_id=q.tenant_id AND d.id=q.invoice_id
    JOIN fiscal_nfe_drafts draft ON draft.tenant_id=d.tenant_id AND draft.id=d.id
    JOIN sales_orders o ON o.tenant_id=d.tenant_id AND o.id=d.source_order_id
    WHERE q.tenant_id=$1 AND NOT q.processed AND ($2::uuid IS NULL OR o.id=$2)
    ORDER BY (q.event_type='cancelled'),q.occurred_on,q.invoice_id`,
      [tenantId, order ?? null],
    )
  ).rows
  for (const row of rows) {
    const invoice = String(row.invoice_id),
      orderId = String(row.source_order_id),
      day = String(row.day)
    if (row.event_type === "authorized") {
      await accrue(context, headers, "invoice", orderId, invoice, day, BigInt(String(row.amount_cents)))
      await capture(context, headers, "sale.invoice", invoice, "order", orderId, day, row.amount_cents)
    } else await undoInvoice(context, headers, invoice, invoice, day, "Cancelamento fiscal da nota")
    await client.query(
      "UPDATE finance_invoice_events SET processed=true WHERE tenant_id=$1 AND invoice_id=$2 AND event_type=$3",
      [tenantId, invoice, row.event_type],
    )
  }
}
export const onInvoicedOrder = consumeInvoices
export async function reverseOrderInvoices(
  context: Context,
  headers: Headers,
  order: string,
  id: string,
  day: string,
  reason: string,
) {
  await consumeInvoices(context, headers, order)
  const invoices = (
    await context.client.query(
      "SELECT id FROM fiscal_nfe_documents WHERE tenant_id=$1 AND source_order_id=$2 AND environment='production' AND status IN ('authorized','cancelled')",
      [context.tenantId, order],
    )
  ).rows
  for (const invoice of invoices) await undoInvoice(context, headers, String(invoice.id), id, day, reason)
}
