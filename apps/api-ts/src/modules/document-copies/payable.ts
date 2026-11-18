import { brl, financialPdf } from "./financial-pdf.js"
import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"

export type Payable = {
  id: string; revision: string; status: string; company: string; tax_id: string; payee: string;
  due: string; amount: string; paid: string; recipient: string | null
}

export async function readPayable(context: AuthorizedContext, id: string) {
  const row = (await context.client.query<Payable>(`
    SELECT p.id,p.revision::text,p.status,t.legal_name AS company,t.tax_id,p.supplier_name AS payee,
      p.due_date::text AS due,p.amount_cents::text AS amount,coalesce((
        SELECT sum(CASE WHEN m.kind='payment' THEN m.amount_cents ELSE -m.amount_cents END)
        FROM payable_payments m WHERE m.tenant_id=p.tenant_id AND m.payable_id=p.id),0)::text AS paid,
      CASE WHEN p.staff_obligation_id IS NOT NULL THEN s.email ELSE party.email END AS recipient
    FROM payables p JOIN tenants t ON t.id=p.tenant_id
    LEFT JOIN purchase_receipts receipt ON receipt.tenant_id=p.tenant_id AND receipt.id=p.receipt_id
    LEFT JOIN purchase_orders o ON o.tenant_id=receipt.tenant_id AND o.id=receipt.order_id
    LEFT JOIN parties party ON party.tenant_id=o.tenant_id AND party.id=o.supplier_id
    LEFT JOIN staff_payroll_obligations obligation ON obligation.tenant_id=p.tenant_id AND obligation.id=p.staff_obligation_id
    LEFT JOIN staff s ON s.tenant_id=obligation.tenant_id AND s.id=obligation.staff_id
    WHERE p.tenant_id=$1 AND p.id=$2`, [context.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Conta a pagar não encontrada")
  return row
}

export function payablePdf(row: Payable) {
  return financialPdf("Título a pagar", row.company, pdf => {
    pdf.font("Helvetica").fontSize(11).text(`CPF/CNPJ • ${row.tax_id}`)
    pdf.moveDown(2)
    const amount = BigInt(row.amount), paid = BigInt(row.paid)
    const fields = [["Favorecido", row.payee], ["Vencimento", row.due.split("-").reverse().join("/")],
    ["Valor do título", brl(amount)], ["Pagamento declarado", brl(paid)], ["Saldo restante", brl(amount - paid)],
    ["Situação", row.status === "paid" ? "Pagamento integral declarado" : paid > 0n ? "Pagamento parcial declarado" : "Em aberto"]]
    for (const [label, value] of fields) {
      pdf.font("Helvetica-Bold").fontSize(10).text(label!)
      pdf.font("Helvetica").fontSize(12).text(value!).moveDown(0.8)
    }
    pdf.moveDown().fontSize(9).fillColor("#4a5761").text(`Título ${row.id} • Revisão ${row.revision}`)
    pdf.text("Valores e pagamentos declarados no ERP.")
  })
}
