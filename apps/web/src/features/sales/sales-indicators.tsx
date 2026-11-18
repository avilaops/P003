"use client"

import { useState } from "react"
import { GuardedLink as Link } from "@/components/shell/navigation-guard"
import { Button } from "@/components/ui/button"
import { Pagination } from "@/components/workspace/pagination"
import { PageHeader } from "@/components/page-header"
import { useResource } from "@/hooks/use-operation"
import { formatCents as money } from "./sales-indicator-money"

const copy:Record<string,[string,string]>={
  "open-proposals":["Valor das propostas abertas","Soma das versões atuais em rascunho ou enviadas."],
  "month-orders":["Valor dos pedidos do mês","Pedidos criados neste mês, pelo horário de São Paulo, com os cancelados excluídos."],
  "conversion":["Conversão em 90 dias","Propostas convertidas em pedido entre as propostas enviadas pela primeira vez nos últimos 90 dias."],
  "approvals":["Aguardando sua aprovação","Solicitações comerciais e de crédito que seu perfil pode decidir agora."],
  "stale-orders":["Pedidos parados","Rascunhos de pedido sem atualização há mais de sete dias."],
  "stale-proposals":["Propostas paradas","Rascunhos de proposta sem atualização há mais de sete dias."],
  "expiring":["Propostas com validade próxima ou vencida","Propostas enviadas com validade encerrada ou que vence nos próximos sete dias."],
}
type Row={kind:"pedidos"|"propostas";id:string;number:string;customer:string;amount:number;converted:boolean;status:string}
type Section={group:string;total:number;amountCents:string;converted:number;data:Row[]}
type Overview={tenantId:string;sections:Section[]}
const statuses:Record<string,string>={draft:"Rascunho",sent:"Enviada",accepted:"Aceita",pending:"Aguardando aprovação",confirmed:"Reservado",completed:"Concluído",cancelled:"Cancelado",rejected:"Rejeitada"}
function number(s:Section) {
  if(["open-proposals","month-orders"].includes(s.group)) return money(s.amountCents)
  if(s.group==="conversion") return s.total ? new Intl.NumberFormat("pt-BR",{style:"percent",maximumFractionDigits:1}).format(s.converted/s.total) : "Sem envios"
  return s.total.toLocaleString("pt-BR")
}
export function SalesIndicators(){
  const read=useResource<Overview>("/api/erp/sales/overview")
  if(read.loading) return <p role="status">Consultando indicadores…</p>
  if(read.error) return read.status===403?null:<div className="mb-4 text-sm"><span>Não foi possível consultar os indicadores comerciais.</span> <Button size="sm" variant="outline" onClick={read.reload}>Consultar indicadores novamente</Button></div>
  const groups=read.value?.sections ?? []
  function cards(keys:string[]) {return groups.filter(s=>keys.includes(s.group)).map(s=><Link key={s.group} className="rounded-lg border p-3 hover:bg-muted/30 focus-visible:outline-2" href={"/vendas/indicadores/"+s.group}>
    <span className="block text-sm">{copy[s.group]?.[0]}</span><strong className="block text-xl tabular-nums">{number(s)}</strong>
    {s.group==="conversion" && <small>{s.converted} de {s.total} propostas</small>}</Link>)}
  return <div className="mb-5 space-y-3"><div className="grid gap-2 sm:grid-cols-3">{cards(["open-proposals","month-orders","conversion"])}</div>
    <section aria-label="Precisa de ação"><h2 className="mb-2 font-semibold">Precisa de ação</h2><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{cards(["approvals","stale-orders","stale-proposals","expiring"])}</div></section></div>
}
export function SalesIndicator({group}:{group:string}) {
  const [offset,setOffset]=useState(0)
  const read=useResource<Overview>("/api/erp/sales/overview?"+new URLSearchParams({group,limit:"25",offset:String(offset)}))
  const section=read.value?.sections[0]
  return <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
    <PageHeader back={{href:"/vendas",label:"Voltar para Vendas"}} title={copy[group]?.[0] || "Indicador comercial"} description={copy[group]?.[1]}/>
    {read.loading?<p role="status">Consultando registros…</p>:read.error?<div role="alert">{read.error} <Button onClick={read.reload}>Tentar novamente</Button></div>:section && <>
      <p className="font-semibold">{number(section)} • {section.total} registro(s){group==="conversion" && " • "+section.converted+" convertido(s)"}</p>
      {group==="approvals" && <Link className="text-primary underline" href="/vendas/aprovacoes">Abrir fila de aprovação</Link>}
      {section.data.length?<ul className="divide-y rounded-lg border">{section.data.map((r,i)=><li key={r.kind+":"+r.id+":"+i} className="grid gap-1 p-3 sm:grid-cols-3">
        <Link className="text-primary underline" href={"/vendas/"+r.kind+"/"+r.id}>{r.kind==="pedidos"?"Pedido":"Proposta"} {r.number}</Link><span>{r.customer}</span>
        <span>{money(r.amount)} • {group==="conversion"?(r.converted?"Convertida":"Sem conversão"):statuses[r.status]??r.status}</span></li>)}</ul>:<p>Nenhum registro neste indicador.</p>}
      {(offset>0 || section.total>25) && <Pagination offset={offset} total={section.total} pageSize={25} onOffsetChange={setOffset}/>}
    </>}
  </div>
}
