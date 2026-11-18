"use client"

import {useState} from "react"
import {erpFetch} from "@/lib/api/client"
import {useResource} from "@/hooks/use-operation"
import {Button} from "@/components/ui/button"
import type {PolicyCatalog} from "./policy-settings"
import {paymentToday} from "./commercial-payment-model"

export type AppliedTerm={term:{id:string;name:string;revision:number;start:string};entryCents:number;entry:{dueOn:string;paymentMethodId:string|null};installments:{dueOn:string;paymentMethodId:string;amountCents:number}[]}
export function PaymentTermPicker({tenant,customer,total,disabled,apply}:{tenant:string;customer?:string;total:number|null;disabled:boolean;apply:(value:AppliedTerm)=>void}){
 const catalog=useResource<PolicyCatalog>("/api/erp/commercial/policies/catalog"+(customer?"/"+customer:""))
 const [chosen,setChosen]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("")
 const terms=catalog.value?.tenantId===tenant?catalog.value.terms.filter(t=>t.active):[]
 const selected=terms.find(t=>t.id===(chosen||catalog.value?.defaultTermId))
 if(!terms.length) return null
 return <div className="flex flex-wrap items-end gap-2"><label className="grid gap-1">Condição de pagamento<select className="min-h-10 rounded border bg-background px-2" disabled={disabled||busy} value={selected?.id??""} onChange={e=>setChosen(e.target.value)}><option value="">Selecione</option>{terms.map(t=><option value={t.id} key={t.id}>{t.name}{t.id===catalog.value?.defaultTermId?" • padrão do cliente":""}</option>)}</select></label>
 <Button type="button" variant="outline" disabled={disabled||busy||!selected||!total} onClick={async()=>{
  if(!selected||!total)return
  setBusy(true);setError("")
  try{const response=await erpFetch("/api/erp/commercial/policies/plan",{method:"POST",headers:{"Content-Type":"application/json","X-Tenant-Id":tenant},body:JSON.stringify({totalCents:total,term:{id:selected.id,revision:selected.revision,start:paymentToday()}})})
   const body=await response.json()
   if(!response.ok||body.tenantId!==tenant)throw Error(body.title||"Falha ao consultar condição")
   apply(body)
  }catch(reason){setError(reason instanceof Error?reason.message:"Condição indisponível")}finally{setBusy(false)}
 }}>{busy?"Calculando…":"Aplicar condição"}</Button>{error&&<p role="alert">{error}</p>}</div>
}
