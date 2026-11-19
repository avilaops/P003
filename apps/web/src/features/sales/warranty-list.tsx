"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { GuardedLink as Link } from "@/components/shell/navigation-guard"
import { PageHeader } from "@/components/page-header"
import { Button,buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Pagination } from "@/components/workspace/pagination"
import { useCommand,useResource } from "@/hooks/use-operation"
import { Lookup,type Choice } from "./orders"

export const stages:Record<string,string>={opened:"Elegibilidade",triage:"Triagem",diagnosis:"Diagnóstico",treatment:"Tratamento",resolved:"Resolvida",closed:"Encerrada",cancelled:"Cancelada"}
export const priorities:Record<string,string>={low:"Baixa",normal:"Normal",high:"Alta",critical:"Crítica"}
const select="min-h-10 rounded-lg border bg-background px-2"
type Case={id:string;protocol:string;title:string;status:string;customerName:string|null;productName:string|null;serialNumber:string|null;orderId:string|null;orderNumber:string|null;assignedToName:string|null;queue:string;slaDueAt:string|null;createdAt:string;updatedAt:string}
type Listing={tenantId:string;canEdit:boolean;data:Case[];total:number;counts?:Record<string,number>}
type Origin={documentId:string;invoiceNumber:string;orderId:string;orderNumber:string;lineNumber:number;productId:string;productName:string;customerName:string;availableUnits:number;categoryId?:string;category?:string;channel?:string;manufacturer?:string}
type Equipment=Origin & {id:string;serialNumber:string|null;lot:string|null;units:number;policySnapshot?:{name:string};expiresOn:string;remainingDays:number;coverageStatus:string}
type Policy={id:string;name:string;durationDays:number;status:string}
const date=(value:string)=>new Intl.DateTimeFormat("pt-BR",{timeZone:"America/Sao_Paulo"}).format(new Date(value))
export function WarrantyList({initiallyOpen=false}:{initiallyOpen?:boolean}) {
  const url=useSearchParams(),router=useRouter()
  const q=url.get("q") ?? "",status=url.get("status") ?? "",offset=Math.max(0,Number(url.get("offset"))||0)
  const [openedAt]=useState(()=>Date.now())
  const [search,setSearch]=useState(q)
  const query=new URLSearchParams({limit:"25",offset:String(offset)})
  if(q) query.set("q",q)
  if(status) query.set("status",status)
  const list=useResource<Listing>("/api/erp/warranty-cases?"+query)
  function filter(text:string,stage:string,at:number) {
    const params=new URLSearchParams()
    if(text.trim()) params.set("q",text.trim())
    if(stage) params.set("status",stage)
    if(at) params.set("offset",String(at))
    router.replace("/vendas/garantias"+(params.size?"?"+params:""),{scroll:false})
  }
  return <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
    <PageHeader title={initiallyOpen?"Nova solicitação de garantia":"Garantias"} breadcrumbs={[{label:"Vendas",href:"/vendas"},{label:"Garantias",href:"/vendas/garantias"}]} actions={!initiallyOpen && list.value?.canEdit && <Link className={buttonVariants()} href="/vendas/garantias/novo">Nova solicitação de garantia</Link>}/>
    {list.loading ? <p role="status">Consultando garantias…</p> : list.error ? <div role="alert">{list.error} <Button variant="outline" onClick={list.reload}>Tentar novamente</Button></div> : initiallyOpen ? list.value?.canEdit ? <CaseForm tenant={list.value.tenantId} orderId={url.get("orderId")} documentId={url.get("documentId")} /> : <p>Seu perfil pode consultar as garantias desta empresa.</p> : <>
      <Link className="text-primary underline" href="/vendas/garantias/indicadores">Indicadores da assistência</Link>
      <form role="search" className="flex flex-wrap items-end gap-2" onSubmit={e=>{e.preventDefault();filter(search,status,0)}}>
        <label className="grid flex-1 gap-1">Cliente, equipamento, série ou pedido<Input type="search" maxLength={160} value={search} onChange={e=>setSearch(e.target.value)}/></label>
        <label className="grid gap-1">Etapa<select className={select} value={status} onChange={e=>filter(search,e.target.value,0)}><option value="">Todas</option>{Object.entries(stages).map(([key,label])=><option key={key} value={key}>{label}{list.value?.counts ? " ("+(list.value.counts[key] ?? 0)+")" : ""}</option>)}</select></label>
        <Button type="submit" variant="outline">Pesquisar</Button>
      </form>
      {list.value?.data.length ? <ul className="divide-y rounded-lg border">{list.value.data.map(c=><li key={c.id} className="grid gap-2 p-3 sm:grid-cols-[2fr_2fr_1fr]">
        <div><Link className="font-semibold text-primary underline" href={"/vendas/garantias/"+c.id}>{c.title}</Link><small className="block break-all">{c.protocol}</small>{c.customerName}</div>
        <div>{[c.productName,c.serialNumber].filter(Boolean).join(" • ")}{c.orderId && <Link className="block text-primary underline" href={"/vendas/pedidos/"+c.orderId}>Pedido {c.orderNumber}</Link>}{c.assignedToName || c.queue}</div>
        <div>{stages[c.status]}<small className="block">Aberta em {date(c.createdAt)}</small>{c.slaDueAt && !["closed","cancelled","resolved"].includes(c.status) && new Date(c.slaDueAt).getTime()<openedAt && <strong>Prazo vencido</strong>}</div>
      </li>)}</ul> : <p>{q || status?"Nenhum chamado corresponde aos filtros.":"Registre aqui os chamados de garantia e assistência dos equipamentos vendidos."}</p>}
      {Boolean(offset || (list.value?.total ?? 0)>25) && <Pagination total={list.value?.total ?? 0} offset={offset} pageSize={25} onOffsetChange={v=>filter(search,status,v)}/>}
    </>}
  </div>
}
function SeriesInfo({lookup,selected,choose,chooseStock}:{lookup:{serialNumber?:string;lot?:string};selected:string;choose:(id:string)=>void;chooseStock:(o:Origin)=>void}) {
  const result=useResource<{data:Equipment|null;matches?:Equipment[];stockTracked?:boolean;stockOrigins?:Origin[]}>("/api/erp/warranty-equipment?"+new URLSearchParams(lookup))
  if(result.loading)return <p role="status">Consultando identificação…</p>
  if(result.error)return <p role="alert">{result.error}</p>
  const rows=result.value?.matches??(result.value?.data?[result.value.data]:[])
  if(!rows.length && result.value?.stockTracked) {
    const sources=result.value.stockOrigins??[]
    if(!sources.length)return <p role="status">Série localizada no estoque. A entrega ainda não tem uma nota de venda autorizada disponível para garantia.</p>
    return <section className="grid gap-2"><h2 className="font-semibold">Entrega da série no estoque</h2>
      {sources.length>1 && <p>Selecione a nota e o item e informe a referência que comprova a origem.</p>}
      {sources.map(o=><Button key={o.documentId+":"+o.lineNumber} type="button" variant="outline" onClick={()=>chooseStock(o)}>
        NF-e {o.invoiceNumber} • item {o.lineNumber} • pedido {o.orderNumber} • {o.productName} • {o.customerName}
      </Button>)}</section>
  }
  if(!rows.length)return <p role="status">Série ou lote sem vínculo fiscal. A solicitação seguirá para análise de cobertura.</p>
  return <fieldset className="space-y-2"><legend>Equipamentos com origem fiscal</legend>{rows.map(item=><label className="block" key={item.id}><input type="radio" name="sold-unit" checked={selected===item.id||rows.length===1} onChange={()=>choose(item.id)}/> {[item.customerName,item.productName,"NF-e "+item.invoiceNumber,"Pedido "+item.orderNumber,item.serialNumber,item.lot&&"Lote "+item.lot,item.policySnapshot?.name,"Cobertura até "+item.expiresOn.split("-").reverse().join("/"),item.coverageStatus==="rejected"?"Documento cancelado":item.remainingDays>=0?item.remainingDays+" dias restantes":"Prazo encerrado"].filter(Boolean).join(" • ")}</label>)}</fieldset>
}
function OrderProducts({id,selectProduct}:{id:string;selectProduct:(p:Choice|null)=>void}) {
  const result=useResource<{data:{customerName:string;number:string};items:Array<{productId:string;name:string}>}>("/api/erp/orders/"+id)
  return result.value ? <label className="grid gap-1">Pedido {result.value.data.number} • {result.value.data.customerName}<select className={select} defaultValue="" onChange={e=>{const item=result.value?.items.find(i=>i.productId===e.target.value);selectProduct(item?{id:item.productId,name:item.name}:null)}}><option value="">Selecione o equipamento</option>{result.value.items.map((i,n)=><option key={n} value={i.productId}>{i.name}</option>)}</select></label> : <p role="status">{result.error || "Consultando pedido…"}</p>
}
type Trace={brand?:string;reference?:string;channel?:string;receiptId?:string}
type Policies={tenantId:string;data:Policy[];receipts?:{id:string;name:string;reference:string;supplierId:string}[];lots?:{lot:string;availableUnits:number}[]}
function InvoiceEquipment({orderId,documentId,query,serial,lot,setLot,selectOrigin}:{query:string;orderId:string|null;documentId:string|null;serial:string;lot:string;setLot:(s:string)=>void;selectOrigin:(o:Origin)=>void}) {
 const params=new URLSearchParams();if(orderId)params.set("orderId",orderId);if(documentId)params.set("documentId",documentId);if(query)params.set("q",query)
 const source=useResource<{tenantId:string;data:Origin[]}>("/api/erp/warranty-origins?"+params)
 const [item,setItem]=useState("")
 const origin=source.value?.data.find(o=>o.documentId+":"+o.lineNumber===item)
 return <fieldset className="grid gap-3 rounded-lg border p-3"><legend>Origem fiscal do equipamento</legend>
 {source.error?<p role="alert">{source.error}</p>:source.loading?<p role="status">Consultando notas autorizadas…</p>:!source.value?.data.length?<p>Este pedido ainda não possui uma NF-e de produção autorizada com itens disponíveis para vincular.</p>:
 <label>Nota e item <select className={select} value={item} onChange={e=>{setItem(e.target.value);const o=source.value?.data.find(x=>x.documentId+":"+x.lineNumber===e.target.value);if(o)selectOrigin(o)}}><option value="">Selecione</option>{source.value.data.map(o=><option key={o.documentId+":"+o.lineNumber} value={o.documentId+":"+o.lineNumber}>NF-e {o.invoiceNumber} • {o.productName}</option>)}</select></label>}
 {origin&&<TracePolicy key={item} line={origin} tenant={source.value!.tenantId} serial={serial} lot={lot} setLot={setLot} reload={source.reload}/>}</fieldset>
}
function TracePolicy({line,tenant,serial,lot,setLot,reload}:{line:Origin;tenant:string;serial:string;lot:string;setLot:(s:string)=>void;reload:()=>void}){
 const [raw,setRaw]=useState<Trace>({}),[applied,setApplied]=useState<Trace>({}),[units,setUnits]=useState("1"),[policy,setPolicy]=useState(""),[message,setMessage]=useState("")
 const query=new URLSearchParams({documentId:line.documentId,lineNumber:String(line.lineNumber),...applied})
 const options=useResource<Policies>("/api/erp/warranty-policies?"+query),save=useCommand(),create=useCommand()
 const [policyName,setName]=useState(""),[days,setDays]=useState("365"),[scopeKeys,setScopeKeys]=useState<string[]>(["productId"]),[kind,setKind]=useState("contractual"),[from,setFrom]=useState(""),[until,setUntil]=useState("")
 const receipt=options.value?.receipts?.find(r=>r.id===raw.receiptId)
 const values:Record<string,string|undefined>={productId:line.productId,categoryId:line.categoryId,brand:raw.brand,supplierId:receipt?.supplierId,channel:line.channel||raw.channel}
 const scopes:Record<string,string>={productId:"Produto",categoryId:"Categoria",brand:"Marca",supplierId:"Fornecedor",channel:"Canal"}
 const validTrace=!(raw.brand||raw.channel&&!line.channel)&&!lot.trim()||!!raw.reference?.trim()||!!options.value?.lots?.some(l=>l.lot===lot)&&!raw.brand&&!raw.channel
 const current=JSON.stringify(raw)===JSON.stringify(applied)
 function field(key:keyof Trace,value:string){setRaw(prev=>{const next={...prev};if(value.trim())next[key]=value;else delete next[key];return next})}
 return <div className="grid gap-3">
 <p>{line.availableUnits} unidades faturadas disponíveis • {line.category||"Categoria sem registro"}{line.manufacturer&&" • Fabricante "+line.manufacturer}{line.channel&&" • Canal "+line.channel}</p>
 <label>Recebimento do fornecedor<select className={select} value={raw.receiptId||""} onChange={e=>field("receiptId",e.target.value)}><option value="">Sem vínculo</option>{options.value?.receipts?.map(r=><option key={r.id} value={r.id}>{r.name} • {r.reference}</option>)}</select></label>
 <label>Marca identificada<Input maxLength={80} value={raw.brand||""} onChange={e=>field("brand",e.target.value)}/></label>
 {!line.channel&&<label>Canal identificado<Input maxLength={80} value={raw.channel||""} onChange={e=>field("channel",e.target.value)}/></label>}
 <label>Referência de procedência<Input value={raw.reference||""} maxLength={200} placeholder="Etiqueta, certificado ou documento conferido" onChange={e=>field("reference",e.target.value)}/></label>
 {Boolean(options.value?.lots?.length)&&<label>Lote da NF-e<select className={select} value={lot} onChange={e=>setLot(e.target.value)}><option value="">Selecione</option>{options.value?.lots?.map(l=><option key={l.lot} value={l.lot}>{l.lot} • {l.availableUnits} disponíveis</option>)}</select></label>}
 {!serial.trim()&&lot.trim()&&<label>Unidades identificadas no lote<Input type="number" min={1} max={line.availableUnits} value={units} onChange={e=>setUnits(e.target.value)}/></label>}
 <Button type="button" variant="outline" disabled={!validTrace||current} onClick={()=>{setApplied(raw);setPolicy("")}}>Consultar políticas aplicáveis</Button>
 {options.error&&<p role="alert">{options.error}</p>}
 <label>Política de garantia <select className={select} value={policy} onChange={e=>setPolicy(e.target.value)}><option value="">Selecione</option>{options.value?.data.filter(p=>p.status==="active").map(p=><option key={p.id} value={p.id}>{p.name} • {p.durationDays} dias</option>)}</select></label>
 <details><summary>Cadastrar política de cobertura</summary><div className="grid gap-2">
 <label>Nome da política<Input value={policyName} onChange={e=>setName(e.target.value)}/></label><label>Prazo em dias<Input type="number" min={1} max={3650} value={days} onChange={e=>setDays(e.target.value)}/></label>
 <label>Tipo de cobertura<select className={select} value={kind} onChange={e=>setKind(e.target.value)}><option value="contractual">Contratual</option><option value="legal">Legal</option><option value="extended">Estendida</option></select></label>
 <label>Válida para vendas a partir de<Input value={from} type="date" onChange={e=>setFrom(e.target.value)}/></label><label>Válida para vendas até<Input value={until} type="date" min={from} onChange={e=>setUntil(e.target.value)}/></label>
 <fieldset><legend>Escopo • sem filtros aplica-se à empresa</legend>{Object.entries(scopes).map(([key,label])=><label key={key} className="mr-3"><input type="checkbox" disabled={!values[key]} checked={scopeKeys.includes(key)} onChange={e=>setScopeKeys(keys=>e.target.checked?[...keys,key]:keys.filter(v=>v!==key))}/> {label}</label>)}</fieldset>
 <Button type="button" variant="outline" disabled={create.busy||!current||policyName.trim().length<3||!Number.isInteger(Number(days))||Number(days)<1||Number(days)>3650||scopeKeys.some(k=>!values[k])} onClick={async()=>{const r=await create.send<{data:Policy}>("/api/erp/warranty-policies",tenant,{name:policyName,coverageType:kind,durationDays:Number(days),scope:Object.fromEntries(scopeKeys.map(k=>[k,values[k]])),...(from?{validFrom:from}:{}),...(until?{validUntil:until}:{})});if(r){options.reload();setPolicy(r.data.id)}}}>Salvar política</Button>{create.error&&<p role="alert">{create.error}</p>}</div></details>
 <Button type="button" variant="outline" disabled={save.busy||!current||!validTrace||!policy||(!serial.trim()&&!lot.trim())||line.availableUnits<1} onClick={async()=>{const r=await save.send("/api/erp/warranty-equipment",tenant,{...(serial.trim()?{serialNumber:serial.trim()}:{}),...(lot.trim()?{lot:lot.trim()}:{}),units:serial.trim()?1:Number(units),documentId:line.documentId,lineNumber:line.lineNumber,policyId:policy,trace:applied});if(r){setMessage("Identificação vinculada à venda.");reload();options.reload()}}}>Vincular série ou lote à nota</Button>
 {save.error&&<p role="alert">{save.error}</p>}{message&&<p role="status">{message}</p>}</div>
}
function CaseForm({tenant,orderId,documentId}:{tenant:string;orderId:string|null;documentId:string|null}) {
  const router=useRouter(),command=useCommand()
  const [title,setTitle]=useState(""),[description,setDescription]=useState(""),[criticality,setCriticality]=useState("normal")
  const [serial,setSerial]=useState(""),[queried,setQueried]=useState(""),[equipmentId,setEquipment]=useState(""),[lot,setLot]=useState("")
  const [customer,setCustomer]=useState<Choice|null>(null),[product,setProduct]=useState<Choice|null>(null),[sourceOrder,setSourceOrder]=useState(orderId)
  const [searchOrigin,setSearchOrigin]=useState(""),[appliedSearch,setAppliedSearch]=useState("")
  const [fiscal,setFiscal]=useState<Origin|null>(null),[inventoryOrigin,setInventoryOrigin]=useState<Origin|null>(null)
  const [lookupVersion,setLookupVersion]=useState(0)
  function chooseDelivery(origin:Origin) {
    setFiscal(origin);setSourceOrder(origin.orderId);setProduct({id:origin.productId,name:origin.productName});setCustomer(null);setEquipment("")
    setInventoryOrigin(origin)
  }
  return <form className="grid max-w-3xl gap-3" onSubmit={async e=>{e.preventDefault();const response=await command.send<{data:{id:string}}>("/api/erp/warranty-cases",tenant,{title,description,criticality,serialNumber:serial.trim()||null,lot:lot.trim()||null,...(equipmentId?{equipmentId}:{}),orderId:sourceOrder,documentId:fiscal?.documentId??null,lineNumber:fiscal?.lineNumber??null,productId:product?.id??null,customerId:customer?.id??null});if(response)router.push("/vendas/garantias/"+response.data.id)}}>
    <label>Título<Input required minLength={3} maxLength={160} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label className="grid">Descrição<textarea className="min-h-20 rounded-lg border p-2" required minLength={15} maxLength={10000} value={description} onChange={e=>setDescription(e.target.value)}/></label>
    <label>Criticidade <select className={select} value={criticality} onChange={e=>setCriticality(e.target.value)}>{Object.entries(priorities).map(([s,label])=><option key={s} value={s}>{label}</option>)}</select></label>
    <label>Número de série<Input maxLength={120} value={serial} onChange={e=>{setSerial(e.target.value);setEquipment("");if(inventoryOrigin){setInventoryOrigin(null);setFiscal(null);setSourceOrder(orderId);setProduct(null)}}}/></label>
    <label>Lote<Input maxLength={120} value={lot} onChange={e=>{setLot(e.target.value);setEquipment("")}}/></label>
    <Button type="button" variant="outline" disabled={!serial.trim()&&!lot.trim()} onClick={()=>{setQueried(JSON.stringify([serial,lot]));setEquipment("")}}>Consultar série ou lote</Button>{queried===JSON.stringify([serial,lot])&&<SeriesInfo key={lookupVersion} chooseStock={chooseDelivery} lookup={{...(serial.trim()?{serialNumber:serial.trim()}:{}),...(lot.trim()?{lot:lot.trim()}:{})}} selected={equipmentId} choose={setEquipment}/>}
    {inventoryOrigin && <TracePolicy key={inventoryOrigin.documentId+":"+inventoryOrigin.lineNumber} line={inventoryOrigin} tenant={tenant} serial={serial} lot={lot} setLot={setLot} reload={()=>setLookupVersion(n=>n+1)}/>}
    {inventoryOrigin ? <p>Origem selecionada • pedido {inventoryOrigin.orderNumber} • NF-e {inventoryOrigin.invoiceNumber} • item {inventoryOrigin.lineNumber}</p> : sourceOrder ? <OrderProducts id={sourceOrder} selectProduct={setProduct}/> : <><Lookup endpoint="parties" label="cliente" choose={setCustomer} selectedName={customer?.legalName} disabled={false} compact searchOnly/><Lookup endpoint="products" label="equipamento" choose={setProduct} selectedName={product?.name} disabled={false} compact searchOnly/></>}
    {!orderId&&!documentId&&<div className="space-y-2"><label>Procurar origem fiscal<Input value={searchOrigin} onChange={e=>setSearchOrigin(e.target.value)} maxLength={80} placeholder="Pedido, NF-e, cliente ou SKU"/></label><Button type="button" variant="outline" disabled={searchOrigin.trim().length<2} onClick={()=>{setAppliedSearch(searchOrigin.trim());setFiscal(null);setInventoryOrigin(null);setSourceOrder(null);setEquipment("")}}>Consultar notas de venda</Button></div>}
    {!inventoryOrigin && (orderId || documentId || appliedSearch) && <InvoiceEquipment key={appliedSearch} query={appliedSearch} orderId={orderId} documentId={documentId} serial={serial} lot={lot} setLot={v=>{setLot(v);setEquipment("")}} selectOrigin={o=>{setFiscal(o);setSourceOrder(o.orderId);setProduct({id:o.productId,name:o.productName})}}/>}
    {product && <p>Equipamento • {product.name}</p>}{command.error && <p role="alert">{command.error}</p>}
    <Button type="submit" disabled={command.busy || title.trim().length<3 || description.trim().length<15}>{command.uncertain?"Conferir abertura":"Abrir garantia"}</Button>
  </form>
}
