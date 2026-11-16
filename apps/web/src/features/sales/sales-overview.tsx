"use client"

import { ChevronDown } from "lucide-react"
import { GuardedLink as Link } from "@/components/shell/navigation-guard"
import { PageHeader } from "@/components/page-header"
import { RequestError } from "@/components/feedback/session-recovery"
import { DataTable } from "@/components/workspace/data-table"
import { Button, buttonVariants } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useResource } from "@/hooks/use-operation"
import type { Schema } from "@/lib/api/types"
import { commercialMoney, orderNumber, orderStatusLabels } from "./order-presentation"
import { CommercialStatus, commercialRecordAction } from "./commercial-status"
import "./sales-workspace.css"

type Listing = Schema<"OrderList"> | Schema<"ProposalList">
type ReadState = { value: Listing | null; loading: boolean; error: string; status: number; reload: () => void }
type Kind = "pedidos" | "propostas"
const proposalStatus: Record<string, string> = { draft: "Rascunho", sent: "Enviada", accepted: "Aceita", rejected: "Rejeitada", cancelled: "Cancelada", superseded: "Substituída" }
const linkClass = "font-medium text-primary underline-offset-4 hover:underline focus-visible:underline"

function DraftSummary({ title, href, resource }: { title: string; href: string; resource: ReadState }) {
  return <div className="sales-summary-card" aria-busy={resource.loading}>
    {resource.loading ? <><span className="sales-summary-placeholder" aria-hidden="true" /><span>{title}</span><span role="status" className="sr-only">Carregando…</span></> : resource.error ? <><span className="font-medium">{title}</span><RequestError message={resource.error} status={resource.status} /><Button variant="outline" size="sm" onClick={resource.reload}>Tentar consultar {title.toLowerCase()} novamente</Button></> : resource.value ? <Link className="sales-summary-link" href={href}><strong className="sales-summary-number tabular-nums">{resource.value.total}</strong><span>{title}</span><span aria-hidden="true" className="sales-summary-arrow">↗</span></Link> : null}
  </div>
}

function UpdatedAt({ value }: { value?: unknown }) {
  if (typeof value !== "string" || !value) return <span className="text-muted-foreground">Não informada</span>
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return <span className="text-muted-foreground">Não informada</span>
  return <time dateTime={date.toISOString()} title={new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(date)}>{new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "America/Sao_Paulo" }).format(date)}</time>
}

function RecentRecords({ kind, title, resource }: { kind: Kind; title: string; resource: ReadState }) {
  const orders = kind === "pedidos"
  const id = `sales-${kind}-title`
  return <section className="sales-recent-panel" aria-labelledby={id}>
    <div className="sales-panel-heading"><h2 id={id}>{title}</h2><Link className={`${linkClass} text-sm`} href={`/vendas/${kind}`}>Ver {orders ? "todos os pedidos" : "todas as propostas"}</Link></div>
    {resource.loading ? <div className="sales-recent-loading" role="status">Carregando {kind}…</div> : resource.error ? <div className="sales-panel-state" role="alert"><RequestError message={resource.error} status={resource.status} /><Button variant="outline" onClick={resource.reload}>Tentar consultar {kind} novamente</Button></div> : resource.value && (resource.value.data.length === 0 ? <div className="sales-panel-state"><p>Nenhum{orders ? " pedido" : "a proposta"} nesta empresa.</p>{resource.value.canEdit && <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={`/vendas/${kind}/novo`}>{orders ? "Novo pedido" : "Novo orçamento"}</Link>}</div> : <div className="sales-recent-table-wrap"><DataTable className="sales-recent-table">
      <caption className="sr-only">{title} recentes • até cinco registros por última atualização</caption>
      <thead><tr><th scope="col">{orders ? "Pedido" : "Proposta"}</th><th scope="col" className="sales-customer-column">Cliente</th><th scope="col" className="sales-status-column">Situação</th><th scope="col" className="sales-date-column">Última atualização</th><th scope="col" className="sales-value-column">Valor</th><th scope="col" className="sales-action-column"><span className="sr-only">Ação</span></th></tr></thead>
      <tbody>{resource.value.data.map(record => {
        const canEdit = resource.value!.canEdit && !(orders && "pricingOrigin" in record && record.pricingOrigin)
        const action = commercialRecordAction(kind, record.id, record.status, canEdit)
        const status = "expired" in record && record.expired ? "Expirada" : (orders ? orderStatusLabels : proposalStatus)[record.status] || record.status
        return <tr key={record.id}>
          <td className="sales-record-identity"><Link className={linkClass} href={`/vendas/${kind}/${record.id}`}>{orders ? orderNumber(record.number) : `Proposta ${record.number}`}</Link><span className="sales-mobile-customer">{record.customerName}</span><span className="sales-mobile-status"><CommercialStatus status={record.status} label={status} /></span><span className="sales-mobile-date">Atualizado em <UpdatedAt value={"updatedAt" in record ? record.updatedAt : undefined} /></span></td>
          <td className="sales-customer-column"><span className="sales-customer-name" title={record.customerName}>{record.customerName}</span></td>
          <td className="sales-status-column"><CommercialStatus status={record.status} label={status} /></td>
          <td className="sales-date-column"><UpdatedAt value={"updatedAt" in record ? record.updatedAt : undefined} /></td>
          <td className="sales-value-column tabular-nums"><span className="sr-only">Valor </span><span>{commercialMoney(record.amount)}</span></td>
          <td className="sales-action-column"><Link className="sales-record-action" href={action.href}>{action.label}</Link></td>
        </tr>
      })}</tbody>
    </DataTable></div>)}
  </section>
}

export function SalesWorkspace() {
  const proposals = useResource<Schema<"ProposalList">>("/api/erp/proposals?sort=updated&limit=5")
  const orders = useResource<Schema<"OrderList">>("/api/erp/orders?sort=updated&limit=5")
  const draftProposals = useResource<Schema<"ProposalList">>("/api/erp/proposals?status=draft&limit=1")
  const draftOrders = useResource<Schema<"OrderList">>("/api/erp/orders?status=draft&limit=1")
  return <div className="sales-overview">
    <PageHeader title="Vendas" breadcrumbs={[{ label: "Vendas", href: "/vendas" }, { label: "Visão geral" }]} actions={<>
      {orders.value && <Link className={buttonVariants({ variant: "outline", className: "h-10 px-3" })} href="/vendas/tabela-precos">Tabela de preços</Link>}
      {proposals.value?.canEdit && <Link className={buttonVariants({ variant: "outline", className: "h-10 px-3" })} href="/vendas/propostas/novo">Novo orçamento</Link>}
      {orders.value?.canEdit && <div className="sales-create-order"><Link className={buttonVariants({ className: "h-10 rounded-r-none px-3" })} href="/vendas/pedidos/novo">Novo pedido</Link><DropdownMenu><DropdownMenuTrigger render={<Button className="h-10 rounded-l-none border-l border-primary-foreground/30 px-2" aria-label="Mais opções de novo pedido" />}><ChevronDown aria-hidden="true" className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem render={<Link href="/vendas/pedidos/novo?modo=catalogo" />}>Pedido pelo catálogo</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>}
    </>} />
    <section className="sales-summary" aria-label="Resumo de vendas">
      <DraftSummary title="Pedidos em rascunho" href="/vendas/pedidos?status=draft" resource={draftOrders} />
      <DraftSummary title="Propostas em rascunho" href="/vendas/propostas?status=draft" resource={draftProposals} />
    </section>
    <div className="sales-recent-panels"><RecentRecords kind="pedidos" title="Pedidos de venda" resource={orders} /><RecentRecords kind="propostas" title="Propostas" resource={proposals} /></div>
  </div>
}
