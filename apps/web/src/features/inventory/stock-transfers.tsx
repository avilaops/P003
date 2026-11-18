"use client"

import { useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { quantity, useCommand, useResource } from "@/hooks/use-operation"
import { commercialQuantity } from "@/features/sales/order-presentation"
import { stockUrl, type StockList } from "./stock-model"
import { selectClass, type LocationSettings, type TransferRecord, type TransferProduct } from "./stock-location-model"

const endpoint = "/api/erp/stock/transfers"
export function StockTransferForm({config,saved}:{config:LocationSettings;saved:()=>void}) {
  const [fromId,setFrom]=useState(config.openingId||""), [toId,setTo]=useState("")
  const [search,setSearch]=useState(""), [selected,setSelected]=useState<TransferProduct[]>([]), [error,setError]=useState("")
  const list=useResource<StockList>(stockUrl("/api/erp/stock",{q:search,warehouseId:fromId,status:"active",limit:20}))
  const command=useCommand(), disabled=command.busy||command.uncertain
  const [reason,setReason]=useState("")
  return <section className="form-section space-y-3">
    <h2 className="font-semibold">Nova transferência</h2>
    <fieldset disabled={disabled} className="space-y-3"><div className="grid gap-3 sm:grid-cols-2">
      <label>Origem<select className={selectClass} value={fromId} onChange={e=>{setFrom(e.target.value);setSelected([])}}>
        {config.warehouses.map(w=><option key={w.id} value={w.id}>{w.code} • {w.name}</option>)}</select></label>
      <label>Destino<select className={selectClass} value={toId} onChange={e=>setTo(e.target.value)}><option value="">Selecione</option>
        {config.warehouses.filter(w=>w.id!==fromId).map(w=><option key={w.id} value={w.id}>{w.code} • {w.name}</option>)}</select></label></div>
      <label>Buscar produto ou SKU na origem<Input value={search} maxLength={160} onChange={e=>setSearch(e.target.value)} /></label>
      {list.error && <p role="alert">{list.error}</p>}
      {list.value?.tenantId===config.tenantId && <ul className="max-h-52 overflow-y-auto divide-y">{list.value.data.map(p=>
        <li key={p.productId} className="flex flex-wrap items-center justify-between gap-2 py-1"><span>{p.sku} • {p.name} • {commercialQuantity(p.available)} {p.unit} disponíveis</span>
          <Button type="button" variant="outline" disabled={selected.some(item=>item.productId===p.productId)||p.available==="0.000000"}
            onClick={()=>setSelected([...selected,{...p,quantity:""}])}>Adicionar {p.sku}</Button></li>)}</ul>}
      {selected.map(p=><div key={p.productId} className="flex flex-wrap items-end gap-2"><label>Quantidade • {p.sku} ({p.unit})
        <Input inputMode="decimal" value={p.quantity} onChange={e=>setSelected(selected.map(item=>item.productId===p.productId?{...item,quantity:e.target.value}:item))} /></label>
        <Button type="button" variant="outline" onClick={()=>setSelected(selected.filter(item=>item.productId!==p.productId))}>Remover {p.sku}</Button></div>)}
      <label>Motivo<Input value={reason} maxLength={500} onChange={e=>setReason(e.target.value)} /></label>
    </fieldset>
    {(error||command.error) && <p role="alert">{command.error||error}</p>}
    <Button disabled={command.busy} onClick={async()=>{
      const items=selected.map(p=>({productId:p.productId,quantity:quantity(p.quantity)}))
      if(!command.uncertain && (!items.length||items.some(i=>!i.quantity||i.quantity==="0.000000")||!toId||fromId===toId||reason.trim().length<3)) {
        setError("Selecione depósitos distintos, informe quantidades positivas e descreva o motivo."); return
      }
      setError("")
      const result=await command.send<{tenantId:string}>(endpoint,config.tenantId,{fromId,toId,reason,items},"","POST",r=>r.tenantId===config.tenantId)
      if(result){ setSelected([]);setReason("");list.reload();saved() }
    }}>{command.uncertain?"Repetir confirmação":"Confirmar transferência"}</Button>
  </section>
}

export function TransferList({config,saved}:{config:LocationSettings;saved:()=>void}) {
  const selected=useSearchParams().get("documento")
  const [offset,setOffset]=useState(0),[id,setId]=useState(selected||"")
  const list=useResource<{tenantId:string;data:TransferRecord[];hasMore:boolean}>(stockUrl(endpoint,{offset,limit:20,id:selected}))
  return <section className="form-section space-y-3"><h2 className="font-semibold">Transferências registradas</h2>
    {selected && <Link href="/estoque/transferencias" className="text-primary underline">Ver todas as transferências</Link>}
    {list.loading ? <p role="status">Consultando transferências…</p> : list.value?.tenantId!==config.tenantId ?
      <div role="alert">{list.error||"Consulta indisponível"} <Button onClick={list.reload}>Recarregar</Button></div> :
      <><ul className="divide-y">{list.value.data.map(t=><li key={t.id} className="space-y-2 py-2">
        <p><strong>{t.fromName} → {t.toName}</strong> • {new Date(t.createdAt).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"})}</p>
        <p>{t.reason}{t.reversedBy?" • Estornada":t.reversesId?" • Estorno":""}</p>
        <Button variant="outline" onClick={()=>setId(id===t.id?"":t.id)}>{id===t.id?"Fechar itens":"Ver itens"}</Button>
        {id===t.id && <TransferDetails key={t.id} record={t} config={config} saved={saved}/>}
      </li>)}</ul>
      {!list.value.data.length && <p>Nenhuma transferência registrada.</p>}
      {(offset>0||list.value.hasMore) && <div className="flex gap-2"><Button disabled={!offset} onClick={()=>setOffset(offset-20)}>Anterior</Button>
        <Button disabled={!list.value.hasMore} onClick={()=>setOffset(offset+20)}>Próxima</Button></div>}</>}
  </section>
}

function TransferDetails({record,config,saved}:{record:TransferRecord;config:LocationSettings;saved:()=>void}) {
  const detail=useResource<{tenantId:string;items:TransferProduct[]}>(endpoint+"/"+record.id)
  const [reason,setReason]=useState(""),cmd=useCommand()
  return <div className="space-y-2 border-l pl-3">
    {detail.value?.tenantId===config.tenantId ? <ul>{detail.value.items.map(p=><li key={p.productId}>{p.sku} • {p.name} • {commercialQuantity(p.quantity)} {p.unit}</li>)}</ul> :
      <p role="status">{detail.error||"Consultando itens…"}</p>}
    {config.enabled && config.canEdit && !record.reversesId && !record.reversedBy && <form onSubmit={async e=>{
      e.preventDefault()
      const result=await cmd.send<{tenantId:string}>(endpoint+"/"+record.id+"/reverse",config.tenantId,{reason},"","POST",r=>r.tenantId===config.tenantId)
      if(result)saved()
    }}><label>Motivo do estorno<Input required minLength={3} maxLength={500} value={reason} disabled={cmd.busy||cmd.uncertain} onChange={e=>setReason(e.target.value)} /></label>
      {cmd.error&&<p role="alert">{cmd.error}</p>}<Button type="submit" variant="outline" disabled={cmd.busy}>{cmd.uncertain?"Repetir confirmação":"Estornar transferência"}</Button></form>}
  </div>
}
