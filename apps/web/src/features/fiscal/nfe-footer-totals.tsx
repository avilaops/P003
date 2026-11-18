import { amountTotal } from "./nfe-amount-allocation"
import { invoiceTotal, productsTotal, type DraftInput } from "./nfe-draft-model"

export function NfeFooterTotals({ draft }: { draft: DraftInput }) {
  const money = (value: string) => Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
  try {
    const total = invoiceTotal(draft)
    const values = [["Produtos", productsTotal(draft.items)], ["Frete", amountTotal(draft.items, "freightAmount")], ["Seguro", amountTotal(draft.items, "insuranceAmount")], ["Despesas", amountTotal(draft.items, "otherAmount")], ["Desconto", amountTotal(draft.items, "discountAmount")]]
    return <div aria-label="Totais da nota" className="min-w-0 space-y-1"><p className="text-sm font-semibold">Total da nota: {money(total)}</p><p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">{values.map(([label, value]) => <span key={label}>{label}: {money(value)}</span>)}</p></div>
  } catch {
    return <p role="status" className="text-sm">Total pendente • confira quantidades, preços, descontos e alíquotas.</p>
  }
}
