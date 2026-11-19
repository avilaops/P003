"use client"

import { useEffect, useRef, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { GuardedLink } from "@/components/shell/navigation-guard"
import { PageTitle } from "@/components/workspace/page-title"
import { Pagination } from "@/components/workspace/pagination"
import { DataTable } from "@/components/workspace/data-table"
import { Button, buttonVariants } from "@/components/ui/button"
import { NewOrderActions } from "./new-order-actions"
import { SearchInput } from "@/components/search-input"
import { RequestError } from "@/components/feedback/session-recovery"
import { useResource } from "@/hooks/use-operation"
import { commercialMoney, orderNumber } from "./order-presentation"
import { formatTaxId } from "@/lib/format-document"
import { Input } from "@/components/ui/input"
import { OrderEmail } from "./order-email"
import { CommercialStatus, commercialRecordAction } from "./commercial-status"

type Row = { id: string; number: string; revision: number; customerName: string; seller?:string|null; sellerKind?:string; stage?:string; staleDays?:number; pastValidity?:boolean; dueKind?:string; customerTaxId?: string; amount: string; status: string; expired?: boolean; pricingOrigin?: boolean; validUntil?: string | null; dueDate?: string | null; version?: number }
type Listing = { tenantId: string; canEdit: boolean; total: number; totalAmount?:string; data: Row[] }

const stages:Record<string,string> = { approval:"Aguardando aprovação", production:"Em produção", billed:"Faturado", partial:"Faturamento ou entrega parcial", delivered:"Entregue" }

export function SalesRecordList({ kind, labels }: { kind: "pedidos" | "propostas"; labels: Record<string, string> }) {
  const pathname = usePathname()
  const url = useSearchParams()
  const q = url.get("q") || ""
  const status = url.get("status") || ""
  const rawOffset = Number(url.get("offset") || 0)
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 && rawOffset <= 100000 ? rawOffset : 0
  const [searchInput, setSearchInput] = useState({ source: q, value: q })
  const search = searchInput.source === q ? searchInput.value : q
  function setSearch(value: string) { setSearchInput({ source: q, value }) }
  const from=url.get("from") || "", to=url.get("to") || "", seller=url.get("seller") || "", stage=url.get("stage") || "", validity=url.get("validity") || ""
  const includeCancelled=url.get("includeCancelled")==="true", stale=url.get("stale")==="true"
  const params = new URLSearchParams({ q, status, offset: String(offset), limit:"25",view:"workspace" })
  for (const [key,value] of Object.entries({from,to,seller,stage,validity,includeCancelled:includeCancelled?"true":"",stale:stale?"true":""})) if(value) params.set(key,value)
  const orders = kind === "pedidos"
  const title = orders ? "Pedidos de venda" : "Propostas"
  const singular = orders ? "pedido" : "proposta"
  const result = useResource<Listing>(`/api/erp/${orders ? "orders" : "proposals"}?${params}`)
  const restoredKey = useRef<string | null>(null)
  const scrollKey = result.value ? `sales-scroll:${result.value.tenantId}:${pathname}?${url}` : null
  useEffect(() => {
    if (result.loading || result.error || !scrollKey || restoredKey.current === scrollKey) return
    restoredKey.current = scrollKey
    try {
      const saved = sessionStorage.getItem(scrollKey)
      const position = Number(saved)
      if (saved !== null && Number.isFinite(position) && position >= 0) {
        const frame = requestAnimationFrame(() => window.scrollTo(0, position))
        return () => cancelAnimationFrame(frame)
      }
    } catch { /* Navigation also works when browser storage is unavailable. */ }
  }, [scrollKey, result.loading, result.error])
  function update(next: Record<string,string|number>) {
    const target = new URLSearchParams(url.toString())
    for (const [key, value] of Object.entries(next)) {
      if (value) target.set(key, String(value)); else target.delete(key)
    }
    window.history.replaceState(null, "", `${pathname}${target.size ? `?${target}` : ""}`)
  }
  function remember() {
    if (!scrollKey) return
    try { sessionStorage.setItem(scrollKey, String(window.scrollY)) } catch { /* Storage is optional. */ }
  }
  const filtered = Boolean(q || status || from || to || seller || stage || validity || includeCancelled || stale)
  return <>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><PageTitle>{title}</PageTitle><div className="flex flex-wrap gap-2">
      {orders && result.value && <GuardedLink className={buttonVariants({ variant: "outline" })} href="/vendas/tabela-precos">Tabela de preços</GuardedLink>}
      {result.value?.canEdit && (orders ? <NewOrderActions /> : <GuardedLink className={buttonVariants()} href="/vendas/propostas/novo">Nova proposta</GuardedLink>)}
    </div></div>
    <section className="min-w-0 space-y-4" aria-label={title}>
      <form className="flex flex-wrap items-end gap-3" role="search" aria-label={`Pesquisar ${kind}`} onSubmit={event => { event.preventDefault(); if (search.trim() === q && offset === 0) result.reload(); else update({ q: search.trim(), offset: 0 }) }}>
        <label className="grid min-w-0 flex-1 basis-48 gap-1.5 text-sm">Buscar {kind}<SearchInput type="search" name="q" maxLength={160} value={search} onChange={event => setSearch(event.target.value)} onSearch={value => update({ q: value.trim(), offset: 0 })} placeholder="Número, cliente ou CPF/CNPJ" /></label>
        <label className="grid gap-1.5 text-sm">Situação<select name="status" className="h-10 rounded-lg border border-input bg-background px-3" value={status} onChange={event => update({ status: event.target.value, offset: 0 })}><option value="">Todas</option>{Object.entries(labels).filter(([key]) => key !== "superseded").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <Button type="submit" disabled={result.loading}>Pesquisar</Button>{(filtered || search) && <Button type="button" variant="outline" onClick={() => { setSearch(""); update({q:"",status:"",offset:0,from:"",to:"",seller:"",stage:"",validity:"",stale:"",includeCancelled:""}) }}>Limpar filtros</Button>}
        <details className="min-w-0 basis-full"><summary className="w-fit cursor-pointer text-sm font-medium">Mais filtros</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="grid gap-1 text-sm">Criado de<Input type="date" value={from} max={to || undefined} onChange={e=>update({from:e.target.value,offset:0})}/></label>
            <label className="grid gap-1 text-sm">Criado até<Input type="date" value={to} min={from || undefined} onChange={e=>update({to:e.target.value,offset:0})}/></label>
            <label className="grid gap-1 text-sm">Vendedor ou responsável<Input value={seller} maxLength={100} onChange={e=>update({seller:e.target.value,offset:0})}/></label>
            {orders ? <>
              <label className="grid gap-1 text-sm">Etapa do pedido<select className="h-10 rounded-lg border bg-background px-3" value={stage} onChange={e=>update({stage:e.target.value,offset:0})}><option value="">Todas</option>{Object.entries(stages).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeCancelled} onChange={e=>update({includeCancelled:e.target.checked?"true":"",offset:0})}/>Incluir cancelados</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stale} onChange={e=>update({stale:e.target.checked?"true":"",offset:0})}/>Rascunhos parados há mais de 7 dias</label>
            </> : <label className="grid gap-1 text-sm">Prazo de validade<select className="h-10 rounded-lg border bg-background px-3" value={validity} onChange={e=>update({validity:e.target.value,offset:0})}><option value="">Todos</option><option value="current">Dentro da validade</option><option value="expired">Validade vencida</option></select></label>}
          </div>
        </details>
      </form>
      {result.loading ? <p role="status">Carregando {kind}…</p> : result.error ? <div role="alert" className="space-y-3"><RequestError message={result.error} status={result.status} /><Button variant="outline" onClick={result.reload}>Tentar novamente</Button></div> : <>
        <p role="status" className="text-sm text-muted-foreground">{result.value?.total || 0} {singular}(s){filtered ? " encontrado(s)" : ""}{result.value?.totalAmount !== undefined && <> • Total {commercialMoney(result.value.totalAmount)}</>}</p>
        {result.value?.data.length ? <div className="workspace-list-scroll rounded-lg border bg-card" role="region" aria-label={`Lista de ${kind}`} tabIndex={0}><DataTable className="table-fixed text-left text-sm sm:table-auto"><caption className="sr-only">{title}</caption><thead className="bg-muted/50"><tr><th className="p-2 sm:p-3" scope="col">{orders ? "Pedido e cliente" : "Proposta e cliente"}</th><th className="hidden p-3 sm:table-cell" scope="col">Situação</th><th className="hidden p-3 lg:table-cell" scope="col">{orders ? "Vencimento financeiro" : "Validade"}</th><th className="w-[42%] p-2 text-right sm:w-auto sm:p-3" scope="col">Valor</th></tr></thead><tbody>{result.value.data.map(item => {
          const action = commercialRecordAction(kind, item.id, item.status, result.value!.canEdit && !(orders && item.pricingOrigin))
          const date = orders ? item.dueDate : item.validUntil
          const state = item.expired && item.status==="sent" ? "expired" : item.status
          const dateText=date ? date.split("-").reverse().join("/") : item.dueKind==="settled" ? "Sem título em aberto" : "Não informado"
          return <tr key={item.id} className="border-t align-top hover:bg-muted/30">
            <td className="min-w-0 p-2 lg:py-1.5">
              <div className="grid gap-1 lg:flex lg:flex-wrap lg:items-baseline lg:gap-x-3">
                <GuardedLink onClick={remember} className="shrink-0 font-semibold text-primary underline underline-offset-4" href={`/vendas/${kind}/${item.id}`}>{orders ? orderNumber(item.number) : `Proposta ${item.number}`}</GuardedLink>
                <p className="line-clamp-2 break-words [overflow-wrap:anywhere]" title={item.customerName}>{item.customerName}</p>
              </div>
              <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                {!orders && (item.version ?? 0)>1 && <span>Versão {item.version}</span>}
                {item.customerTaxId && <span>{formatTaxId(item.customerTaxId)}</span>}
                {item.seller && <span>{item.sellerKind==="owner" ? "Responsável" : "Vendedor"} • {item.seller}</span>}
                {item.stage && <span>{stages[item.stage]}</span>}
                {(item.staleDays ?? 0)>7 && <span>Parado há {item.staleDays} dias</span>}
                {item.pastValidity && item.status==="draft" && <span>Validade vencida</span>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground lg:hidden">{orders ? "Vencimento financeiro" : "Validade"} • {dateText}</p>
              <div className="mt-2 sm:hidden"><CommercialStatus status={state} label={labels[state]} /></div>
            </td>
            <td className="hidden p-2 sm:table-cell lg:py-1.5"><CommercialStatus status={state} label={labels[state]} /></td>
            <td className="hidden p-2 lg:table-cell lg:py-1.5">{dateText}</td>
            <td className="p-2 text-right lg:py-1">
              <div className="grid justify-items-end gap-1 lg:flex lg:flex-wrap lg:items-baseline lg:justify-end lg:gap-x-3">
                <p className="break-words tabular-nums [overflow-wrap:anywhere]">{commercialMoney(item.amount)}</p>
                <GuardedLink onClick={remember} href={action.href} className="inline-flex min-h-10 items-center font-medium text-primary underline underline-offset-4 lg:min-h-7">{action.label}<span className="sr-only"> {orders ? orderNumber(item.number) : `proposta ${item.number}`}</span></GuardedLink>
                {orders && result.value!.canEdit && item.status !== "cancelled" && Number.isSafeInteger(item.revision) && <details className="max-w-full open:basis-full"><summary className="cursor-pointer py-1 text-xs text-muted-foreground">Mais ações</summary><OrderEmail id={item.id} number={item.number} tenantId={result.value!.tenantId} etag={`"${item.revision}"`} onReload={result.reload} /></details>}
              </div>
            </td>
          </tr>
        })}</tbody></DataTable></div> : <p>{filtered ? (orders ? "Nenhum pedido encontrado para estes filtros." : "Nenhuma proposta encontrada para estes filtros.") : (orders ? "Nenhum pedido cadastrado." : "Nenhuma proposta cadastrada.")}</p>}
        {(offset>0 || (result.value?.total ?? 0)>25) && <Pagination offset={offset} pageSize={25} total={result.value?.total || 0} maxOffset={100000} onOffsetChange={value => update({ offset: value })} />}
      </>}
    </section>
  </>
}
