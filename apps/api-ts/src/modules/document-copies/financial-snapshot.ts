import type { AuthorizedContext } from "../../platform/access.js"
import { canonicalJson, parseJson, stringifyJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { digest } from "./source.js"
import { brl, financialPdf } from "./financial-pdf.js"

type Integer = number | bigint
type Row = { id: string; party: string; dueDate: string; amountCents: Integer; settledCents: Integer; outstandingCents: Integer; status: string; revision: Integer; sourceId?: string }
type FinancialSnapshot = { tenantId: string; company: { legalName: string; taxId: string; details: Record<string, string> }; recipient: string | null; receivables: Row[]; payables: Row[] }
const status = (s: string) => s === "cancelled" ? "Cancelado" : s === "paid" ? "Recebimento ou pagamento declarado" : "Em aberto"
export const financialScope = (id: string | null) => id ? "Um título a receber • valores e recebimentos declarados no sistema" :
  "Primeiros 100 registros por fonte • contas a receber e a pagar • ordem de vencimento e ID • indicadores referentes exclusivamente a este recorte"
export const financialTitle = (id: string | null) => id ? "Título a receber" : "Relatório financeiro"

export function financialEmailContent(snapshot: FinancialSnapshot, id: string | null) {
  if (!id) return {
    suggestedSubject: "Relatório financeiro • contas a receber e a pagar",
    suggestedMessage: "Olá!\n\nReunimos no PDF as contas a receber e a pagar, organizadas por vencimento. O relatório inclui até 100 títulos de cada grupo, com os valores registrados e os saldos correspondentes.",
    details: [{ label: "Títulos a receber no relatório", value: String(snapshot.receivables.length) }, { label: "Títulos a pagar no relatório", value: String(snapshot.payables.length) }],
  }
  const row = snapshot.receivables[0]!
  const due = row.dueDate.split("-").reverse().join("/")
  return {
    suggestedSubject: `Demonstrativo do título • vencimento em ${due}`,
    suggestedMessage: "Olá!\n\nNo PDF em anexo, você encontra o valor original do título, os recebimentos que registramos e o saldo.\n\nSe tiver alguma dúvida sobre esses valores, fale conosco.",
    details: [{ label: "Vencimento", value: due }, { label: "Valor do título", value: brl(BigInt(row.amountCents)) }],
  }
}

export async function financialSnapshot(context: AuthorizedContext, id: string | null) {
  const row = (await context.client.query<{ snapshot: FinancialSnapshot }>(`
      SELECT jsonb_build_object('tenantId',t.id,
        'company',jsonb_build_object('legalName',t.legal_name,'taxId',t.tax_id,'details',COALESCE(cp.details,'{}'::jsonb)),
        'recipient',CASE WHEN $2::uuid IS NULL THEN NULL ELSE (SELECT COALESCE(c.customer_snapshot->>'email',p.email) FROM receivables r JOIN sales_orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id JOIN parties p ON p.tenant_id=o.tenant_id AND p.id=o.customer_id LEFT JOIN sales_order_checkouts c ON c.tenant_id=o.tenant_id AND c.order_id=o.id WHERE r.tenant_id=$1 AND r.id=$2) END,
        'receivables',COALESCE((SELECT jsonb_agg(row_data ORDER BY due_date,id) FROM (
          SELECT r.due_date,r.id,jsonb_build_object('id',r.id,'party',r.customer_name,'dueDate',r.due_date::text,'amountCents',r.amount_cents,'settledCents',totals.amount,'outstandingCents',CASE WHEN r.status='cancelled' THEN 0 ELSE r.amount_cents-totals.amount END,'status',r.status,'revision',r.revision,'sourceId',r.order_id) AS row_data
          FROM receivables r CROSS JOIN LATERAL(SELECT COALESCE(sum(CASE WHEN p.kind='receipt' THEN p.amount_cents ELSE -p.amount_cents END),0)::bigint AS amount FROM receivable_payments p WHERE p.tenant_id=r.tenant_id AND p.receivable_id=r.id) totals
          WHERE r.tenant_id=$1 AND ($2::uuid IS NULL OR r.id=$2) ORDER BY r.due_date,r.id LIMIT 100
        ) rows),'[]'::jsonb),
        'payables',CASE WHEN $2::uuid IS NOT NULL THEN '[]'::jsonb ELSE COALESCE((SELECT jsonb_agg(row_data ORDER BY due_date,id) FROM (
          SELECT r.due_date,r.id,jsonb_build_object('id',r.id,'party',r.supplier_name,'dueDate',r.due_date::text,'amountCents',r.amount_cents,'settledCents',totals.amount,'outstandingCents',CASE WHEN r.status='cancelled' THEN 0 ELSE r.amount_cents-totals.amount END,'status',r.status,'revision',r.revision) AS row_data
          FROM payables r CROSS JOIN LATERAL(SELECT COALESCE(sum(CASE WHEN p.kind='payment' THEN p.amount_cents ELSE -p.amount_cents END),0)::bigint AS amount FROM payable_payments p WHERE p.tenant_id=r.tenant_id AND p.payable_id=r.id) totals
          WHERE r.tenant_id=$1 ORDER BY r.due_date,r.id LIMIT 100
        ) rows),'[]'::jsonb) END) AS snapshot
      FROM tenants t LEFT JOIN company_profiles cp ON cp.tenant_id=t.id WHERE t.id=$1
    `, [context.tenantId, id])).rows[0]?.snapshot
  if (!row || (id && !row.receivables.length)) throw new Problem(404, "not_found", "Título a receber não encontrado")
  // Keep the digest compatible with previously confirmed financial previews.
  const ordered = (r: Row): Row => ({
    id: r.id, party: r.party, dueDate: r.dueDate, amountCents: r.amountCents,
    settledCents: r.settledCents, outstandingCents: r.outstandingCents, status: r.status, revision: r.revision, ...(r.sourceId ? { sourceId: r.sourceId } : {})
  })
  const snapshot: FinancialSnapshot = {
    tenantId: row.tenantId, company: parseJson(canonicalJson(row.company)), recipient: row.recipient,
    receivables: row.receivables.map(ordered), payables: row.payables.map(ordered)
  }
  return { snapshot, hash: digest(stringifyJson(snapshot)), revision: id ? snapshot.receivables[0]!.revision : 1 }
}

export function accountPdf(snapshot: FinancialSnapshot, id: string | null) {
  const { company } = snapshot
  return financialPdf(financialTitle(id), company.legalName, pdf => {
    pdf.font("Helvetica").fontSize(10).text(`CPF/CNPJ • ${company.taxId}`)
    const details = company.details
    for (const fields of [["street", "number", "complement", "district", "city", "state", "postalCode"], ["email", "phone"]]) {
      const line = fields.map(key => details[key]).filter(Boolean).join(" • ")
      if (line) pdf.text(line)
    }
    if (typeof details.logoDataUrl === "string" && /^data:image\/(?:png|jpeg);base64,/.test(details.logoDataUrl)) {
      try { pdf.image(Buffer.from(details.logoDataUrl.split(",")[1]!, "base64"), { fit: [90, 42] }) } catch { /* Keep text identification if the historical image is invalid. */ }
    }
    pdf.moveDown().text(financialScope(id)).moveDown()
    if (!id) {
      const total = (rows: Row[]) => rows.reduce((sum, r) => sum + BigInt(r.outstandingCents), 0n)
      const receive = total(snapshot.receivables), pay = total(snapshot.payables)
      pdf.font("Helvetica-Bold").text(`Saldo do recorte • ${brl(receive - pay)}`)
      for (const [label, rows] of [["A receber", snapshot.receivables], ["A pagar", snapshot.payables]] as const) {
        pdf.font("Helvetica").text(`${label} • ${brl(total(rows))} • ${rows.length} título(s) • ${rows.filter(r => BigInt(r.outstandingCents) > 0n).length} com saldo`)
      }
    }
    for (const [label, rows] of [["A receber", snapshot.receivables], ["A pagar", snapshot.payables]] as const) {
      if (!id && !rows.length) pdf.moveDown().text(`${label} • Nenhum registro neste recorte.`)
      for (const r of rows) {
        if (pdf.y > 690) pdf.addPage()
        pdf.moveDown().font("Helvetica-Bold").fontSize(12).text(`${label} • ${r.party}`)
        pdf.font("Helvetica").fontSize(10).text(`Título ${r.id} • Revisão ${r.revision}`)
        pdf.text(`Vencimento • ${r.dueDate.split("-").reverse().join("/")} • ${status(r.status)}`)
        pdf.text(`Valor • ${brl(BigInt(r.amountCents))}    ${label === "A receber" ? "Recebido" : "Pago"} declarado • ${brl(BigInt(r.settledCents))}    Saldo • ${brl(BigInt(r.outstandingCents))}`)
        if (id && r.sourceId) pdf.text(`Pedido de origem • ${r.sourceId}`)
      }
    }
    pdf.moveDown().fontSize(9).text("Valores e pagamentos declarados no ERP. A conciliação bancária e a quitação integral do pedido dependem de conferência.")
  })
}
