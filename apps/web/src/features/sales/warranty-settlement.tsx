"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCommand, useResource } from "@/hooks/use-operation"
import { normalizeDecimal } from "@/lib/decimal-input"
import { PurchaseLookup, type PurchaseChoice } from "@/features/purchasing/purchase-lookup"

const labels={review:"Conferir decisão por outro aprovador",credit:"Emitir crédito ao cliente",apply_credit:"Usar crédito em título",refund:"Registrar reembolso",exchange:"Entregar produto de troca",intake:"Receber equipamento para assistência",repair_return:"Devolver equipamento reparado",scrap:"Registrar descarte do equipamento",supplier_cash:"Recuperar valor do fornecedor",supplier_stock:"Receber reposição do fornecedor"} as const
type Kind=keyof typeof labels
type Approval={id:string;action:string;decision:string;amountCents:number|null}
type Case={id:string;status:string;approvals:Approval[];rmas:{id:string;reference:string;status:string;supplierId?:string|null}[];serviceOrders:{id:string;status:string}[]}
type Movement={id:string;kind:Kind;reference:string;occurredOn:string;amountCents:number|null;quantityMicros:number|null;approvalId:string|null;rmaId:string|null;creditRemainingCents:number|null;stockMovementId:string|null;accountEntryId:string|null;receivableId:string|null;serviceOrderId:string|null;sourceCreditId:string|null;supplierId:string|null;origin?:{orderId:string;lineNumber:number;serialNumber:string|null;lot:string|null;documentId:string|null}}
type Summary={tenantId:string;originReady:boolean;canBank:boolean;canCredit:boolean;canStock:boolean;canReview:boolean;reviews:{approvalId:string}[];custody:string;movements:Movement[];accounts:{id:string;name:string}[];receivables:{id:string;orderNumber:string;dueDate:string;openCents:number}[];totalBills:number}
const actionLabels:Record<string,string>={credit:"Crédito",exchange:"Troca",refund:"Reembolso"}
const brl=(c:number)=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(c/100)
const units=(v:number)=>v.toLocaleString("pt-BR",{maximumFractionDigits:6})
const selectClass="block w-full min-w-0 rounded-lg border bg-background p-2"
export function WarrantySettlement({item,tenantId,onChanged}:{item:Case;tenantId:string;onChanged:()=>void}){
  const [offset,setOffset]=useState(0)
  const base="/api/erp/warranty-cases/"+item.id+"/settlements"
  const resource=useResource<Summary>(base+"?offset="+offset),command=useCommand()
  const [kind,setKind]=useState<Kind|"">(""),[document,setDocument]=useState(""),[reference,setReference]=useState("")
  const [date,setDate]=useState(""),[account,setAccount]=useState(""),[amount,setAmount]=useState(""),[qty,setQty]=useState("1")
  const [receivable,setReceivable]=useState(""),[supplier,setSupplier]=useState<PurchaseChoice|null>(null),[error,setError]=useState("")
  if(resource.loading)return <p role="status">Carregando efeitos da garantia…</p>
  if(resource.error || resource.value?.tenantId!==tenantId)return <div><p role="alert">{resource.error||"O protocolo mudou de empresa."}</p><Button variant="outline" onClick={resource.reload}>Recarregar efeitos</Button></div>
  const summary=resource.value,locked=command.busy||command.stale||command.uncertain
  const approvals=item.approvals.filter(a=>a.decision==="approved" && !summary.movements.some(m=>m.approvalId===a.id))
  const rmas=item.rmas.filter(r=>["received","closed"].includes(r.status)&&!summary.movements.some(m=>m.rmaId===r.id))
  const credits=summary.movements.filter(m=>m.kind==="credit" && Number(m.creditRemainingCents)>0)
  const jobs=item.serviceOrders.filter(s=>["completed","in_repair"].includes(s.status))
  const review=approvals.filter(a=>!summary.reviews.some(r=>r.approvalId===a.id))
  const available:Record<Kind,boolean>={
    review:summary.canReview&&review.length>0,
    credit:summary.canCredit&&approvals.some(a=>a.action==="credit"),refund:summary.canBank&&approvals.some(a=>a.action==="refund"),
    exchange:summary.canStock&&approvals.some(a=>a.action==="exchange"),apply_credit:summary.canCredit&&credits.length>0,
    intake:summary.canStock,repair_return:summary.canStock&&Number(summary.custody)>0&&jobs.length>0,scrap:summary.canStock&&Number(summary.custody)>0,
    supplier_cash:summary.canBank&&rmas.length>0,supplier_stock:summary.canStock&&rmas.length>0&&Number(summary.custody)>0,
  }
  if(item.status==="closed") {
    for(const k of Object.keys(available) as Kind[]) if(!["apply_credit","supplier_cash","supplier_stock"].includes(k))available[k]=false
  }
  if(item.status==="cancelled") {
    for(const k of Object.keys(available) as Kind[]) if(k!=="apply_credit")available[k]=false
  }
  const isApproval=["review","credit","refund","exchange"].includes(kind)
  const isRma=kind==="supplier_cash"||kind==="supplier_stock"
  const isBank=kind==="refund"||kind==="supplier_cash"
  const hasQuantity=["intake","repair_return","scrap","supplier_stock","exchange"].includes(kind)
  const hasAmount=kind==="supplier_cash"||kind==="apply_credit"
  const options=isApproval?(kind==="review"?review:approvals.filter(a=>a.action===kind)).map(a=>({id:a.id,label:(actionLabels[a.action]||a.action)+(a.amountCents?" • "+brl(a.amountCents):"")}))
    :isRma?rmas.map(r=>({id:r.id,label:r.reference})):kind==="apply_credit"?credits.map(c=>({id:c.id,label:c.reference+" • "+brl(c.creditRemainingCents!)})):kind==="repair_return"?jobs.map(s=>({id:s.id,label:"OS "+s.id})):[]
  const supplierOrigin=rmas.find(r=>r.id===document)?.supplierId
  async function submit(){
    if(!kind)return
    const q=normalizeDecimal(qty,6),m=normalizeDecimal(amount,2)
    if(reference.trim().length<3||!date||hasQuantity&&(!q||Number(q)<=0)||hasAmount&&(!m||Number(m)<=0)||options.length&&!document||isBank&&!account||isRma&&!supplierOrigin&&!supplier||kind==="apply_credit"&&!receivable){setError("Confira a origem, referência, data e os campos da operação.");return}
    const data={kind,reference,occurredOn:date,...(isApproval?{approvalId:document}:{}),...(hasQuantity?{quantity:q}:{}),
      ...(isBank?{accountId:account}:{}),...(isRma?{rmaId:document,supplierId:supplierOrigin||supplier?.id}:{}),
      ...(hasAmount?{amountCents:Number(m!.replace(".",""))}:{}),...(kind==="apply_credit"?{sourceCreditId:document,receivableId:receivable}:{}),...(kind==="repair_return"?{serviceOrderId:document}:{})}
    setError("")
    if(await command.send<{tenantId:string}>(base,tenantId,data,resource.etag,"POST",reply=>reply.tenantId===tenantId))onChanged()
  }
  return <section className="space-y-3 rounded-lg border p-4" aria-label="Financeiro e logística da garantia">
    <h2 className="font-semibold">Financeiro e logística</h2>
    <p>Equipamentos em custódia • {units(Number(summary.custody))}</p>
    {!summary.originReady && <p>Para executar uma operação, vincule o cliente e o item de uma venda entregue ao protocolo.</p>}
    {summary.originReady && Object.values(available).some(Boolean) &&
    <div className="space-y-3">
      <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2" disabled={locked}>
        <label>Operação<select className={selectClass} value={kind} onChange={e=>{setKind(e.target.value as Kind);setDocument("");setAccount("");setError("");setSupplier(null)}}><option value="">Selecione</option>{(Object.keys(labels) as Kind[]).filter(k=>available[k]).map(k=><option key={k} value={k}>{labels[k]}</option>)}</select></label>
        {kind&&<>
          {!!options.length&&<label>Documento da operação<select className={selectClass} value={document} onChange={e=>setDocument(e.target.value)}><option value="">Selecione</option>{options.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</select></label>}
          <label>Referência do comprovante<Input maxLength={160} value={reference} onChange={e=>setReference(e.target.value)}/></label>
          <label>Data da operação<Input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
          {hasQuantity&&<label>Quantidade da operação<Input inputMode="decimal" value={qty} onChange={e=>setQty(e.target.value)}/></label>}
          {hasAmount&&<label>Valor da operação (R$)<Input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)}/></label>}
          {isBank&&<label>Conta do lançamento<select className={selectClass} value={account} onChange={e=>setAccount(e.target.value)}><option value="">Selecione</option>{summary.accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
          {isRma&&!supplierOrigin&&<div><PurchaseLookup supplier disabled={locked} choose={setSupplier}/>{supplier&&<p>Fornecedor • {supplier.legalName}</p>}</div>}
          {kind==="apply_credit"&&<div><label>Título do cliente<select className={selectClass} value={receivable} onChange={e=>setReceivable(e.target.value)}><option value="">Selecione</option>{summary.receivables.map(b=><option key={b.id} value={b.id}>Pedido {b.orderNumber} • {b.dueDate.split("-").reverse().join("/")} • {brl(b.openCents)}</option>)}</select></label>
            {summary.totalBills>15&&<div className="flex gap-2"><Button variant="outline" disabled={offset===0} onClick={()=>setOffset(offset-15)}>Títulos anteriores</Button><Button variant="outline" disabled={offset+15>=summary.totalBills} onClick={()=>setOffset(offset+15)}>Próximos títulos</Button></div>}</div>}
        </>}
      </fieldset>
      {kind&&<Button disabled={command.busy||command.stale} onClick={()=>void submit()}>{command.uncertain?"Conferir operação anterior":"Registrar operação"}</Button>}
    </div>}
    {(command.error||error)&&<p role="alert">{command.error||error}</p>}
    {command.stale&&<Button variant="outline" onClick={onChanged}>Atualizar protocolo</Button>}
    {summary.movements.length>0&&<ul className="space-y-2">{summary.movements.map(m=><li className="break-words" key={m.id}><strong>{labels[m.kind]}</strong> • {m.reference} • {m.occurredOn.split("-").reverse().join("/")}{m.amountCents!==null?" • "+brl(m.amountCents):" • "+units(Number(m.quantityMicros)/1e6)}{m.kind==="credit"&&<span> • Disponível {brl(Number(m.creditRemainingCents))}</span>}{(m.stockMovementId||m.accountEntryId||m.receivableId)&&<span className="block text-sm">Lançamento • {m.stockMovementId||m.accountEntryId||m.receivableId}</span>}
      {m.origin && <details><summary className="cursor-pointer text-sm">Ver origem da operação</summary><dl className="grid gap-1 pl-2 text-sm"><dt>Pedido e item</dt><dd>{m.origin.orderId} • {m.origin.lineNumber}</dd>{[["Nota fiscal",m.origin.documentId],["Série",m.origin.serialNumber],["Lote",m.origin.lot],["Aprovação",m.approvalId],["RMA",item.rmas.find(r=>r.id===m.rmaId)?.reference],["Ordem de serviço",m.serviceOrderId],["Fornecedor",m.supplierId],["Crédito de origem",m.sourceCreditId]].filter(([,value])=>value).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>}
    </li>)}</ul>}
  </section>
}
