"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { quantity, useResource, useCommand } from "@/hooks/use-operation"

type Item = { productId:string; name:string; unit:string; remaining:string; received:string }
type Receipt = { id:string; reference:string; occurredOn:string; amount:string; payableId:string|null }
type Progress = { tenantId:string; purchaseOrderId:string; status:string; revision:number; canConfirm:boolean; canReceive:boolean; items:Item[]; receipts:Receipt[] }
const statuses: Record<string,string>={draft:"Rascunho",confirmed:"Confirmada",partially_received:"Recebimento parcial",received:"Recebida",closed:"Encerrada",cancelled:"Cancelada"}
const money=new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"})
const dateLabel=(date:string)=>date.split("-").reverse().join("/")

export function FiscalPurchaseReceipt({base,tenantId,purchaseId}:{base:string;tenantId:string;purchaseId:string}) {
  const resource=useResource<Progress>(base+"/progress")
  const command=useCommand()
  const [quantities,setQuantities]=useState<Record<string,string>>({})
  const [reference,setReference]=useState("")
  const [date,setDate]=useState("")
  const [notice,setNotice]=useState("")
  const [error,setError]=useState("")
  const current=resource.value?.tenantId===tenantId && resource.value.purchaseOrderId===purchaseId ? resource.value : null
  const frozen=command.busy||command.stale||command.uncertain
  async function submit(confirm:boolean) {
    if(!current)return
    setError("")
    setNotice("")
    const items=current.items.filter(i=>quantities[i.productId]?.trim()).map(i=>({productId:i.productId,quantity:quantity(quantities[i.productId]!)}))
    if(!confirm && (!reference.trim() || !date || !items.length || items.some(i=>!i.quantity || Number(i.quantity)<=0))) {
      setError("Informe referência, data e uma quantidade positiva para cada produto entregue.")
      return
    }
    const result=await command.send<Progress>(base+(confirm?"/confirm":"/receive"),tenantId,confirm?{}:{reference,occurredOn:date,items},resource.etag,"POST",body=>body.tenantId===tenantId&&body.purchaseOrderId===purchaseId)
    if(result) {
      setReference("");setQuantities({});setNotice(confirm?"Compra confirmada.":"Recebimento registrado.")
      resource.reload()
    }
  }
  if(resource.loading)return <p role="status">Carregando recebimentos da compra…</p>
  if(resource.error)return <div><p role="alert">{resource.error}</p><Button variant="outline" onClick={resource.reload}>Atualizar recebimentos</Button></div>
  if(!current)return <p role="alert">A compra mudou de empresa. Atualize o vínculo.</p>
  const receiving=["confirmed","partially_received"].includes(current.status)&&current.canReceive&&current.items.some(i=>Number(i.remaining)>0)
  return <section className="space-y-3 rounded-xl border p-4" aria-label="Recebimento físico da nota">
    <h3 className="font-semibold">Recebimento físico</h3>
    <p>Situação da compra • {statuses[current.status]??current.status}</p>
    {current.status==="draft" && current.canConfirm && <Button disabled={command.busy||command.stale} onClick={()=>void submit(true)}>{command.uncertain?"Conferir confirmação anterior":"Confirmar compra vinculada"}</Button>}
    {receiving && <form className="space-y-3" onSubmit={e=>{e.preventDefault();void submit(false)}}>
      <label className="block">Referência da entrega<Input value={reference} onChange={e=>setReference(e.target.value)} disabled={frozen} minLength={3} maxLength={200} required /></label>
      <label className="block">Data do recebimento<Input type="date" value={date} onChange={e=>setDate(e.target.value)} disabled={frozen} required /></label>
      {current.items.filter(i=>Number(i.remaining)>0).map(i=><label className="block" key={i.productId}>Quantidade recebida de {i.name}<span className="block text-sm text-muted-foreground">Saldo • {Number(i.remaining).toLocaleString("pt-BR",{maximumFractionDigits:6})} {i.unit}</span><Input inputMode="decimal" disabled={frozen} value={quantities[i.productId]??""} onChange={e=>setQuantities({...quantities,[i.productId]:e.target.value})}/></label>)}
      <p className="text-sm text-muted-foreground">A confirmação registra os produtos recebidos no estoque e gera uma conta a pagar pelo valor da entrega.</p>
      <Button type="submit" disabled={command.busy||command.stale}>{command.uncertain?"Conferir recebimento anterior":"Registrar recebimento físico"}</Button>
    </form>}
    {(error||command.error) && <p role="alert">{error||command.error}</p>}
    {command.stale && <Button variant="outline" onClick={()=>{command.reset();resource.reload()}}>Atualizar compra</Button>}
    {notice && <p role="status">{notice}</p>}
    {current.receipts.length>0 && <ul className="space-y-2">{current.receipts.map(r=><li className="break-words" key={r.id}><strong>{r.reference}</strong> • {dateLabel(r.occurredOn)} • {money.format(Number(r.amount))}{r.payableId && <span className="block text-sm">Conta a pagar • {r.payableId}</span>}</li>)}</ul>}
  </section>
}
