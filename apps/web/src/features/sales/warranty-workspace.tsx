"use client"

import { useState,type ReactNode } from "react"
import { GuardedLink as Link } from "@/components/shell/navigation-guard"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCommand,useResource } from "@/hooks/use-operation"
import { normalizeDecimal } from "@/lib/decimal-input"
import { Lookup,type Choice } from "./orders"
import { WarrantyAssignment } from "./warranty-assignment"
import { WarrantySettlement } from "./warranty-settlement"
import { WarrantyRecords } from "./warranty-records"
import { priorities,stages } from "./warranty-list"

type SubRecord={id:string;revision:number;status:string}
type CaseRow={id:string;protocol:string;title:string;description:string;revision:number;status:string;criticality:string;coverageStatus:string;queue:string;assignedTo:string|null;slaDueAt:string|null;productId:string|null;customerName:string|null;productName:string|null;orderId:string|null;orderNumber:string|null;serialNumber:string|null}
type Detail=CaseRow & {
  invoiceNumber:string|null
  lineNumber:number|null
  equipment:{invoiceNumber:string;expiresOn:string;remainingDays:number;coverageStatus:string}|null
  timeline:{id:string;eventType:string;status:string|null;createdAt:string}[]
  serviceOrders:(SubRecord & {diagnosis?:string;laborCents?:number})[]
  parts:{id:string;productName:string;quantityMicros:number;amountCents:number;serialNumbers?:string[]|null;warehouseName?:string|null}[]
  approvals:{id:string;action:string;decision:string;amountCents:number|null}[]
  rmas:(SubRecord & {reference:string})[]
  quarantines:SubRecord[]
}
type ResponseData={tenantId:string;canEdit:boolean;canApprove:boolean;data:Detail}
const path="/api/erp/warranty-cases/"
const formatMoney=(value:number)=>(value/100).toLocaleString("pt-BR",{style:"currency",currency:"BRL"})
const cents=(value:string)=>{const exact=normalizeDecimal(value,2);return exact===null ? null : Number(exact.replace(".",""))}
const coverage:Record<string,string>={eligible:"Elegível",expired:"Prazo encerrado",pending:"Em análise",rejected:"Recusada"}
const eventName:Record<string,string>={opened:"Abertura",triaged:"Triagem",diagnosed:"Diagnóstico",treated:"Atendimento",resolved:"Resolução",closed:"Encerramento",cancelled:"Cancelamento",note:"Atualização",approval:"Decisão",attachment:"Evidência"}
const actions:Record<string,string>={exchange:"Troca",credit:"Crédito",refund:"Reembolso"}
const rmaStates:Record<string,string>={requested:"Solicitado",authorized:"Autorizado",in_transit:"Em trânsito",received:"Recebido",closed:"Encerrado",cancelled:"Cancelado"}
const section="space-y-3 rounded-lg border p-4"
const select="min-h-10 rounded-lg border bg-background px-2"
type ActionProps={tenant:string;url:string;etag:string;body:object;label:string;disabled?:boolean;reload:()=>void;children?:ReactNode}
function Action({tenant,url,etag,body,label,disabled=false,reload,children}:ActionProps) {
  const command=useCommand()
  return <div className="space-y-2">
    {children && <fieldset className="grid gap-3" disabled={command.busy || command.uncertain || command.stale}>{children}</fieldset>}
    {command.error && <p role="alert">{command.error}</p>}
    {command.stale ? <Button variant="outline" onClick={reload}>Atualizar registro</Button> : <Button disabled={command.busy || !etag || (!command.uncertain && disabled)} onClick={async()=>{
      if(await command.send(url,tenant,body,etag,"POST",(reply: {tenantId:string})=>reply?.tenantId===tenant)) reload()
    }}>{command.uncertain?"Conferir confirmação":label}</Button>}
  </div>
}
export function WarrantyDetail({id}:{id:string}) {
  const resource=useResource<ResponseData>(path+id)
  if(resource.loading) return <p className="p-6" role="status">Carregando garantia…</p>
  if(resource.error || !resource.value) return <div className="p-6" role="alert">{resource.error || "Garantia não encontrada"} <Button onClick={resource.reload}>Tentar novamente</Button></div>
  return <CaseWorkspace key={resource.value.tenantId+":"+id+":"+resource.value.data.revision} snapshot={resource.value} etag={resource.etag} reload={resource.reload}/>
}
function CaseWorkspace({snapshot,etag,reload}:{snapshot:ResponseData;etag:string;reload:()=>void}) {
  const {data:item,tenantId}=snapshot, url=path+item.id
  const command={tenant:tenantId,etag,reload}
  const writable=snapshot.canEdit && !["closed","cancelled"].includes(item.status)
  const next:Record<string,string>={opened:"triage",triage:"diagnosis",diagnosis:"treatment",treatment:"resolved",resolved:"closed"}
  const to=next[item.status]
  const [diagnosis,setDiagnosis]=useState(""),[labor,setLabor]=useState("0")
  const [selectedOS,setOS]=useState(""),[part,setPart]=useState<Choice|null>(null),[qty,setQty]=useState("1"),[price,setPrice]=useState("0")
  const [serialText,setSerialText]=useState("")
  const serialNumbers=serialText.split(/\r?\n/).map(serial=>serial.trim()).filter(Boolean)
  const order=item.serviceOrders.find(o=>o.id===selectedOS),units=normalizeDecimal(qty,6)
  const serialQuantityInvalid=serialNumbers.length>0 && (Number(units)!==serialNumbers.length || new Set(serialNumbers).size!==serialNumbers.length)
  const [action,setAction]=useState("exchange"),[decision,setDecision]=useState("approved"),[amount,setAmount]=useState(""),[notes,setNotes]=useState("")
  const money=cents(amount),needsAmount=decision==="approved" && action!=="exchange"
  const [carrier,setCarrier]=useState(""),[tracking,setTracking]=useState(""),[qQty,setQQty]=useState("1"),[reason,setReason]=useState("")
  const quarantineUnits=normalizeDecimal(qQty,6)
  const cost=item.serviceOrders.reduce((n,o)=>n+(o.laborCents??0),0)+item.parts.reduce((n,p)=>n+p.amountCents,0)
  return <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
    <PageHeader title={item.title} back={{href:"/vendas/garantias",label:"Voltar para garantias"}} eyebrow={item.protocol} description={item.description}/>
    <div className="grid gap-4 md:grid-cols-2"><section className={section}><h2 className="font-semibold">Resumo</h2>
      <dl className="grid grid-cols-2 gap-2"><dt>Situação</dt><dd>{stages[item.status]}</dd><dt>Criticidade</dt><dd>{priorities[item.criticality]}</dd>
        <dt>Cobertura</dt><dd>{coverage[item.coverageStatus]}</dd><dt>Revisão</dt><dd>{item.revision}</dd>
        {item.customerName && <><dt>Cliente</dt><dd>{item.customerName}</dd></>}{item.productName && <><dt>Equipamento</dt><dd>{item.productName}</dd></>}{item.serialNumber && <><dt>Série</dt><dd>{item.serialNumber}</dd></>}
        {item.orderId && <><dt>Pedido de origem</dt><dd><Link className="underline" href={"/vendas/pedidos/"+item.orderId}>Pedido {item.orderNumber}</Link></dd></>}
        {(item.invoiceNumber || item.equipment) && <><dt>Nota fiscal de origem</dt><dd>NF-e {item.invoiceNumber ?? item.equipment?.invoiceNumber}{item.lineNumber && ` • Item ${item.lineNumber}`}</dd></>}
        {item.equipment && <><dt>Fim da cobertura</dt><dd>{item.equipment.expiresOn.split("-").reverse().join("/")}</dd>{item.equipment.coverageStatus && item.equipment.coverageStatus !== item.coverageStatus && <><dt>Cobertura atual da série</dt><dd>{coverage[item.equipment.coverageStatus]}</dd></>}</>}
        <dt>Custo do atendimento</dt><dd>{formatMoney(cost)}</dd></dl>
      {writable && to && <Action {...command} url={url+"/transition"} body={{status:to,details:{}}} label={"Avançar para "+stages[to]}/>}
    </section><section className={section}><h2 className="font-semibold">Linha do tempo</h2><ol className="space-y-2">{item.timeline.map(e=><li key={e.id}>{eventName[e.eventType] || e.eventType} • {new Date(e.createdAt).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"})}</li>)}</ol></section></div>
    <div className="grid gap-4 md:grid-cols-2"><section className={section}><h2 className="font-semibold">Ordem de serviço</h2>
      {item.serviceOrders.map((o,i)=><p key={o.id}>OS {i+1} • {o.diagnosis || "Diagnóstico em aberto"} • {formatMoney(o.laborCents??0)}</p>)}
      {writable && <Action {...command} url={url+"/service-order"} label="Registrar ordem de serviço" disabled={Boolean(item.serviceOrders.length) || cents(labor)===null} body={{diagnosis:diagnosis.trim()||null,report:{},scheduledAt:null,laborCents:cents(labor)}}>
        <label>Diagnóstico<Input value={diagnosis} onChange={e=>setDiagnosis(e.target.value)}/></label><label>Mão de obra (R$)<Input inputMode="decimal" value={labor} onChange={e=>setLabor(e.target.value)}/></label></Action>}
      {item.parts.map(p=><p key={p.id}>{p.productName} • {p.quantityMicros/1000000} • {formatMoney(p.amountCents)}{p.warehouseName && ` • ${p.warehouseName}`}{p.serialNumbers?.length ? ` • ${p.serialNumbers.join(", ")}` : ""}</p>)}
      {writable && item.serviceOrders.length>0 && <Action {...command} url={"/api/erp/warranty-service-orders/"+order?.id+"/parts"} etag={order?'"'+order.revision+'"':""} label="Registrar peça" disabled={!part || !units || Number(units)<=0 || cents(price)===null || serialQuantityInvalid} body={{productId:part?.id,quantity:units,amountCents:cents(price),...(serialNumbers.length ? {serialNumbers} : {})}}>
        <label className="grid">Ordem de serviço da peça<select className={select} value={selectedOS} onChange={e=>setOS(e.target.value)}><option value="">Selecione a ordem</option>{item.serviceOrders.map((o,i)=><option key={o.id} value={o.id}>OS {i+1} • {item.protocol}</option>)}</select></label>
        <Lookup endpoint="products" label="produto da peça" disabled={false} choose={choice=>{setPart(choice);setSerialText("")}} compact searchOnly/>{part && <p>Peça selecionada • {part.name}</p>}
        <label className="grid">Séries das peças<textarea className="min-h-16 rounded-lg border p-2" value={serialText} onChange={e=>setSerialText(e.target.value)} aria-describedby="warranty-part-series-help"/></label>
        <p id="warranty-part-series-help" className="text-sm text-muted-foreground">Para peças controladas por série, informe uma por unidade, uma por linha. O estoque identifica o depósito.</p>
        {serialQuantityInvalid && <p role="alert">Informe uma série distinta para cada unidade da peça.</p>}
        <label>Quantidade da peça<Input value={qty} onChange={e=>setQty(e.target.value)}/></label><label>Valor da peça (R$)<Input inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)}/></label></Action>}
    </section><section className={section}><h2 className="font-semibold">Aprovação por alçada</h2>
      {item.approvals.map(a=><p key={a.id}>{actions[a.action]} • {a.decision==="approved"?"Aprovado":"Rejeitado"}{a.amountCents!==null && " • "+formatMoney(a.amountCents)}</p>)}
      {snapshot.canApprove && !["closed","cancelled"].includes(item.status) && <Action {...command} url={url+"/approval"} label="Registrar decisão" body={{action,decision,amountCents:money,notes}} disabled={needsAmount && !(money && money>0) || Boolean(amount.trim()) && money===null || item.approvals.some(a=>a.action===action)}>
        <label className="grid">Ação<select className={select} value={action} onChange={e=>setAction(e.target.value)}>{Object.entries(actions).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
        <label className="grid">Decisão<select className={select} value={decision} onChange={e=>setDecision(e.target.value)}><option value="approved">Aprovar</option><option value="rejected">Rejeitar</option></select></label>
        <label>Valor da decisão (R$)<Input inputMode="decimal" required={needsAmount} value={amount} onChange={e=>setAmount(e.target.value)}/></label><label>Notas<Input value={notes} onChange={e=>setNotes(e.target.value)}/></label></Action>}
    </section></div>
    <WarrantyRecords id={item.id} tenant={tenantId} etag={etag} writable={writable} orders={item.serviceOrders} orderId={item.orderId} reload={reload}/>
    {writable && <WarrantyAssignment item={item} tenantId={tenantId} etag={etag} onSaved={reload}/>}
    <WarrantySettlement item={item} tenantId={tenantId} onChanged={reload}/>
    <div className="grid gap-4 md:grid-cols-2"><section className={section}><h2 className="font-semibold">RMA</h2>
      {writable && <Action {...command} url={url+"/rma"} label="Solicitar RMA" body={{supplierId:null,carrier:carrier||null,trackingCode:tracking||null,notes:""}}>
        <label>Transportadora<Input value={carrier} onChange={e=>setCarrier(e.target.value)}/></label><label>Código de rastreio<Input value={tracking} onChange={e=>setTracking(e.target.value)}/></label></Action>}
      {item.rmas.map(r=>{const step:Record<string,string>={requested:"in_transit",authorized:"in_transit",in_transit:"received",received:"closed"};return <div key={r.id}>{r.reference} • {rmaStates[r.status]}{snapshot.canEdit && step[r.status] && <Action {...command} url={"/api/erp/warranty-rmas/"+r.id+"/transition"} etag={'"'+r.revision+'"'} body={{status:step[r.status],details:{}}} label={"Registrar "+rmaStates[step[r.status]]}/>}</div>})}
    </section><section className={section}><h2 className="font-semibold">Quarentena de produto</h2>
      {writable && item.productId && <Action {...command} url={url+"/quarantine"} label="Enviar para quarentena" disabled={!quarantineUnits || Number(quarantineUnits)<=0 || reason.trim().length<3} body={{productId:item.productId,quantity:quarantineUnits,reason}}>
        <label>Quantidade<Input value={qQty} onChange={e=>setQQty(e.target.value)}/></label><label>Motivo<Input value={reason} onChange={e=>setReason(e.target.value)}/></label></Action>}
      {!item.productId && <p>Este chamado aguarda vínculo com um produto.</p>}
      {item.quarantines.map(q=><div key={q.id}>{q.status==="released"?"Liberada":q.status==="disposed"?"Descartada":"Em quarentena"}
        {snapshot.canEdit && q.status==="quarantined" && <div className="flex gap-2">{["released","disposed"].map(s=><Action key={s} {...command} url={"/api/erp/warranty-quarantines/"+q.id+"/transition"} etag={'"'+q.revision+'"'} label={s==="released"?"Liberar para estoque":"Confirmar descarte"} body={{status:s,details:{}}}/>)}</div>}</div>)}
    </section></div>
  </div>
}
