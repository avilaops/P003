"use client"

import {useState} from "react"
import {Button} from "@/components/ui/button"
import {useResource} from "@/hooks/use-operation"
import {stockUrl} from "./stock-model"

type DocumentSerials={tenantId:string;documentId:string;data:{productId:string;sku:string;serial:string}[];hasMore:boolean}
export function OrderSerials({id,tenant}:{id:string;tenant:string}){
  const [open,setOpen]=useState(false)
  return <details className="form-section" onToggle={e=>setOpen(e.currentTarget.open)}><summary>Números de série do pedido</summary>
    {open&&<SerialPage key={tenant+id} tenant={tenant} id={id}/>}</details>
}

function SerialPage({id,tenant}:{id:string;tenant:string}){
  const [offset,setOffset]=useState(0)
  const result=useResource<DocumentSerials>(stockUrl("/api/erp/stock/serials/document",{documentId:id,offset}))
  const value=result.value?.documentId===id&&result.value.tenantId===tenant?result.value:null
  if(result.loading)return <p role="status">Consultando séries…</p>
  if(!value)return <div role="alert">{result.error||"Confira a empresa ativa."} <Button onClick={result.reload}>Tentar novamente</Button></div>
  return <div className="space-y-2 pt-2">{value.data.length?<ul>{value.data.map(r=><li key={r.productId+r.serial}>{r.sku} • {r.serial}</li>)}</ul>:<p>Nenhuma série vinculada ao pedido.</p>}
    {offset>0&&<Button onClick={()=>setOffset(offset-25)}>Página anterior de séries</Button>}
    {value.hasMore&&<Button onClick={()=>setOffset(offset+25)}>Próxima página de séries</Button>}</div>
}
