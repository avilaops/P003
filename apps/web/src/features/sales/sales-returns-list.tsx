"use client"
import Link from "next/link"
import {useState} from "react"
import {useResource} from "@/hooks/use-operation"
import {Input} from "@/components/ui/input"
import {Button} from "@/components/ui/button"
import {PageTitle} from "@/components/workspace/page-title"
import {ownReturnStatus} from "@/features/fiscal/own-return"
type Row={id:string;orderId:string;orderNumber:string;customer:string;originalKey:string;draftId:string|null;receivedId:string|null;origin:string;reason:string;status:string;environment:string;date:string}
export function SalesReturnsList() {
  const [q,setQ]=useState(""),[env,setEnv]=useState(""),[status,setStatus]=useState(""),[offset,setOffset]=useState(0)
  const filters=new URLSearchParams({q,offset:String(offset)});if(env)filters.set("environment",env);if(status)filters.set("status",status)
  const list=useResource<{data:Row[];total:number}>("/api/erp/fiscal/sales-returns?"+filters)
  return <main className="mx-auto max-w-5xl space-y-5 px-4 py-8"><PageTitle>Devoluções de venda</PageTitle>
    <div className="grid gap-3 md:grid-cols-3"><label>Pedido, cliente, chave ou motivo<Input value={q} onChange={e=>{setQ(e.target.value);setOffset(0)}}/></label>
      <label>Ambiente<select className="block min-h-10 w-full rounded border bg-background" value={env} onChange={e=>{setEnv(e.target.value);setOffset(0)}}><option value="">Todos</option><option value="production">Produção</option><option value="homologation">Homologação</option></select></label>
      <label>Situação<select className="block min-h-10 w-full rounded border bg-background" value={status} onChange={e=>{setStatus(e.target.value);setOffset(0)}}><option value="">Todas</option>{Object.entries(ownReturnStatus).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label></div>
    {list.loading?<p role="status">Consultando devoluções…</p>:list.error?<p role="alert">{list.error}</p>:<p>{list.value?.total??0} devoluções encontradas</p>}
    {list.value?.data.map(r=><article className="space-y-1 rounded border p-3" key={r.id}><Link className="font-medium text-primary underline" href={"/vendas/pedidos/"+r.orderId+"#faturamento-devolucoes"}>Pedido {r.orderNumber} • {r.customer}</Link>
      <p>{r.origin==="own"?"Emissão própria":"NF-e do cliente"} • {ownReturnStatus[r.status]} • {r.environment==="production"?"Produção":"Homologação"}</p><p>{r.reason}</p>
      {r.draftId && <Link className="mr-4 text-primary underline" href={"/fiscal/notas-saida/"+r.draftId}>Abrir emissão de entrada</Link>}
      {r.receivedId && <Link className="text-primary underline" href={"/fiscal/monitor/"+r.receivedId+"?origem=vendas"}>Consultar entrada arquivada</Link>}</article>)}
    {(offset>0 || (list.value?.total??0)>25) && <div className="flex gap-2"><Button disabled={!offset} onClick={()=>setOffset(offset-25)}>Anterior</Button><Button disabled={offset+25>=(list.value?.total??0)} onClick={()=>setOffset(offset+25)}>Próxima</Button></div>}
  </main>
}
