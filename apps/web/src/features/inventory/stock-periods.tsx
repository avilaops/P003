"use client"

import {useState} from "react"
import {useSearchParams} from "next/navigation"
import {PageHeader} from "@/components/page-header"
import {Button} from "@/components/ui/button"
import {Input} from "@/components/ui/input"
import {useCommand,useResource} from "@/hooks/use-operation"
import {decimalPattern,normalizeDecimal} from "@/lib/decimal-input"
import type {LocationSettings} from "./stock-location-model"
import {stockUrl} from "./stock-model"
import {DataTable} from "@/components/workspace/data-table"

type Period={id:string;month:string;closedAt:string;closedBy:string;reopenedAt:string|null;reason:string|null;positions:number}
type Job={productId:string;sku:string;name:string;status:"pending"|"done"|"failed";since:string;error:string|null}
type State={tenantId:string;periods:Period[];jobs:Job[];canClose:boolean;canReopen:boolean;canManage:boolean}
const base="/api/erp/stock/periods"
function localDate(value:string) {return new Date(value).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"})}

export function StockPeriods({tenant}:{tenant:string}){
  const result=useResource<State>(base)
  const state=result.value?.tenantId===tenant ? result.value : null
  const [notice,setNotice]=useState("")
  const params=useSearchParams(), productId=params.get("productId"),movementId=params.get("movementId")
  function done(message:string){setNotice(message);result.reload()}
  return <main className="workspace-page-frame">
    <PageHeader title="Custos e fechamento mensal" back={{href:"/estoque/saldos",label:"Saldos de estoque"}}/>
    {notice && <p role="status">{notice}</p>}
    {result.loading ? <p role="status">Consultando competências…</p> : !state ? <p role="alert">{result.error || "Atualize a empresa ativa."}</p> : <>
      {state.canManage && productId && <Basis tenant={tenant} productId={productId} movementId={movementId} done={done}/>}
      <section className="form-section space-y-3"><h2 className="font-semibold">Apuração de custo</h2>
        {state.jobs.length ? <ul>{state.jobs.map(job=><li key={job.productId}>{job.name} • {job.sku} • {{pending:"Pendente",done:"Concluído",failed:"Falha"}[job.status]} • desde {job.since.split("-").reverse().join("/")}{job.error && <span> • {job.error}</span>}</li>)}</ul> : <p>Nenhum recálculo registrado.</p>}
        {state.canManage && <Recalculate tenant={tenant} done={done}/>}
      </section>
      {(state.canClose || state.canReopen) && <PeriodAction state={state} done={done}/>}
      <section className="form-section space-y-3"><h2 className="font-semibold">Histórico de fechamento</h2>
        {state.periods.length ? <div className="overflow-x-auto"><DataTable aria-label="Competências de estoque" className="w-full text-left text-sm">
          <thead><tr>{["Competência","Situação","Posições","Responsável","Data"].map(label=><th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{state.periods.map(p=><tr key={p.id}><td>{p.month}</td><td>{p.reopenedAt?"Reaberta":"Fechada"}{p.reason && <p>{p.reason}</p>}</td><td>{p.positions}</td>
            <td>{p.closedBy}</td><td>{localDate(p.closedAt)}{p.reopenedAt && <p>Reabertura • {localDate(p.reopenedAt)}</p>}</td></tr>)}</tbody>
        </DataTable></div> : <p>Nenhuma competência fechada.</p>}
      </section>
    </>}
  </main>
}
function Recalculate({tenant,done}:{tenant:string;done:(message:string)=>void}){
  const cmd=useCommand()
  return <><Button type="button" disabled={cmd.busy} onClick={async()=>{
    const v=await cmd.send<{tenantId:string;processed:number;failed:number}>(base+"/recalculate",tenant,{},"","POST",v=>v.tenantId===tenant)
    if(v) done(v.failed?"Há falhas no recálculo. Consulte os produtos indicados.":"Recálculo concluído • "+v.processed+" produto(s)")
  }}>{cmd.uncertain?"Repetir recálculo":"Recalcular custos pendentes"}</Button>{cmd.error && <p role="alert">{cmd.error}</p>}</>
}
function PeriodAction({state,done}:{state:State;done:(message:string)=>void}){
  const [action,setAction]=useState(state.canClose?"close":"reopen"),cmd=useCommand()
  return <form className="form-section space-y-3" onSubmit={async e=>{
    e.preventDefault()
    const data=new FormData(e.currentTarget),month=String(data.get("month")||""),reason=String(data.get("reason")||"")
    const payload=action==="close"?{month}:{month,reason}
    const result=await cmd.send<{tenantId:string}>(base+"/"+action,state.tenantId,payload,"","POST",v=>v.tenantId===state.tenantId)
    if(result)done(action==="close"?"Competência fechada.":"Competência reaberta.")
  }}><h2 className="font-semibold">Competência de estoque</h2>
    <fieldset disabled={cmd.busy || cmd.uncertain} className="grid gap-3 sm:grid-cols-2">
      <label>Operação<select className="block min-h-9 w-full rounded border px-2" value={action} onChange={e=>setAction(e.target.value)}>
        {state.canClose && <option value="close">Fechamento</option>}{state.canReopen && <option value="reopen">Reabertura</option>}
      </select></label>
      <label>Competência<Input type="month" name="month" required/></label>
      {action==="reopen" && <label>Motivo da reabertura<Input name="reason" minLength={3} maxLength={500} required/></label>}
    </fieldset>
    {cmd.error && <p role="alert">{cmd.error}</p>}
    <Button type="submit" disabled={cmd.busy}>{cmd.uncertain?"Repetir confirmação":action==="close"?"Fechar mês":"Reabrir mês"}</Button>
  </form>
}
type BasisProps={tenant:string;productId:string;movementId:string|null;done:(message:string)=>void}
type ReceiptBasis={tenantId:string;amount:string|null;freight:string;recoverableTax:string;sourced:boolean;revision:number}
function Basis(props:BasisProps){
  return props.movementId ? <ReceiptBasisForm {...props} movementId={props.movementId}/> : <BasisForm {...props}/>
}
function ReceiptBasisForm(props:BasisProps & {movementId:string}){
  const result=useResource<ReceiptBasis>(stockUrl(base+"/basis",{productId:props.productId,movementId:props.movementId}))
  if(result.loading)return <p role="status">Carregando composição de custo…</p>
  if(!result.value||result.value.tenantId!==props.tenant)return <p role="alert">{result.error||"Entrada indisponível"}</p>
  return <BasisForm key={result.value.revision} {...props} current={result.value} refresh={result.reload}/>
}
function BasisForm({tenant,productId,movementId,done,current,refresh}:BasisProps & {current?:ReceiptBasis;refresh?:()=>void}){
  const settings=useResource<LocationSettings>("/api/erp/stock/locations"),cmd=useCommand()
  const warehouses=settings.value?.tenantId===tenant ? settings.value.warehouses : []
  return <form className="form-section space-y-3" onSubmit={async e=>{
    e.preventDefault()
    const d=new FormData(e.currentTarget),money=(k:string)=>normalizeDecimal(String(d.get(k)||""),2),reason=String(d.get("reason")||"")
    const payload=movementId ? {kind:"receipt",productId,movementId,reason,revision:current?.revision,...(money("amount")?{amount:money("amount")}:{}),freight:money("freight"),recoverableTax:money("tax")} :
      {kind:"opening",productId,warehouseId:d.get("warehouse"),amount:money("amount"),reason}
    const v=await cmd.send<{tenantId:string}>(base+"/basis",tenant,payload,"","POST",v=>v.tenantId===tenant)
    if(v)done("Composição de custo registrada.")
  }}><h2 className="font-semibold">{movementId?"Composição da entrada":"Valor da abertura anterior ao Kardex"}</h2>
    <fieldset disabled={cmd.busy || cmd.uncertain} className="grid gap-3 sm:grid-cols-2">
      {!movementId && <label>Depósito<select name="warehouse" className="block min-h-9 w-full rounded border px-2" required>
        {warehouses.map(w=><option key={w.id} value={w.id}>{w.code} • {w.name}</option>)}</select></label>}
      {current?.amount!=null&&<p>Valor de origem da entrada • R$ {current.amount.replace(".",",")}</p>}
      <label>{movementId?"Valor total da entrada (R$)":"Valor do saldo de abertura (R$)"}<Input disabled={current?.sourced} required={!movementId} name="amount" inputMode="decimal" pattern={decimalPattern(2)}/>
        {movementId && <span className="text-xs">Em branco • manter o valor da origem</span>}</label>
      {movementId && <><label>Frete adicional desta linha (R$)<Input name="freight" defaultValue={current?.freight.replace(".",",")} required inputMode="decimal" pattern={decimalPattern(2)}/></label>
        <label>Impostos recuperáveis desta linha (R$)<Input name="tax" defaultValue={current?.recoverableTax.replace(".",",")} required inputMode="decimal" pattern={decimalPattern(2)}/></label></>}
      <label>Motivo da apropriação<Input name="reason" minLength={3} maxLength={500} required/></label>
    </fieldset>
    {cmd.error && <p role="alert">{cmd.error}</p>}
    {cmd.stale&&refresh&&<Button type="button" variant="outline" onClick={refresh}>Atualizar composição</Button>}
    <Button type="submit" disabled={cmd.busy||cmd.stale}>{cmd.uncertain?"Repetir confirmação":"Salvar composição"}</Button>
  </form>
}
