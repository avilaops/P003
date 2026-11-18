"use client"

import {useState} from "react"
import Link from "next/link"
import {Button} from "@/components/ui/button"
import {useCommand,useResource} from "@/hooks/use-operation"
import {selectClass,type Warehouse} from "./stock-location-model"
import {stockUrl,textLink} from "./stock-model"

type Line={productId:string;sku:string;name:string;warehouseId:string|null;pending:boolean}
type Snapshot={tenantId:string;id:string;enabled:boolean;canEdit:boolean;defaultId:string|null;warehouses:Warehouse[];lines:Line[]}
export function DocumentWarehouses({kind,id,tenant}:{kind:"sale"|"purchase";id:string;tenant:string}){
  const endpoint="/api/erp/stock/document-locations/"+kind+"/"+id,resource=useResource<Snapshot>(endpoint)
  const state=resource.value?.tenantId===tenant&&resource.value.id===id?resource.value:null
  if(!state?.enabled) return null
  return <details className="form-section"><summary>Depósitos dos itens</summary><ul className="mt-3 space-y-3">{state.lines.map(l=>
    <li key={l.productId}><LineWarehouse key={l.warehouseId??"default"} line={l} state={state} endpoint={endpoint} reload={resource.reload}/>
    </li>)}</ul></details>
}
function LineWarehouse({line,state,endpoint,reload}:{line:Line;state:Snapshot;endpoint:string;reload:()=>void}){
  const [selected,setSelected]=useState(line.warehouseId??""),cmd=useCommand()
  const current=state.warehouses.find(w=>w.id===(line.warehouseId??state.defaultId))
  return <form className="flex flex-wrap items-end gap-2" onSubmit={async e=>{
    e.preventDefault()
    const result=await cmd.send(endpoint,state.tenantId,{productId:line.productId,warehouseId:selected||null,previousWarehouseId:line.warehouseId},"","PUT",(r:{tenantId:string})=>r.tenantId===state.tenantId)
    if(result)reload()
  }}><label>{line.sku} • {line.name}{line.pending&&state.canEdit?<select className={selectClass} value={selected} disabled={cmd.busy||cmd.uncertain} onChange={e=>setSelected(e.target.value)}>
      <option value="">Padrão da operação</option>{state.warehouses.map(w=><option key={w.id} value={w.id}>{w.code} • {w.name}</option>)}</select>:
      <span className="block">{current?.name||"Depósito indisponível"}</span>}</label>
    {line.pending&&state.canEdit&&<Button type="submit" disabled={cmd.busy||cmd.stale||!cmd.uncertain&&selected===(line.warehouseId??"")}>{cmd.uncertain?"Repetir confirmação":"Salvar depósito"}</Button>}
    {cmd.error&&<p role="alert">{cmd.error}</p>}{cmd.stale&&<Button type="button" onClick={()=>{cmd.reset();reload()}}>Atualizar item</Button>}
  </form>
}
export function DocumentSeries({id,tenant}:{id:string;tenant:string}){
  return <Link className={textLink} href={stockUrl("/estoque/series",{documentId:id,tenant})}>Consultar e vincular séries</Link>
}
