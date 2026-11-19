"use client"

import {useState} from "react"
import Link from "next/link"
import {useCommand,useResource} from "@/hooks/use-operation"
import {Button} from "@/components/ui/button"
import {PageHeader} from "@/components/page-header"
import {RequestError} from "@/components/feedback/session-recovery"

type Row={kind:"order"|"proposal"|"credit";id:string;documentId:string;number:string;customer:string;level:string;amountCents:number;reasons:string[];dueAt:string;revision:number}
const kinds={order:"Pedido",proposal:"Proposta",credit:"Crédito do pedido"}
const approvals:Record<string,string>={discount:"Desconto",belowTarget:"Abaixo da meta",freight:"Frete",downPayment:"Entrada",manager:"Gerência",director:"Diretoria",credit:"Crédito"}
export function ReviewQueue(){
 const result=useResource<{tenantId:string;data:Row[];canManage:boolean;notifications:{kind:string;id:string;at:string;decision:string;reason:string}[]}>("/api/erp/commercial/policies/queue")
 const command=useCommand(),[selected,setSelected]=useState<string[]>([]),[reason,setReason]=useState(""),[notice,setNotice]=useState("")
 const rows=result.value?.data??[], choices=rows.filter(r=>selected.includes(r.kind+r.id))
 async function decide(approved:boolean){
  if(!result.value||!choices.length||!reason.trim()) return
  const response=await command.send("/api/erp/commercial/policies/decisions",result.value.tenantId,{approved,reason,requests:choices.map(({kind,id,revision})=>({kind,id,revision}))})
  if(response){setSelected([]);setReason("");setNotice("Decisão registrada.");result.reload()}
 }
 return <main className="mx-auto max-w-5xl space-y-4 p-4"><PageHeader title="Aprovações comerciais" breadcrumbs={[{label:"Vendas",href:"/vendas"},{label:"Aprovações"}]}/>
 {result.value?.canManage&&<Link className="text-primary underline" href="/preferencias/politicas-vendas">Políticas, prazos e substitutos</Link>}
 {result.loading?<p role="status">Consultando solicitações…</p>:result.error?<RequestError message={result.error} status={result.status}/>:<form onSubmit={e=>{e.preventDefault();void decide(true)}}><fieldset disabled={command.busy||command.uncertain} className="space-y-3">
 {rows.length===0?<p>Nenhuma solicitação pendente para sua alçada.</p>:rows.map(row=><article className="rounded-lg border p-3" key={row.kind+row.id}><label className="flex items-center gap-2"><input type="checkbox" checked={selected.includes(row.kind+row.id)} onChange={e=>setSelected(s=>e.target.checked?[...s,row.kind+row.id]:s.filter(k=>k!==row.kind+row.id))}/><strong>{kinds[row.kind]} {row.number} • {row.customer}</strong></label><p>{(row.amountCents/100).toLocaleString("pt-BR",{style:"currency",currency:"BRL"})} • {approvals[row.level]} • Revisão {row.revision} • Prazo {new Date(row.dueAt).toLocaleString("pt-BR")}</p><p>{row.reasons.map(r=>approvals[r]??r).join(" • ")}</p><Link className="text-primary underline" href={`/vendas/${row.kind==="proposal"?"propostas":"pedidos"}/${row.documentId}`}>Consultar documento</Link></article>)}
 {rows.length>0&&<label className="grid gap-1">Justificativa<textarea className="border p-2" required maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>}</fieldset>
 {choices.length>0&&<div className="mt-3 flex gap-2"><Button disabled={!reason.trim()||command.busy||command.stale} type="submit">{command.uncertain?"Conferir decisão":"Aprovar selecionados"}</Button><Button variant="outline" type="button" disabled={!reason.trim()||command.busy||command.stale||command.uncertain} onClick={()=>void decide(false)}>Recusar selecionados</Button></div>}</form>}
 {!!result.value?.notifications?.length && <section className="space-y-2"><h2 className="font-semibold">Decisões sobre minhas solicitações</h2>{result.value.notifications.map(n=><p key={n.at+n.id}><Link className="underline" href={`/vendas/${n.kind==="sales_proposal"?"propostas":"pedidos"}/${n.id}`}>{n.decision==="approved"?"Aprovada":"Recusada"}</Link> • {n.reason} • {new Date(n.at).toLocaleString("pt-BR")}</p>)}</section>}
 {notice&&<p role="status">{notice}</p>}{command.error&&<p role="alert">{command.error}</p>}{(result.error||command.stale)&&<Button onClick={()=>{command.reset();setSelected([]);setReason("");setNotice("");result.reload()}}>Atualizar fila</Button>}</main>
}
