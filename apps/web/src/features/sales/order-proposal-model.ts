import type { Sale } from "./negotiation-types"

export type ProposalContext = { destinationState: string; taxpayer: boolean; customerName?: string; paymentTerms?: string; deliveryTerms?: string; dueDate?: string }
const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
const percent = (bps: number) => `${(bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`

export function proposalState(sale: Sale | null, pending: boolean): string {
  if (pending) return "Calculando"
  if (!sale?.items.length) return "Em preenchimento"
  return sale.approvalReasons.length ? "Requer aprovação" : "Liberado"
}

/** Explicit commercial allowlist • never serialize a simulation or management payload. */
export function commercialProposal(sale: Sale, context: ProposalContext) {
  const rows = sale.items.map(item => [item.sku, item.name, String(item.quantity), money(item.netCents), money(item.ipiCents), money(item.totalCents)])
  const ipiLabel = sale.ipiBps == null ? "IPI" : `IPI (${percent(sale.ipiBps)})`
  const entryLabel = sale.minimumDownPaymentBps == null ? "Entrada mínima" : `Entrada mínima (${percent(sale.minimumDownPaymentBps)})`
  const totals = [["Valor de tabela sem IPI", money(sale.tableTotalCents)], ["Desconto sem IPI", money(sale.discountCents)], ["Valor negociado sem IPI", money(sale.netSaleCents)], [ipiLabel, money(sale.ipiCents)], ["Total da proposta", money(sale.totalCents)], [entryLabel, money(sale.minimumDownPaymentCents)], ["Entrada negociada", money(sale.downPaymentCents)]]
  const conditions = [
    ...(context.customerName?.trim() ? [`Cliente: ${context.customerName.trim()}`] : []),
    `Destino: ${context.destinationState} • ${context.taxpayer ? "Contribuinte de ICMS" : "Não contribuinte de ICMS"}`,
    `Situação comercial: ${proposalState(sale, false)}`,
    ...(context.paymentTerms?.trim() ? [`Pagamento: ${context.paymentTerms.trim()}`] : []),
    ...(context.deliveryTerms?.trim() ? [`Entrega: ${context.deliveryTerms.trim()}`] : []),
    ...(context.dueDate ? [`Vencimento: ${context.dueDate.split("-").reverse().join("/")}`] : []),
  ]
  const text = ["Proposta comercial • não salva", ...conditions, "", ...sale.items.map(item => `${item.sku} • ${item.name}\nQuantidade: ${item.quantity} • Valor sem IPI: ${money(item.netCents)} • IPI: ${money(item.ipiCents)} • Total: ${money(item.totalCents)}`), "", ...totals.map(([label, value]) => `${label}: ${value}`), "", "Valores do cálculo comercial atual • proposta não salva e sem confirmação de pedido."].join("\n")
  return { text, conditions, rows, totals }
}
