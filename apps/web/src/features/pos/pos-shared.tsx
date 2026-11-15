"use client"

import Link from "next/link"
import { DataTable } from "@/components/workspace/data-table"
import { Button } from "@/components/ui/button"
import { RequestError } from "@/components/feedback/session-recovery"
import { CommercialDocument, DocumentSection, type DocumentIssuer } from "@/components/documents/commercial-document"
import { useResource } from "@/hooks/use-operation"
import { money, when, methodNames, type Account, type CashSession, type Sale } from "./pos-model"
import "./pos-print.css"

export const controlClass = "h-9 min-w-0 w-full rounded-lg border border-input bg-background px-3 text-sm"
export function AccountSelect({ accounts, value, onChange, label, cashOnly = false, disabled = false, omit }: { accounts: Account[]; value: string; onChange: (value: string) => void; label: string; cashOnly?: boolean; disabled?: boolean; omit?: string }) {
  return <label className="grid min-w-0 gap-1.5 text-xs font-medium">{label}<select aria-label={label} required className={controlClass} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}><option value="">Selecione uma conta</option>{accounts.filter(account => account.status === "active" && account.id !== omit && (!cashOnly || account.accountType === "cash")).map(account => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></label>
}
export function CashNav({ id }: { id?: string }) {
  return <nav aria-label="Operações do PDV" className="flex flex-wrap gap-x-5 gap-y-2 text-sm print:hidden"><Link className="text-primary underline" href="/vendas/pdv">Frente de caixa</Link><Link className="text-primary underline" href={`/vendas/pdv/fechamento${id ? `?caixa=${id}` : ""}`}>Fechamento do caixa</Link><Link className="text-primary underline" href="/vendas/pdv/historico">Histórico dos caixas</Link></nav>
}
export function Failure({ message, status, retry }: { message: string; status?: number; retry?: () => void }) {
  return <div className="space-y-2" role="alert"><RequestError message={message} status={status} />{retry && <Button variant="outline" onClick={retry}>Consultar novamente</Button>}</div>
}
export function SessionSummary({ session }: { session: CashSession }) {
  return <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-4">{[["Abertura", session.openingAmount], ["Dinheiro em vendas", session.totals.cash], ["PIX", session.totals.pix], ["Débito", session.totals.debit], ["Crédito", session.totals.credit], ["Suprimentos", session.totals.supplies], ["Sangrias", session.totals.withdrawals], ["Estornos em dinheiro", session.totals.refunds], ["Dinheiro esperado", session.totals.expectedCash], ["Dinheiro contado", session.totals.countedCash], ["Diferença", session.totals.difference]].filter(([, value]) => value != null).map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-medium tabular-nums">{money(value)}</dd></div>)}</dl>
}
export function SaleReceipt({ sale, register, tenantId, onClose }: { sale: Sale; register?: string; tenantId: string; onClose: () => void }) {
  const company = useResource<{ tenantId: string; data: DocumentIssuer }>("/api/erp/company")
  const issuer = company.value?.tenantId === tenantId && company.value.data.legalName ? company.value.data : undefined
  const identity = `${register || "PDV"} • ${when(sale.createdAt)} • ${sale.status === "cancelled" ? "Cancelada" : "Concluída"}`
  return <section aria-label="Comprovante da venda">
    <div className="flex flex-wrap gap-2 print:hidden"><Button variant="outline" disabled={company.loading || !issuer} onClick={() => window.print()}>Imprimir comprovante</Button><Button variant="outline" onClick={onClose}>Fechar comprovante</Button></div>
    {!company.loading && !issuer && <p role="alert" className="mt-2 text-sm">Não foi possível conferir o emitente desta empresa para imprimir o comprovante.</p>}
    {issuer && !company.loading && <CommercialDocument data-pos-receipt title="Comprovante de venda" identity={identity} issuer={issuer}>
      <DocumentSection title="Identificação"><p>Venda: {sale.id}</p><p>Cliente: {sale.customerName || "Não informado"}</p></DocumentSection>
      <DocumentSection title="Itens da venda"><DataTable className="commercial-document-table" aria-label="Itens do comprovante"><thead><tr><th>Produto</th><th>Quantidade</th><th>Total</th></tr></thead><tbody>{sale.items?.map(item => <tr key={item.productId}><td>{item.name}<span className="block">{item.sku}</span></td><td>{Number(item.quantity).toLocaleString("pt-BR", { maximumFractionDigits: 6 })}</td><td>{money(item.total ?? item.amount)}</td></tr>)}</tbody></DataTable></DocumentSection>
      <DocumentSection title="Pagamentos">{sale.payments?.map((payment, index) => <p key={index}>{methodNames[payment.method] || payment.method} • {money(payment.amount)}{Number(payment.change) > 0 && ` • Troco: ${money(payment.change)}`}</p>)}</DocumentSection>
      <div className="commercial-document-total"><p>Total: {money(sale.total)}</p></div>
      <p>Comprovante comercial. Documento fiscal disponível no módulo Fiscal.</p>
    </CommercialDocument>}
  </section>
}
