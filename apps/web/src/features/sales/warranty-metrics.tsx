"use client"

import { useState } from "react"
import { GuardedLink as Link } from "@/components/shell/navigation-guard"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PageHeader } from "@/components/page-header"
import { Pagination } from "@/components/workspace/pagination"
import { useResource } from "@/hooks/use-operation"
import { formatCents } from "./sales-indicator-money"

type Metrics={total:number;repeated:number;closed:number;meanHours:string|null;overdue:number;costCents:string;recoveryCents:string;recoveredMicros:string;causes:{cause:string|null;n:number}[];data:{id:string;protocol:string;title:string;costCents:string;recoveryCents:string}[]}
export function WarrantyMetrics(){
  const [period,setPeriod]=useState({from:"",to:""})
  const [offset,setOffset]=useState(0)
  const query=new URLSearchParams({offset:String(offset)})
  if(period.from) query.set("from",period.from)
  if(period.to) query.set("to",period.to)
  const resource=useResource<Metrics>("/api/erp/warranty-metrics?"+query)
  const data=resource.value
  return <main className="mx-auto max-w-6xl space-y-4 p-4"><PageHeader title="Indicadores da assistência" back={{href:"/vendas/garantias",label:"Voltar para garantias"}}/>
    <form className="flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault();const fields=new FormData(e.currentTarget);setOffset(0);setPeriod({from:String(fields.get("from")||""),to:String(fields.get("to")||"")})}}>
      <label>Abertura a partir de<Input type="date" name="from"/></label><label>Abertura até<Input type="date" name="to"/></label><Button type="submit">Aplicar período</Button>
    </form>
    {resource.loading?<p role="status">Consultando assistência…</p>:resource.error?<p role="alert">{resource.error} <Button variant="outline" onClick={resource.reload}>Tentar novamente</Button></p>:data && <>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[
        ["Protocolos abertos no período",data.total],["Reincidências da mesma série",data.repeated],["SLA vencido em andamento",data.overdue],
        ["Tempo médio até encerramento",data.meanHours===null?"Sem encerramentos":Number(data.meanHours).toLocaleString("pt-BR")+" h"],
        ["Protocolos encerrados",data.closed],["Custo de peças e mão de obra",formatCents(data.costCents)],["Recuperação financeira",formatCents(data.recoveryCents)],
        ["Unidades recuperadas do fornecedor",(BigInt(data.recoveredMicros)/BigInt(1000000)).toLocaleString("pt-BR")+(BigInt(data.recoveredMicros)%BigInt(1000000) ? ","+(BigInt(data.recoveredMicros)%BigInt(1000000)).toString().padStart(6,"0").replace(/0+$/,"") : "")]
      ].map(([label,value])=><div key={String(label)} className="rounded border p-3"><dt className="text-sm">{label}</dt><dd className="font-semibold">{value}</dd></div>)}</dl>
      {!!data.causes.length && <section><h2 className="font-semibold">Causa do último laudo por protocolo</h2><ul>{data.causes.map(c=><li key={c.cause??""}>{c.cause??"Sem laudo"} • {c.n}</li>)}</ul></section>}
      <section><h2 className="font-semibold">Protocolos do período</h2>{!data.total?<p>Nenhum protocolo encontrado.</p>:<ul className="divide-y">{data.data.map(r=><li className="flex flex-wrap justify-between gap-2 py-2" key={r.id}><Link className="text-primary underline" href={"/vendas/garantias/"+r.id}>{r.title}</Link><span>Custo {formatCents(r.costCents)} • Recuperado {formatCents(r.recoveryCents)}</span></li>)}</ul>}
      {data.total>25 && <Pagination offset={offset} total={data.total} pageSize={25} onOffsetChange={setOffset}/>}</section>
    </>}
  </main>
}
