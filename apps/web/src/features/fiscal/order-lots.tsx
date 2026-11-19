"use client"

import Link from "next/link"
import { useEffect,useRef,useState,useMemo } from "react"
import {OwnReturnForm,ownReturnStatus} from "./own-return"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCommand, useResource } from "@/hooks/use-operation"
import { decimalMicros, inputMicros, type OrderLots, type FiscalLot, type LotEnvironment } from "./order-lots-model"

const statuses:Record<string,string>={reserved:"Aguardando rascunho",draft:"Rascunho",withdrawn:"Reserva liberada",authorized:"Autorizada",rejected:"Rejeitada",cancelled:"Cancelada",preparing:"Em preparação",prepared:"Preparada",unknown:"Aguardando consulta"}
const destinations:Record<string,string>={stock:"Estoque",service:"Assistência",discard:"Descarte"}
const qty=(v:string)=>decimalMicros(v).replace(/\.?0+$/,"").replace(".",",") || "0"
const money=(v:string)=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(v)/100)

type CreditTitle={id:string;orderNumber:string;dueOn:string;openCents:string}
function ApplyReturnCredit({tenant,path,returnId,remaining,locked,send}:{tenant:string;path:string;returnId:string;remaining:string;locked:boolean;send:(body:object)=>Promise<void>}) {
  const [offset,setOffset]=useState(0),[bill,setBill]=useState(""),[amount,setAmount]=useState("")
  const options=useResource<{tenantId:string;data:CreditTitle[];more:boolean}>(path+"?environment=production&creditOffset="+offset)
  const page=options.value?.tenantId===tenant?options.value:null
  const selected=page?.data.find(row=>row.id===bill)
  const parts=/^(\d{1,12})(?:[,.](\d{1,2}))?$/.exec(amount.trim())
  const cents=parts?BigInt(parts[1])*BigInt(100)+BigInt((parts[2]||"").padEnd(2,"0")):BigInt(0)
  const valid=!!selected && cents>BigInt(0) && cents<=BigInt(remaining) && cents<=BigInt(selected.openCents)
  function pageTo(next:number){setOffset(next);setBill("");setAmount("")}
  return <form className="grid max-w-lg gap-2 py-2" onSubmit={e=>{e.preventDefault();if(valid)void send({action:"applyCredit",returnId,receivableId:bill,amountCents:cents.toString()})}}>
    {options.error && <p role="alert">{options.error}</p>}
    {options.loading && <p role="status">Consultando títulos em aberto…</p>}
    <label>Título em aberto do cliente<select className="block min-h-10 w-full rounded-md border bg-background px-2" value={bill} onChange={e=>setBill(e.target.value)} disabled={locked || !page?.data.length}>
      <option value="">{page && !page.data.length?"Nenhum título em aberto":"Selecione o título"}</option>
      {page?.data.map(row=><option key={row.id} value={row.id}>Pedido {row.orderNumber} • {row.dueOn.split("-").reverse().join("/")} • {money(row.openCents)}</option>)}
    </select></label>
    {(offset>0 || page?.more) && <div className="flex gap-2"><Button size="sm" type="button" variant="outline" disabled={locked || offset===0} onClick={()=>pageTo(offset-15)}>Anteriores</Button>
      <Button size="sm" type="button" variant="outline" disabled={locked || !page?.more} onClick={()=>pageTo(offset+15)}>Próximos</Button></div>}
    <label>Valor do crédito a aplicar (R$)<Input inputMode="decimal" maxLength={15} required value={amount} onChange={e=>setAmount(e.target.value)}/></label>
    <Button disabled={locked || !valid} type="submit">Confirmar abatimento no título</Button>
  </form>
}

export function OrderFiscalLots({id,tenant,permissions,disabled,onChange}:{id:string;tenant:string;permissions:string[];disabled:boolean;onChange:()=>void}) {
  const [environment,setEnvironment]=useState<LotEnvironment>(()=>typeof window!=="undefined" && new URLSearchParams(window.location.search).get("ambiente")==="homologation" ? "homologation" : "production")
  const path="/api/erp/fiscal/order-lots/"+id
  const read=useResource<OrderLots>(path+"?environment="+environment), action=useCommand()
  const data=read.value?.tenantId===tenant && read.value.orderId===id && read.value.environment===environment ? read.value:null
  const [amounts,setAmounts]=useState<Record<number,string>>({})
  const [ownLotChoice,setOwnLot]=useState<string|null>(null)
  const [unitInput,setUnitInput]=useState<Record<string,string>>({})
  function serialCommand(lot:FiscalLot){
    const serials=lot.items.filter(i=>i.tracked).map(i=>({lineNumber:i.lineNumber,serials:(unitInput[lot.id+":"+i.lineNumber]||"").split(/\r?\n/).map(n=>n.trim()).filter(Boolean)})).filter(row=>row.serials.length)
    return serials.length?{serials}:{}
  }
  const [returnLot,setReturnLot]=useState(""),[received,setReceived]=useState(""),[reason,setReason]=useState(""),[destination,setDestination]=useState("stock")
  const panel=useRef<HTMLDetailsElement>(null),initialized=useRef("")
  const requestedLot=useMemo(()=>{
    if (!data || typeof window==="undefined") return ""
    const documentId=new URLSearchParams(window.location.search).get("devolucao")
    const lot=documentId ? data.lots.find(l=>l.draftId===documentId) : undefined
    return lot?.status==="authorized" && (lot.deliveredAt || environment==="homologation") ? lot.id : ""
  },[data,environment])
  const ownLot=ownLotChoice ?? requestedLot
  const [creditForm,setCreditForm]=useState("")
  const [decisions,setDecisions]=useState<Record<string,string>>({})
  useEffect(()=>{
    if (!data || !panel.current || initialized.current===id) return
    const params=new URLSearchParams(window.location.search)
    initialized.current=id
    const documentId=params.get("devolucao")
    if(!documentId) return
    panel.current.open=true
  },[data,id])
  const [error,setError]=useState(""),[notice,setNotice]=useState("")
  const allowed=(...perms:string[])=>perms.every(p=>permissions.includes(p))
  const manage=allowed("sales.orders.manage","fiscal.nfe.manage")
  const locked=disabled || read.loading || action.busy || action.uncertain || action.stale
  async function send(body:object) {
    if (!data || !read.etag || disabled) return
    setError(""); setNotice("")
    const result=await action.send<{tenantId:string;orderId:string;id:string;status?:string}>(path,tenant,{...body,environment},read.etag,"POST",v=>v.tenantId===tenant && v.orderId===id && !!v.id)
    if (result) {setUnitInput({});setOwnLot("");setCreditForm("");setAmounts({});setReturnLot("");setReceived("");setReason("");setNotice("Operação registrada no pedido.");read.reload();onChange()}
  }
  function prepare() {
    try {
      const items=Object.entries(amounts).filter(([,value])=>value.trim()).map(([line,value])=>({lineNumber:Number(line),quantityMicros:inputMicros(value)})).filter(i=>i.quantityMicros!=="0")
      if (!items.length) throw new Error("Informe a quantidade a faturar em pelo menos uma linha")
      void send({action:"prepare",items})
    } catch(e) {setError(e instanceof Error ? e.message : "Confira a quantidade")}
  }
  return <details ref={panel} id="faturamento-devolucoes" className="rounded-lg border p-3"><summary className="cursor-pointer font-medium">Faturamento por item e devoluções</summary>
    <div className="mt-4 space-y-4 text-sm">
      <Link className="text-primary underline" href="/vendas/devolucoes">Lista de devoluções</Link>
      <label className="grid max-w-xs gap-1">Ambiente<select className="h-10 rounded-md border bg-background px-2" value={environment} disabled={locked} onChange={e=>{setEnvironment(e.target.value as LotEnvironment);setUnitInput({});setOwnLot("");setAmounts({});setReturnLot("");setError("");setNotice("")}}><option value="production">Produção</option><option value="homologation">Homologação</option></select></label>
      {read.loading && <p role="status">Consultando saldos por item…</p>}
      {(error || read.error || action.error) && <p role="alert">{error || read.error || action.error}</p>}
      {notice && <p role="status">{notice}</p>}
      {action.uncertain && <Button variant="outline" disabled={disabled || action.busy} onClick={()=>void send({})}>Confirmar a mesma operação</Button>}
      {!action.uncertain && <Button variant="outline" size="sm" disabled={disabled || action.busy} onClick={()=>{action.reset();read.reload()}}>Atualizar saldos</Button>}
      {data && <>
        <div className="grid gap-2 sm:grid-cols-2">{data.lines.map(line=><article key={line.lineNumber} className="space-y-1 rounded-md border p-3">
          <p className="font-medium">{line.sku} • {line.name}</p>
          <p>Pedido {qty(line.ordered)} • Faturado {qty(line.billed)} • Entregue {qty(line.delivered)} • Devolvido {qty(line.returned)}</p>
          <p>Disponível para faturar • {qty(line.available)} {line.unit}</p>
          {manage && data.status==="confirmed" && line.available!=="0" && <label className="grid gap-1">Quantidade a faturar • {line.sku}<Input inputMode="decimal" disabled={locked} value={amounts[line.lineNumber] || ""} onChange={e=>setAmounts({...amounts,[line.lineNumber]:e.target.value})}/></label>}
        </article>)}</div>
        {manage && data.status==="confirmed" && data.lines.some(l=>l.available!=="0") && <Button disabled={locked} onClick={prepare}>Reservar itens para uma NF-e</Button>}
        {data.lots.map(lot=><article key={lot.id} className="space-y-2 border-t pt-3">
          <h3 className="font-medium">{lot.number ? "NF-e "+lot.number : "Lote "+lot.id.slice(0,8)} • {statuses[lot.status] || lot.status}{lot.deliveredAt && " • Entregue"}</h3>
          <p>{lot.items.map(i=>i.sku+" • "+qty(i.quantity)).join(", ")}</p>
          {environment==="production" && lot.status==="authorized" && (returnLot===lot.id || ownLot===lot.id || !lot.deliveredAt && allowed("sales.orders.manage","inventory.stock.manage")) &&
            lot.items.filter(i=>i.tracked).map(i=><label key={i.lineNumber} className="grid max-w-lg gap-1">Séries {lot.deliveredAt?"devolvidas":"entregues"} • {i.sku} • uma por linha
              <textarea className="min-h-16 rounded border bg-background px-2 py-1" disabled={locked} value={unitInput[lot.id+":"+i.lineNumber]||""} onChange={e=>setUnitInput({...unitInput,[lot.id+":"+i.lineNumber]:e.target.value})}/>
            </label>)}
          <div className="flex flex-wrap gap-3">
            {manage && lot.status==="reserved" && <Link className="text-primary underline" href={`/fiscal/notas-saida/nova?pedido=${id}&lote=${lot.id}&ambiente=${environment}`}>Preparar NF-e do lote</Link>}
            {lot.draftId && <Link className="text-primary underline" href={`/fiscal/notas-saida/${lot.draftId}`+(lot.legacyFull ? "" : `?pedido=${id}&lote=${lot.id}&ambiente=${environment}`)}>Abrir nota</Link>}
            {manage && ["draft","reserved"].includes(lot.status) && <Button variant="outline" size="sm" disabled={locked} onClick={()=>void send({action:"withdraw",lotId:lot.id})}>Liberar saldo do lote</Button>}
            {environment==="production" && lot.status==="authorized" && !lot.deliveredAt && data.status==="confirmed" && allowed("sales.orders.manage","inventory.stock.manage") && <Button size="sm" disabled={locked} onClick={()=>{if(window.confirm("Registrar a entrega deste lote e baixar o estoque?")) void send({action:"deliver",lotId:lot.id,...serialCommand(lot)})}}>Registrar entrega</Button>}
            {lot.status==="authorized" && lot.deliveredAt && allowed("sales.orders.manage","fiscal.received_nfe.manage","inventory.stock.manage","finance.receivables.manage") && <Button variant="outline" size="sm" disabled={locked} onClick={()=>setReturnLot(lot.id)}>Vincular NF-e recebida do cliente</Button>}
          </div>
          {lot.status==="authorized" && (lot.deliveredAt || environment==="homologation") && manage && !data.ownReturns?.some(p=>p.lotId===lot.id && ["pending","ready"].includes(p.status)) &&
            <Button variant="outline" size="sm" disabled={locked} onClick={()=>setOwnLot(ownLot===lot.id?"":lot.id)}>Emitir NF-e de entrada de devolução</Button>}
          {ownLot===lot.id && manage && !data.ownReturns?.some(p=>p.lotId===lot.id && ["pending","ready"].includes(p.status)) && <OwnReturnForm lot={lot} locked={locked} send={body=>send({...body,...serialCommand(lot)})}/>}
          {returnLot===lot.id && allowed("sales.orders.manage","fiscal.received_nfe.manage","inventory.stock.manage","finance.receivables.manage") && <form className="grid max-w-xl gap-2" onSubmit={e=>{e.preventDefault();void send({action:"return",lotId:lot.id,receivedId:received,reason,destination,...serialCommand(lot)})}}>
            <p>Use uma NF-e de devolução recebida do cliente que referencie esta nota. O sistema confere as linhas da entrada e abate os títulos em aberto. O valor restante gera crédito.</p>
            <Link className="text-primary underline" href="/compras/notas-entrada?origem=vendas" target="_blank">Consultar notas de entrada</Link>
            <label>Registro da NF-e de entrada<Input required pattern="[1-9][0-9]*" inputMode="numeric" disabled={locked} value={received} onChange={e=>setReceived(e.target.value)}/></label>
            <label>Motivo<Input required minLength={3} maxLength={200} disabled={locked} value={reason} onChange={e=>setReason(e.target.value)}/></label>
            <label className="grid">Destino dos itens<select className="h-10 rounded-md border bg-background" disabled={locked} value={destination} onChange={e=>setDestination(e.target.value)}>{Object.entries(destinations).map(([k,label])=><option key={k} value={k}>{label}</option>)}</select></label>
            <Button type="submit" disabled={locked}>Conciliar devolução</Button>
          </form>}
        </article>)}
        {data.ownReturns?.map(p=><article className="grid gap-2 rounded border p-3" key={p.id}>
          <h3 className="font-medium">Entrada de devolução própria • {ownReturnStatus[p.status]}{p.emissionStatus?" • "+(statuses[p.emissionStatus]||p.emissionStatus):""}</h3>
          <p>{p.reason} • {destinations[p.destination]}</p><Link className="text-primary underline" href={"/fiscal/notas-saida/"+p.id}>Abrir NF-e de entrada para revisar ou emitir</Link>
          {p.receivedId && <Link className="text-primary underline" href={"/fiscal/monitor/"+p.receivedId+"?origem=vendas"}>Consultar entrada arquivada</Link>}
          {p.decisionReason && <p>Decisão • {p.decisionReason}</p>}
          {p.canDecide && manage && <div><label>Justificativa da decisão<Input value={decisions[p.id]||""} onChange={e=>setDecisions({...decisions,[p.id]:e.target.value})}/></label>
            {[true,false].map(approve=><Button key={String(approve)} size="sm" variant="outline" disabled={locked || (decisions[p.id]||"").trim().length<3} onClick={()=>void send({action:"decideOwnReturn",planId:p.id,approve,reason:decisions[p.id]})}>{approve?"Aprovar emissão":"Recusar emissão"}</Button>)}</div>}
          {p.status==="ready" && p.emissionStatus==="authorized" && manage && (environment==="homologation" || allowed("finance.receivables.manage","inventory.stock.manage","fiscal.received_nfe.manage")) && <Button disabled={locked} onClick={()=>void send({action:"completeOwnReturn",planId:p.id})}>{environment==="homologation"?"Concluir simulação fiscal":"Concluir devolução e aplicar efeitos"}</Button>}
          {["ready","pending"].includes(p.status) && (!p.emissionStatus || ["rejected","cancelled"].includes(p.emissionStatus)) && manage && <Button variant="outline" disabled={locked} onClick={()=>{if(window.confirm("Liberar esta solicitação de devolução?"))void send({action:"releaseOwnReturn",planId:p.id})}}>Liberar solicitação</Button>}
        </article>)}
        {environment==="production" && <Link className="text-primary underline" href="/preferencias/politicas-vendas#devolucoes">Consultar política de devoluções</Link>}
        {data.returnRequests?.map(req=><article key={req.id} className="space-y-2 border-t pt-3"><h3 className="font-medium">Devolução • {req.status==="pending"?"Aguardando aprovação":req.status==="approved"?"Aprovada":"Recusada"}</h3>
          <p><Link className="text-primary underline" href={"/fiscal/monitor/"+req.receivedId+"?origem=vendas"}>Entrada {req.receivedId}</Link> • {req.reason} • {destinations[req.destination]}{req.amountCents!==null && " • "+money(req.amountCents)}</p>
          {req.decisionReason && <p>Decisão • {req.decisionReason}</p>}{req.canDecide && allowed("sales.orders.manage","fiscal.received_nfe.manage","inventory.stock.manage","finance.receivables.manage") && <div className="grid max-w-lg gap-2">
            <label>Justificativa da decisão<Input maxLength={200} value={decisions[req.id] || ""} disabled={locked} onChange={e=>setDecisions({...decisions,[req.id]:e.target.value})}/></label>
            <div className="flex gap-2">{[true,false].map(approve=><Button key={String(approve)} size="sm" variant={approve?"default":"outline"} disabled={locked || (decisions[req.id]||"").trim().length<3} onClick={()=>void send({action:"decideReturn",approve,requestId:req.id,reason:decisions[req.id]})}>{approve?"Aprovar devolução":"Recusar devolução"}</Button>)}</div>
          </div>}</article>)}
        {data.returns.map(r=><article key={r.id} className="border-t pt-3"><Link className="text-primary underline" href={`/fiscal/monitor/${r.receivedId}?origem=vendas`}>Entrada {r.receivedId}</Link><p>{r.reason} • {destinations[r.destination]}{r.abatedCents!==null && r.creditedCents!==null && <> • Abatimento {money(r.abatedCents)} • Crédito {money(r.creditedCents)}{r.remainingCreditCents!=null && " • Saldo "+money(r.remainingCreditCents)}</>}{r.commissionReversedCents!==null && <> • Estorno de comissão {money(r.commissionReversedCents)}</>}</p>
          {r.remainingCreditCents!=null && BigInt(r.remainingCreditCents)>BigInt(0) && allowed("sales.orders.manage","finance.receivables.manage") && <Button size="sm" variant="outline" onClick={()=>setCreditForm(creditForm===r.id?"":r.id)} aria-expanded={creditForm===r.id}>Aplicar crédito em título</Button>}
          {r.remainingCreditCents && creditForm===r.id && <ApplyReturnCredit key={r.id} tenant={tenant} path={path} returnId={r.id} remaining={r.remainingCreditCents} locked={locked} send={send}/>}
        </article>)}
      </>}
    </div>
  </details>
}
