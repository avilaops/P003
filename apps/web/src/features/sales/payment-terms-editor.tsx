"use client"

import {useState,type FormEvent} from "react"
import {useCommand} from "@/hooks/use-operation"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import type {PolicyCatalog} from "./policy-settings"

type Option={id:string;name:string}
export const selectClass="min-h-10 rounded border bg-background px-2"
export function Options({name,options,initial="",optional=false}:{name:string;options:Option[];initial?:string;optional?:boolean}){
 return <select className={selectClass} name={name} defaultValue={initial} required={!optional}><option value="">{optional?"Sem vínculo":"Selecione"}</option>{options.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select>
}
// Cadastro único das condições de pagamento: usado em Cadastros e em Preferências, sem duplicar a regra.
export function PaymentTermsEditor({data,reload,onSaved}:{data:PolicyCatalog;reload:()=>void;onSaved:()=>void}){
 const cmd=useCommand(),[termId,setTerm]=useState("")
 const term=data.terms.find(t=>t.id===termId),disabled=cmd.busy||cmd.uncertain||cmd.stale
 async function save(event:FormEvent<HTMLFormElement>){
  event.preventDefault()
  const form=new FormData(event.currentTarget),field=(key:string)=>String(form.get(key)??"").trim()
  const days=field("days")?field("days").split(",").map(v=>Number(v.trim())):[]
  const response=await cmd.send("/api/erp/commercial/policies/settings",data.tenantId,{kind:"term",...(term?{id:term.id}:{}),revision:term?.revision??0,name:field("name"),entryBps:Math.round(Number(field("entry"))*100),days,methodId:field("method"),active:form.has("active")})
  if(response)onSaved()
 }
 return <div className="space-y-2">
 <form className="form-section" onSubmit={e=>void save(e)}><h2 className="font-semibold">Condições de pagamento</h2><fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
 <label>Condição<select className={selectClass} value={termId} onChange={e=>setTerm(e.target.value)}><option value="">Nova condição</option>{data.terms.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
 <div key={termId} className="contents"><label>Nome<Input name="name" required maxLength={120} defaultValue={term?.name}/></label><label>Entrada (%)<Input name="entry" required type="number" step=".01" min="0" max="100" defaultValue={(term?.entryBps??0)/100}/></label><label>Vencimentos em dias (ex. 30, 60, 90)<Input name="days" defaultValue={term?.days.join(", ")??"30"}/></label><label>Forma de pagamento<Options name="method" options={data.methods} initial={term?.methodId}/></label><label><input type="checkbox" name="active" defaultChecked={term?.active??true}/> Ativa</label></div></fieldset><Button type="submit" disabled={cmd.busy||cmd.stale}>Salvar condição</Button></form>
 {cmd.error&&<p role="alert">{cmd.error}</p>}{cmd.stale&&<Button onClick={reload}>Atualizar política</Button>}</div>
}
