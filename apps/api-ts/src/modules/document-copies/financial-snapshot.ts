import type { AuthorizedContext } from "../../platform/access.js"
import { canonicalJson, parseJson, stringifyJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { portfolio, portfolioFilters } from "../finance-insights/portfolio.js"
import { brl, financialPdf } from "./financial-pdf.js"
import { digest } from "./source.js"
import type { z } from "zod"

export const reportFilters = portfolioFilters.omit({ limit: true, offset: true })
type Filters = z.output<typeof reportFilters>
type Company = { legalName: string; taxId: string; details: Record<string, string> }
const companySql = "jsonb_build_object('legalName',t.legal_name,'taxId',t.tax_id,'details',coalesce(cp.details,'{}'::jsonb))"
const date = (day: string) => day.split("-").reverse().join("/")
const money = (decimal: string) => brl(BigInt(decimal.replace(".", "")))
const sideLabel = { receivable: "A receber", payable: "A pagar" }
const bucketLabel = { future: "A vencer", today: "Vence hoje", "1_30": "1 a 30 dias", "31_60": "31 a 60 dias", "61_90": "61 a 90 dias", over90: "Mais de 90 dias" }
const statusLabel = { open: "Em aberto", paid: "Liquidado", cancelled: "Cancelado" }

function writeCompany(pdf: PDFKit.PDFDocument, company: Company) {
  pdf.font("Helvetica").fontSize(10).text(`CPF/CNPJ • ${company.taxId}`)
  const details = company.details
  for (const fields of [["street", "number", "complement", "district", "city", "state", "postalCode"], ["email", "phone"]]) {
    const line = fields.map(key => details[key]).filter(Boolean).join(" • ")
    if (line) pdf.text(line)
  }
  if (typeof details.logoDataUrl === "string" && /^data:image\/(?:png|jpeg);base64,/.test(details.logoDataUrl)) {
    try { pdf.image(Buffer.from(details.logoDataUrl.split(",")[1]!, "base64"), { fit: [90, 42] }) } catch { /* Keep identification for historical images that cannot be decoded. */ }
  }
}

function scopeLabel(filters: Filters) {
  return [
    "Todos os títulos do filtro", filters.side ? sideLabel[filters.side] : "A receber e a pagar",
    filters.q && `Contraparte contém “${filters.q}”`, filters.partyId && `Parceiro ${filters.partyId}`,
    filters.categoryId && `Categoria ${filters.categoryId}`, filters.status && statusLabel[filters.status],
    filters.bucket && bucketLabel[filters.bucket], filters.from && `Vencimento desde ${date(filters.from)}`,
    filters.to && `Vencimento até ${date(filters.to)}`,
  ].filter(Boolean).join(" • ")
}

async function reportSnapshot(context: AuthorizedContext, filters: Filters) {
  const company = (await context.client.query<{ company: Company }>(
    `SELECT ${companySql} AS company FROM tenants t LEFT JOIN company_profiles cp ON cp.tenant_id=t.id WHERE t.id=$1`,
    [context.tenantId],
  )).rows[0]!.company
  const { tenantId, rows, total, totals, buckets, asOf } = await portfolio(context, filters, true)
  const snapshot = { tenantId, company, asOf, filters, total, totals, buckets, rows }
  const title = "Relatório financeiro", scope = scopeLabel(filters)
  const metrics = [
    ["A receber", money(totals.receivable)], ["A pagar", money(totals.payable)],
    ["Recebíveis vencidos", money(totals.overdueReceivable)], ["Pagamentos vencidos", money(totals.overduePayable)],
  ] as const
  return {
    snapshot, hash: digest(canonicalJson(snapshot)), revision: 1, allowed: true, recipient: null, title, scope,
    count: total, summary: { companyName: company.legalName, asOf, totals },
    pdf: () => financialPdf(title, company.legalName, pdf => {
      writeCompany(pdf, company)
      pdf.moveDown().text(scope).text(`Posição em ${date(asOf)} • ${total} título(s)`).moveDown()
      for (const [label, value] of metrics) pdf.text(`${label} • ${value}`)
      if (buckets.length) {
        pdf.moveDown().font("Helvetica-Bold").text("Saldo por faixa de vencimento").font("Helvetica")
        for (const [key, label] of Object.entries(bucketLabel)) {
          const bucket = buckets.find(item => item.bucket === key)
          if (bucket) pdf.text(`${label} • ${bucket.count} título(s) • A receber ${money(bucket.receivable)} • A pagar ${money(bucket.payable)}`)
        }
      }
      for (const r of rows) {
        if (pdf.y > 690) pdf.addPage()
        const status = r.status === "cancelled" ? "Cancelado" : r.status === "paid" ? "Liquidado" : r.settled === "0.00" ? "Em aberto" : "Parcial"
        pdf.moveDown().font("Helvetica-Bold").fontSize(12).text(`${sideLabel[r.side]} • ${r.party}`)
        pdf.font("Helvetica").fontSize(10).text(`Título ${r.id} • Revisão ${r.revision}`)
        pdf.text(`Vencimento • ${date(r.dueDate)} • ${status}`)
        pdf.text(`Original • ${money(r.amount)}    Liquidado • ${money(r.settled)}    Saldo • ${money(r.outstanding)}`)
      }
    }),
  }
}

export async function financialSnapshot(context: AuthorizedContext, id: string | null, filters: Filters = {}) {
  if (!id) return reportSnapshot(context, filters)
  const row = (await context.client.query<{
    company: Company; recipient: string | null; id: string; party: string; due_date: string; amount: string;
    settled: string; outstanding: string; status: string; revision: string; order_id: string | null
  }>(`
    SELECT ${companySql} AS company, coalesce(c.customer_snapshot->>'email',p.email) AS recipient,
      r.id,r.customer_name AS party,r.due_date::text,r.amount_cents::text AS amount,s.amount::text AS settled,
      (CASE WHEN r.status='cancelled' THEN 0 ELSE r.amount_cents-s.amount END)::text AS outstanding,
      r.status,r.revision::text,r.order_id
    FROM receivables r JOIN tenants t ON t.id=r.tenant_id LEFT JOIN company_profiles cp ON cp.tenant_id=t.id
    LEFT JOIN sales_orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id)
    LEFT JOIN parties p ON (p.tenant_id,p.id)=(o.tenant_id,o.customer_id)
    LEFT JOIN sales_order_checkouts c ON (c.tenant_id,c.order_id)=(o.tenant_id,o.id)
    CROSS JOIN LATERAL(SELECT coalesce(sum(CASE WHEN pay.kind='receipt' THEN pay.amount_cents ELSE -pay.amount_cents END),0) AS amount
      FROM receivable_payments pay WHERE (pay.tenant_id,pay.receivable_id)=(r.tenant_id,r.id)) s
    WHERE r.tenant_id=$1 AND r.id=$2`, [context.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Título a receber não encontrado")
  // Preserve the field order and numeric JSON tokens of existing single-title previews.
  const receivable = {
    id: row.id, party: row.party, dueDate: row.due_date, amountCents: BigInt(row.amount), settledCents: BigInt(row.settled),
    outstandingCents: BigInt(row.outstanding), status: row.status, revision: BigInt(row.revision), ...(row.order_id ? { sourceId: row.order_id } : {}),
  }
  const snapshot = {
    tenantId: context.tenantId, company: parseJson(canonicalJson(row.company)), recipient: row.recipient, receivables: [receivable], payables: [],
  }
  const title = "Título a receber", scope = "Um título a receber • valores e recebimentos declarados no sistema"
  return {
    snapshot, hash: digest(stringifyJson(snapshot)), revision: receivable.revision, allowed: row.status !== "cancelled",
    recipient: row.recipient, title, scope, count: 1, summary: undefined,
    pdf: () => financialPdf(title, row.company.legalName, pdf => {
      writeCompany(pdf, row.company)
      pdf.moveDown().text(scope).moveDown().font("Helvetica-Bold").fontSize(12).text(`A receber • ${row.party}`)
      pdf.font("Helvetica").fontSize(10).text(`Título ${row.id} • Revisão ${row.revision}`)
      const status = row.status === "paid" ? "Recebimento declarado" : row.status === "cancelled" ? "Cancelado" : "Em aberto"
      pdf.text(`Vencimento • ${date(row.due_date)} • ${status}`)
      pdf.text(`Valor • ${brl(receivable.amountCents)}    Recebido declarado • ${brl(receivable.settledCents)}    Saldo • ${brl(receivable.outstandingCents)}`)
      if (row.order_id) pdf.text(`Pedido de origem • ${row.order_id}`)
      pdf.moveDown().fontSize(9).text("Valores e pagamentos declarados no ERP. A conciliação bancária e a quitação integral do pedido dependem de conferência.")
    }),
  }
}
