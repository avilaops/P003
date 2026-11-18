"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Pagination } from "@/components/workspace/pagination"
import { PageTitle } from "@/components/workspace/page-title"
import { erpFetch } from "@/lib/api/client"
import { blockerLabels, type FiscalReadiness } from "./nfe-draft-model"
import { noteStatus, type Note } from "./outgoing-nfe-model"
import { withModelReadiness } from "./model-readiness"

type Row = Note & { origin:"imported" | "internal"; orderNumber?:string; sourceOrderId?:string;lotId?:string }
type Page = { tenantId:string; data:Row[]; total:number }
type State = Page & { permissions:string[]; readiness:FiscalReadiness }
const initial = { q:"",status:"",environment:"",from:"",to:"" }
const select = "h-9 min-w-0 rounded-lg border bg-background px-2 text-sm"
const money = new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"})
const displayDate = new Intl.DateTimeFormat("pt-BR",{timeZone:"America/Sao_Paulo"})

export function OutgoingNfes({model = 55}:{model?:55 | 65}) {
  const isConsumer = model === 65
  const label = isConsumer ? "NFC-e" : "NF-e"
  const base = isConsumer ? "/fiscal/nfce" : "/fiscal/notas-saida"
  const [filters, setFilters] = useState(initial)
  const [group,setGroup] = useState<""|"draft"|"issued">("")
  const [offset,setOffset] = useState(0)
  const [reload,setReload] = useState(0)
  const [state,setState] = useState<State | null>(null)
  const [loading,setLoading] = useState(true)
  const [error,setError] = useState("")
  const invalid = !!filters.from && !!filters.to && filters.from > filters.to
  const create = "/fiscal/notas-saida/nova" + (isConsumer ? "?modelo=65" : "")

  function filter(key:keyof typeof filters,value:string) {
    setOffset(0)
    setFilters(previous => ({...previous,[key]:value}))
  }

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") setReload(v => v+1) }
    window.addEventListener("focus",refresh)
    document.addEventListener("visibilitychange",refresh)
    return () => { window.removeEventListener("focus",refresh); document.removeEventListener("visibilitychange",refresh) }
  },[])

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    async function json(path:string) {
      const response = await erpFetch(path,{cache:"no-store",signal})
      const value = await response.json()
      if (!response.ok) throw new Error(value.title || "Não foi possível consultar o fiscal")
      return value
    }
    async function read() {
      if (invalid) return
      try {
        const me = await json("/api/erp/me")
        const tenant = me.tenant?.id
        if (!tenant) throw new Error("Selecione uma empresa para consultar as notas")
        const query = new URLSearchParams({model:String(model),limit:"25",offset:String(offset)})
        for (const [key,value] of Object.entries({...filters,status:filters.status || group})) if (value) query.set(key,value)
        const [page,baseReadiness] = await Promise.all([json("/api/erp/fiscal/outgoing-documents?"+query),json("/api/erp/fiscal/readiness")])
        const ready = await withModelReadiness(baseReadiness,model,baseReadiness.environment,signal)
        const current = await json("/api/erp/me")
        if (tenant !== page.tenantId || tenant !== ready.tenantId || tenant !== current.tenant?.id) throw new Error("A empresa da sessão mudou. Atualize a página.")
        if (!signal.aborted) setState({...page,permissions:current.permissions || [],readiness:ready})
      } catch (reason) {
        if (!signal.aborted) setError(reason instanceof Error ? reason.message : "Consulta fiscal indisponível")
      } finally { if (!signal.aborted) setLoading(false) }
    }
    const timer = window.setTimeout(() => { setLoading(!invalid); setState(null); setError(""); void read() },150)
    return () => { clearTimeout(timer); controller.abort() }
  },[filters,group,invalid,model,offset,reload])

  const ready = state?.readiness
  return <main className="mx-auto w-full min-w-0 max-w-7xl space-y-4 px-4 pb-24 pt-6 lg:px-6">
    <section aria-label={isConsumer ? "Notas fiscais de consumidor" : "Notas fiscais de saída"} className="form-section min-w-0 space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-3">
        <PageTitle>{isConsumer ? label : "NF-e de saída"}</PageTitle>
        {ready && <span className="rounded-full border px-3 py-1 text-xs">Ambiente • {ready.profileConfigured ? ready.environment === "production" ? "Produção" : "Homologação" : "Não configurado"}</span>}
      </div><div className="flex flex-wrap items-center gap-3">
        {state?.permissions.includes("fiscal.nfe.manage") && <Link className={buttonVariants()} href={create}>Nova {label}</Link>}
        {!isConsumer && state?.permissions.includes("sales.orders.read") && <Link className="text-primary underline" href="/vendas/devolucoes">Devoluções de venda</Link>}
        {!isConsumer && state?.permissions.includes("fiscal.nfe.manage") && <details><summary className="cursor-pointer text-sm">Mais ações</summary><Link className="text-primary underline" href="/fiscal/notas-saida/importar">Importar XML</Link></details>}
      </div></header>
      {isConsumer && ready && ready.blockers.length > 0 && <section aria-label="Pendências de emissão" className="space-y-2 rounded-lg border p-3 text-sm"><strong>Pendências para emitir NFC-e</strong><ul className="list-disc pl-5">{ready.blockers.map(code => <li key={code}>{blockerLabels[code] || "Confira a configuração fiscal"}</li>)}</ul><Link className="text-primary underline" href="/preferencias/fiscal/nfce">Configurar NFC-e</Link>{" • "}<Link className="text-primary underline" href="/preferencias/certificado-digital">Certificado A1</Link></section>}
      {isConsumer && <div className="flex flex-wrap gap-2" aria-label="Documentos por etapa">{([["","Todas"],["draft","Rascunhos"],["issued","Emitidas"]] as const).map(([value,title]) => <Button key={title} variant={group===value ? "default" : "outline"} aria-pressed={group===value} onClick={()=>{setGroup(value);filter("status","")}}>{title}</Button>)}</div>}
      <div className="grid min-w-0 items-end gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">Buscar nota<Input maxLength={200} value={filters.q} onChange={e=>filter("q",e.target.value)} placeholder="Destinatário, CPF/CNPJ, número ou chave" /></label>
        <label className="grid gap-1 text-sm">Situação<select aria-label="Situação" className={select} value={filters.status} onChange={e=>filter("status",e.target.value)}><option value="">Todas</option>{Object.entries(noteStatus).filter(([value]) => !group || (group==="draft")===(value==="draft")).map(([value,name])=><option value={value} key={value}>{name}</option>)}</select></label>
      </div>
      <details><summary className="cursor-pointer text-sm">Mais filtros</summary><div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-sm">Ambiente<select aria-label="Ambiente" className={select} value={filters.environment} onChange={e=>filter("environment",e.target.value)}><option value="">Todos</option><option value="production">Produção</option><option value="homologation">Homologação</option></select></label>
        <label className="grid gap-1 text-sm">De<Input type="date" value={filters.from} onChange={e=>filter("from",e.target.value)}/></label>
        <label className="grid gap-1 text-sm">Até<Input type="date" value={filters.to} onChange={e=>filter("to",e.target.value)}/></label>
      </div></details>
      <div className="flex flex-wrap items-center justify-between gap-2"><p role="status">{loading ? "Carregando notas fiscais…" : state ? `${state.total} ${state.total===1 ? "nota" : "notas"}` : ""}</p><div className="flex flex-wrap gap-2"><Button variant="ghost" onClick={()=>{setFilters(initial);setOffset(0);setGroup("")}}>Limpar filtros</Button><Button variant="outline" onClick={()=>setReload(v=>v+1)} disabled={loading}>Atualizar lista</Button></div></div>
      {invalid && <p role="alert">A data inicial deve ser anterior ou igual à final.</p>}
      {error && <p role="alert">{error}</p>}
      {state && !state.data.length && <p>Nenhuma {label} encontrada para esta consulta.</p>}
      {state && <div className="divide-y" aria-label="Lista de notas fiscais de saída">{state.data.map(note=>{
        const imported = note.origin==="imported"
        const href = imported ? "/fiscal/notas-saida/importadas/"+note.id : base+"/"+note.id+(note.lotId && note.sourceOrderId ? `?pedido=${note.sourceOrderId}&lote=${note.lotId}&ambiente=${note.environment}` : "")
        const description = note.status==="draft" ? (state.permissions.includes("fiscal.nfe.manage") ? "Editar rascunho" : "Consultar rascunho") : note.status==="rejected" ? "Conferir rejeição" : "Ver nota e documentos"
        return <article key={note.origin+note.id} className="grid min-w-0 gap-2 py-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0"><Link className="font-medium text-primary underline" href={href}>{note.number ? `${label} ${note.number} • Série ${note.series}` : "Sem número"}</Link><p className="break-words">{note.recipient}</p><p className="text-sm text-muted-foreground">{note.taxId}</p>
            <p className="text-sm">{imported ? "XML importado" : "Preparada no ERP"}{note.sourceOrderId && <> • <Link className="text-primary underline" href={"/vendas/pedidos/"+note.sourceOrderId}>Pedido {note.orderNumber || "de origem"}</Link></>}</p></div>
          <div className="text-sm"><p>{note.date && displayDate.format(new Date(note.date))} • {note.environment==="production" ? "Produção" : "Homologação"}</p><p>Total da nota • {note.amount ? money.format(Number(note.amount)) : "A conferir"}</p></div>
          <div className="text-sm"><strong>{noteStatus[note.status] || note.status}</strong>{note.reason && <p className="break-words">{note.reason}</p>}<p><Link className="text-primary underline" href={href+(imported || note.status==="draft" ? "" : "#fiscal-emission")}>{description}</Link></p>{model===55 && !imported && note.status==="authorized" && note.environment==="production" && state.permissions.includes("service.warranties.manage") && <Link className="text-primary underline" href={"/vendas/garantias/novo?documentId="+note.id+(note.sourceOrderId ? "&orderId="+note.sourceOrderId : "")}>Abrir garantia</Link>}{model===55 && !imported && note.environment==="production" && note.status==="authorized" && note.sourceOrderId && ["sales.orders.manage","fiscal.received_nfe.manage","finance.receivables.manage","inventory.stock.manage"].every(p=>state.permissions.includes(p)) && <p><Link className="text-primary underline" href={"/vendas/pedidos/"+note.sourceOrderId+"?devolucao="+note.id+"#faturamento-devolucoes"}>Registrar devolução no pedido</Link></p>}</div>
        </article>})}</div>}
      {state && (state.total>25 || offset>0) && <Pagination offset={offset} total={state.total} pageSize={25} onOffsetChange={setOffset}/>}
    </section>
  </main>
}
