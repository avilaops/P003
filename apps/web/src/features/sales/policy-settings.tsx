"use client"

import {useState,type FormEvent} from "react"
import {useResource,useCommand} from "@/hooks/use-operation"
import {Lookup,type Choice} from "./orders"
import {PageHeader} from "@/components/page-header"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import {RequestError} from "@/components/feedback/session-recovery"
import {Options,PaymentTermsEditor,selectClass} from "./payment-terms-editor"

type Option={id:string;name:string}
export type Term=Option&{revision:number;entryBps:number;days:number[];methodId:string;active:boolean}
type Buyer={revision:number;creditLimitCents:number|null;validUntil:string|null;overdueDays:number|null;blocked:boolean;termId:string|null;listId:string|null}
type Routing={level:string;revision:number;dueHours:number;substituteId:string|null;until:string|null}
export type PolicyCatalog={tenantId:string;manage:boolean;terms:Term[];methods:Option[];lists:Option[];people:Option[];defaultTermId:string|null;policy:Buyer|null;channels:{channel:string;listId?:string;revision?:number}[];routes:Routing[]}
export function PolicySettings(){
 const [customer,setCustomer]=useState<Choice|null>(null),[message,setMessage]=useState("")
 const result=useResource<PolicyCatalog>("/api/erp/commercial/policies/catalog"+(customer?"/"+customer.id:""))
 return <main className="mx-auto max-w-4xl space-y-4 p-4"><PageHeader title="Políticas de vendas" breadcrumbs={[{label:"Preferências",href:"/preferencias"},{label:"Políticas de vendas"}]}/>
 {result.loading?<p role="status">Consultando políticas…</p>:result.error?<RequestError message={result.error} status={result.status}/>:result.value?.manage?<Editor key={JSON.stringify([customer?.id,result.value])} data={result.value} customer={customer} choose={value=>{setMessage("");setCustomer(value)}} reload={result.reload} onSaved={()=>{setMessage("Política salva.");result.reload()}}/>:<p>A gestão da empresa configura estas políticas.</p>}{message&&<p role="status">{message}</p>}</main>
}
function Editor({data,customer,choose,reload,onSaved}:{data:PolicyCatalog;customer:Choice|null;choose:(v:Choice)=>void;reload:()=>void;onSaved:()=>void}){
 const cmd=useCommand(),[channel,setChannel]=useState(""),[level,setLevel]=useState("manager")
 const policy=data.policy,channelRow=data.channels.find(c=>c.channel===channel),route=data.routes.find(r=>r.level===level)
 async function save(event:FormEvent<HTMLFormElement>,kind:string){
  event.preventDefault()
  const form=new FormData(event.currentTarget),field=(key:string)=>String(form.get(key)??"").trim()
  let body:Record<string,unknown>
  if(kind==="customer"){
   if(!customer)return
   body={kind,id:customer.id,revision:policy?.revision??0,creditLimitCents:field("limit")?Math.round(Number(field("limit"))*100):null,blocked:form.has("blocked"),overdueDays:field("overdue")?Number(field("overdue")):null,validUntil:field("valid")||null,termId:field("term")||null,listId:field("list")||null}
  }else if(kind==="channel"){
   body={kind,channel,revision:channelRow?.revision??0,listId:field("list")}
  }else{
   body={kind,level,revision:route?.revision??0,dueHours:Number(field("hours")),substituteId:field("substitute")||null,until:field("until")||null}
  }
  const response=await cmd.send("/api/erp/commercial/policies/settings",data.tenantId,body)
  if(response)onSaved()
 }
 const disabled=cmd.busy||cmd.uncertain||cmd.stale
 return <div className="space-y-5">
 <PaymentTermsEditor data={data} reload={reload} onSaved={onSaved}/>
 <form className="form-section" onSubmit={e=>void save(e,"customer")}><h2 className="font-semibold">Crédito e padrões do cliente</h2><Lookup endpoint="parties" label="cliente" searchOnly choose={choose} disabled={disabled} selectedName={customer?.legalName}/>
 {customer&&<><fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2"><label>Limite de crédito (R$)<Input name="limit" type="number" min="0" step=".01" defaultValue={policy?.creditLimitCents==null?"":policy.creditLimitCents/100}/></label><label>Validade do crédito<Input name="valid" type="date" defaultValue={policy?.validUntil??""}/></label><label>Dias de atraso tolerados<Input name="overdue" type="number" min="0" max="3650" defaultValue={policy?.overdueDays??""}/></label><label><input name="blocked" type="checkbox" defaultChecked={policy?.blocked}/> Bloquear crédito</label><label>Condição padrão<Options name="term" optional options={data.terms.filter(t=>t.active)} initial={policy?.termId??""}/></label><label>Lista de preços<Options name="list" optional options={data.lists} initial={policy?.listId??""}/></label></fieldset><Button type="submit" disabled={cmd.busy||cmd.stale}>Salvar política do cliente</Button></>}</form>
 <form className="form-section" onSubmit={e=>void save(e,"channel")}><h2 className="font-semibold">Lista por canal</h2><fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2"><label>Canal<Input required list="policy-channels" maxLength={80} value={channel} onChange={e=>setChannel(e.target.value)}/><datalist id="policy-channels">{data.channels.map(c=><option key={c.channel} value={c.channel}/>)}</datalist></label><label>Lista<Options key={channel} name="list" options={data.lists} initial={channelRow?.listId}/></label></fieldset><Button type="submit" disabled={cmd.busy||cmd.stale}>Salvar lista do canal</Button></form>
 <form className="form-section" onSubmit={e=>void save(e,"routing")}><h2 className="font-semibold">Aprovadores e prazos</h2><fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2"><label>Alçada<select className={selectClass} value={level} onChange={e=>setLevel(e.target.value)}><option value="manager">Gerência</option><option value="director">Diretoria</option><option value="credit">Crédito</option></select></label><div key={level} className="contents"><label>Prazo em horas<Input required type="number" min="1" max="2160" name="hours" defaultValue={route?.dueHours??48}/></label><label>Substituto<Options name="substitute" optional options={data.people} initial={route?.substituteId??""}/></label><label>Substituição até<Input name="until" type="date" defaultValue={route?.until??""}/></label></div></fieldset><Button type="submit" disabled={cmd.busy||cmd.stale}>Salvar alçada</Button></form>
 {cmd.error&&<p role="alert">{cmd.error}</p>}{cmd.stale&&<Button onClick={reload}>Atualizar política</Button>}</div>
}
