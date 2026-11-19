"use client"

import { useState } from "react"
import { GuardedLink } from "@/components/shell/navigation-guard"
import { Copy, FileDown, Mail, Printer } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PageTitle } from "@/components/workspace/page-title"
import { DataTable } from "@/components/workspace/data-table"
import { CommercialDocument, DocumentSection, type DocumentIssuer } from "@/components/documents/commercial-document"
import { RequestError } from "@/components/feedback/session-recovery"
import { useResource } from "@/hooks/use-operation"
import type { Sale } from "./negotiation-types"
import { commercialProposal, proposalState, type ProposalContext } from "./order-proposal-model"
import "./order-proposal-actions.css"

export type OrderPageHeadingProps = ProposalContext & { tenantId: string; sale: Sale | null; pending: boolean }

export function OrderPageHeading({ tenantId, sale, pending, ...context }: OrderPageHeadingProps) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const [notice, setNotice] = useState("")
  const [fallback, setFallback] = useState("")
  const current = !pending && sale && sale.items.length > 0 ? sale : null
  const state = proposalState(sale, pending)
  return <div className="order-proposal-heading">
    <header className="order-proposal-heading-bar">
      <div className="min-w-0"><GuardedLink className="text-sm text-primary underline" href="/vendas/pedidos">Voltar aos pedidos</GuardedLink><PageTitle className="mt-2 text-lg font-bold uppercase tracking-tight">Novo pedido</PageTitle><p className="mt-2 text-sm text-muted-foreground">Monte o pedido, negocie o desconto e veja na hora se pode fechar.</p></div>
      <div className="order-proposal-heading-actions"><span role="status" className="order-proposal-status" data-released={state === "Liberado"}>{state}</span><Button variant="outline" disabled={!current} onClick={async () => {
        if (!current) return
        const { text } = commercialProposal(current, context)
        try { await navigator.clipboard.writeText(text); setFallback(""); setNotice("Proposta copiada.") }
        catch { setFallback(text); setNotice("A cópia automática não está disponível. Selecione e copie o texto abaixo.") }
      }}><Copy aria-hidden="true" />Copiar proposta</Button><Button variant="outline" disabled={!current} onClick={() => {
        if (!current) return
        const { text } = commercialProposal(current, context)
        // Opens the user's mail app with the proposal text; the saved order sends the PDF from its own page.
        window.location.href = `mailto:?subject=${encodeURIComponent(`Proposta comercial${context.customerName ? ` - ${context.customerName}` : ""}`)}&body=${encodeURIComponent(text)}`
        setNotice("Abrimos seu aplicativo de e-mail com a proposta. Para enviar o PDF por e-mail, salve o pedido e use Enviar por e-mail no detalhe.")
      }}><Mail aria-hidden="true" />Enviar por e-mail</Button><Button variant="outline" disabled={!current} aria-expanded={previewOpen} onClick={() => setPreviewOpen(open => !open)}><FileDown aria-hidden="true" />Salvar PDF</Button></div>
    </header>
    {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
    {fallback && <label className="mt-3 grid gap-2 text-sm">Texto da proposta para copiar<textarea readOnly rows={8} className="w-full rounded-lg border bg-background p-3" value={fallback} onFocus={event => event.currentTarget.select()} /></label>}
    {previewOpen && current && <ProposalPreview key={tenantId} tenantId={tenantId} sale={current} context={context} onClose={() => setPreviewOpen(false)} />}
  </div>
}

function ProposalPreview({ tenantId, sale, context, onClose }: { tenantId: string; sale: Sale; context: ProposalContext; onClose: () => void }) {
  const me = useResource<{ tenant: { id: string } }>("/api/erp/me")
  const company = useResource<{ tenantId: string; data: DocumentIssuer }>("/api/erp/company")
  const loading = me.loading || company.loading
  const issuer = !loading && !me.error && !company.error && tenantId === me.value?.tenant?.id && company.value?.tenantId === tenantId && company.value?.data.legalName ? company.value.data : null
  const proposal = commercialProposal(sale, context)
  return <section data-order-proposal-preview aria-label="Proposta comercial para PDF" className="mt-5">
    <div className="flex flex-wrap items-center gap-3"><Button disabled={!issuer} variant="outline" onClick={() => window.print()}><Printer aria-hidden="true" />Imprimir • salvar PDF</Button><Button variant="ghost" onClick={onClose}>Fechar visualização</Button><p className="text-sm text-muted-foreground">Escolha Salvar como PDF na impressão do navegador.</p></div>
    {loading ? <p role="status" className="mt-3 text-sm">Conferindo emitente da empresa ativa…</p> : !issuer ? <div role="alert" className="mt-3 space-y-3"><RequestError message={me.error || company.error || "O emitente não corresponde à empresa ativa ou não possui razão social cadastrada."} status={me.error ? me.status : company.status} /><Button variant="outline" onClick={() => { me.reload(); company.reload() }}>Consultar emitente novamente</Button></div> : <CommercialDocument title="Proposta comercial" identity="Proposta não salva" issuer={issuer} data-order-proposal-document>
      <DocumentSection title="Condições comerciais">{proposal.conditions.map(condition => <p key={condition} className="whitespace-pre-line">{condition}</p>)}<p>Valores do cálculo comercial atual • proposta não salva e sem confirmação de pedido.</p></DocumentSection>
      <DocumentSection title="Equipamentos"><DataTable className="commercial-document-table"><thead><tr>{["Código", "Equipamento", "Qtd.", "Sem IPI", "IPI", "Total"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{proposal.rows.map((row, index) => <tr key={`${sale.items[index].productId}-${index}`}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></DataTable></DocumentSection>
      <DocumentSection title="Resumo da proposta"><dl className="order-proposal-totals">{proposal.totals.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></DocumentSection>
    </CommercialDocument>}
  </section>
}
