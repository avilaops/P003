"use client"

import Link from "next/link"
import {useSearchParams} from "next/navigation"
import {useState} from "react"
import {PageHeader} from "@/components/page-header"
import {Input} from "@/components/ui/input"
import {Button} from "@/components/ui/button"
import {useCommand,useResource} from "@/hooks/use-operation"
import {commercialQuantity} from "@/features/sales/order-presentation"
import {SerialScanner} from "./serial-scanner"
import {stockUrl,textLink,type StockList} from "./stock-model"
import {selectClass} from "./stock-location-model"

const api="/api/erp/stock/serials", path="/estoque/series"
const states:Record<string,string>={available:"Em estoque",reserved:"Reservada",sold:"Vendida",service:"Em assistência",written_off:"Baixada",in_transit:"Em transferência"}
const docs:Record<string,string>={sale:"Pedido de venda",purchase:"Pedido de compra",pos:"Sessão de caixa",count:"Inventário",production:"Ordem de produção"}
type Opening={warehouseId:string;name:string;orderId:string|null;quantity:string}
type Row={productId:string;name:string;sku:string;serial:string;status:string;warehouse:string;customer:string|null;orderId:string|null;
  invoiceId:string|null;invoiceNumber:string|null;invoiceSeries:number|null;saleDate:string|null}
type Selection={kind:string;direction:string;serials:string[];revision:number}
type Snapshot={tenantId:string;canEdit:boolean;product:{id:string;name:string;sku:string;tracked:boolean}|null;data:Row[];
  opening:Opening[];assignmentKinds:string[];selections:Selection[];hasMore:boolean}
const numbers=(text:string)=>text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)
export function SerialWorkspace({tenant}:{tenant:string}){
  const params=useSearchParams(), company=params.get("tenant"), valid=!company||tenant===company
  const productId=valid ? params.get("productId") : null, documentId=valid ? params.get("documentId") : null
  const [text,setText]=useState(""),[query,setQuery]=useState(""),[offset,setOffset]=useState(0),[selected,setSelected]=useState<Row|null>(null)
  const [notice,setNotice]=useState("")
  const result=useResource<Snapshot>(stockUrl(api,{productId,documentId,q:query,offset,limit:25}))
  const value=result.value?.tenantId===tenant ? result.value:null
  function search(q:string){setQuery(q);setText(q);setOffset(0);setSelected(null)}
  function refresh(message:string){setNotice(message);result.reload()}
  return <div className="workspace-page-frame"><PageHeader title="Números de série" back={{href:"/estoque/saldos",label:"Saldos de estoque"}}/>
    <section className="form-section space-y-3"><form className="flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault();search(text)}}>
      <label>Número de série ou SKU<Input value={text} maxLength={160} onChange={e=>setText(e.target.value)}/></label><Button type="submit">Buscar série</Button></form>
      <SerialScanner onRead={search}/>
      {(productId||documentId)&&<Link className={textLink} href={path}>Consultar todas as séries</Link>}
      {documentId&&<p className="break-all">Documento • {documentId}</p>}
      {result.loading?<p role="status">Consultando séries…</p>:!value?<p role="alert">{result.error||"Não foi possível consultar a empresa."}</p>:<>
        {value.product&&<h2 className="font-semibold">{value.product.name} • SKU {value.product.sku}</h2>}
        {value.data.length===0?<p>Nenhuma série encontrada.</p>:<ul className="divide-y">{value.data.map(row=><li key={row.productId+row.serial} className="space-y-1 py-2">
          <strong>{row.serial} • {row.name}</strong><p>{states[row.status]} • {row.warehouse}</p>
          {row.saleDate&&<p>Última venda • {new Date(row.saleDate).toLocaleDateString("pt-BR",{timeZone:"America/Sao_Paulo"})}{row.customer&&" • "+row.customer}</p>}
          {row.orderId&&<Link className={textLink} href={"/vendas/pedidos/"+row.orderId}>Abrir pedido</Link>}
          {row.invoiceId&&<Link className={textLink} href={"/fiscal/notas-saida/"+row.invoiceId}>NF-e {row.invoiceNumber} • Série {row.invoiceSeries}</Link>}
          <Button type="button" variant="outline" onClick={()=>setSelected(row)}>Histórico de {row.serial}</Button>
        </li>)}</ul>}
        {(offset>0||value.hasMore)&&<div className="flex gap-2"><Button disabled={!offset} onClick={()=>setOffset(offset-25)}>Anterior</Button>
          <Button disabled={!value.hasMore} onClick={()=>setOffset(offset+25)}>Próxima</Button></div>}
      </>}
    </section>
    {selected&&<Timeline key={selected.productId+selected.serial} row={selected} tenant={tenant}/>}
    {notice&&<p role="status">{notice}</p>}
    {!productId&&<ProductPicker tenant={tenant} documentId={documentId}/>}
    {value?.product&&!value.product.tracked&&value.canEdit&&<OpeningForm key={value.product.id} tenant={tenant} productId={value.product.id} opening={value.opening} saved={()=>refresh("Controle por série ativado.")}/>}
    {value?.product?.tracked&&value.assignmentKinds.length>0&&<Assignment key={value.product.id} value={value} documentId={documentId??""}
      saved={()=>refresh("Séries vinculadas ao documento.")}/>}
  </div>
}
function ProductPicker({tenant,documentId}:{tenant:string;documentId:string|null}){
  const [q,setQ]=useState("")
  const list=useResource<StockList>(stockUrl("/api/erp/stock",{q,limit:15,status:"active"}))
  return <section className="form-section space-y-2"><label>Localizar produto para controle de série<Input value={q} onChange={e=>setQ(e.target.value)}/></label>
    {q&&list.value?.tenantId===tenant&&<ul>{list.value.data.map(p=><li key={p.productId}><Link className={textLink} href={stockUrl(path,{tenant,documentId,productId:p.productId})}>
      {p.name} • SKU {p.sku}</Link></li>)}</ul>}</section>
}
function OpeningForm({tenant,productId,opening,saved}:{tenant:string;productId:string;opening:Opening[];saved:()=>void}){
  const cmd=useCommand()
  return <form className="form-section space-y-3" onSubmit={async e=>{
    e.preventDefault();const data=new FormData(e.currentTarget)
    const groups=opening.map((g,i)=>({warehouseId:g.warehouseId,...(g.orderId?{orderId:g.orderId}:{}),serials:numbers(String(data.get("g"+i)||""))}))
    if(await cmd.send(api+"/configure",tenant,{productId,opening:groups},"","POST",(r:{tracked:boolean;tenantId:string})=>r.tenantId===tenant&&r.tracked)) saved()
  }}><h2 className="font-semibold">Ativar controle por série</h2><p>Cada unidade deste produto passará a exigir um número de série nas entradas e saídas.</p>
    <fieldset disabled={cmd.uncertain||cmd.busy}>{opening.map((g,i)=><label className="block" key={g.warehouseId+(g.orderId??"")}>
      {g.name} • {commercialQuantity(g.quantity)} unidades{g.orderId?" • Pedido "+g.orderId:" livres"} (uma série por linha)
      <textarea required name={"g"+i} className="block w-full rounded border p-2"/></label>)}</fieldset>
    {cmd.error&&<p role="alert">{cmd.error}</p>}<Button type="submit" disabled={cmd.busy}>{cmd.uncertain?"Repetir confirmação":"Ativar controle de série"}</Button>
  </form>
}
function Assignment({value,documentId,saved}:{value:Snapshot;documentId:string;saved:()=>void}){
  const [kind,setKind]=useState(value.assignmentKinds[0]||"sale"),[doc,setDoc]=useState(documentId),[direction,setDirection]=useState("issue"),[series,setSeries]=useState("")
  const cmd=useCommand(), productId=value.product!.id
  const checked=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(doc)
  const revision=useResource<Snapshot>(stockUrl(api,{productId,documentId:checked?doc:null,limit:1}))
  const dir=kind==="purchase"?"receipt":kind==="sale"||kind==="pos"?"issue":direction
  const existing=revision.value?.tenantId===value.tenantId?revision.value.selections.find(s=>s.kind===kind&&s.direction===dir):undefined
  return <form className="form-section space-y-3" onSubmit={async e=>{
    e.preventDefault()
    const r=await cmd.send(api+"/assign",value.tenantId,{productId,documentId:doc,kind,direction:dir,serials:numbers(series),revision:existing?.revision??0},"","POST",(v:{tenantId:string})=>v.tenantId===value.tenantId)
    if(r){setSeries("");revision.reload();saved()}
  }}><h2 className="font-semibold">Séries do documento</h2><fieldset disabled={cmd.busy||cmd.uncertain} className="grid gap-3 sm:grid-cols-2">
    <label>Tipo de documento<select className={selectClass} value={kind} onChange={e=>setKind(e.target.value)}>{value.assignmentKinds.map(k=><option key={k} value={k}>{docs[k]}</option>)}</select></label>
    <label>Identificador do documento<Input required value={doc} onChange={e=>setDoc(e.target.value.trim())}/></label>
    {(kind==="production"||kind==="count")&&<label>Movimento<select className={selectClass} value={direction} onChange={e=>setDirection(e.target.value)}><option value="issue">Saída</option><option value="receipt">Entrada</option></select></label>}
    <label>Números de série (um por linha)<textarea className="block w-full rounded border p-2" required value={series} onChange={e=>setSeries(e.target.value)}/></label>
    <SerialScanner onRead={s=>setSeries(current=>[current,s].filter(Boolean).join("\n"))}/>
    </fieldset>{existing&&existing.serials.length>0&&<p>Seleção atual • {existing.serials.join(", ")}</p>}
    {cmd.error&&<p role="alert">{cmd.error}</p>}{cmd.stale&&<Button type="button" onClick={()=>{cmd.reset();revision.reload()}}>Atualizar seleção</Button>}
    <Button type="submit" disabled={cmd.busy||cmd.stale||!checked||revision.loading}>{cmd.uncertain?"Repetir confirmação":"Vincular séries"}</Button>
  </form>
}
type Event={id:string;status:string;warehouse:string;occurredAt:string;receiptId:string|null;productionId:string|null;transferId:string|null;
  warrantyId:string|null;orderId:string|null;posSaleId:string|null;countId:string|null}
const origins=[["receiptId","Recebimento","/compras/recebimentos/"],["productionId","Produção","/estoque/ordens-producao/"],
  ["transferId","Transferência","/estoque/transferencias?documento="],["warrantyId","Garantia","/vendas/garantias/"],
  ["orderId","Pedido","/vendas/pedidos/"],["posSaleId","PDV","/vendas/pdv/historico?venda="],["countId","Inventário","/estoque/inventarios/"]] as const
function Timeline({row,tenant}:{row:Row;tenant:string}){
  const [offset,setOffset]=useState(0)
  const history=useResource<{tenantId:string;data:Event[];hasMore:boolean}>(stockUrl(api+"/events",{productId:row.productId,serial:row.serial,offset}))
  const value=history.value?.tenantId===tenant?history.value:null
  return <section className="form-section space-y-2"><h2 className="font-semibold">Histórico • {row.serial}</h2>
    {history.loading?<p role="status">Consultando histórico…</p>:!value?<p role="alert">{history.error}</p>:<>
      <ul>{value.data.map(e=><li key={e.id}>{new Date(e.occurredAt).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"})} • {states[e.status]} • {e.warehouse}
        <div className="flex flex-wrap gap-2">{origins.map(([key,label,path])=>e[key]&&<Link key={key} className={textLink} href={path+e[key]}>{label}</Link>)}</div></li>)}</ul>
      {(offset>0||value.hasMore)&&<div><Button disabled={!offset} onClick={()=>setOffset(offset-25)}>Eventos anteriores na lista</Button>
        <Button disabled={!value.hasMore} onClick={()=>setOffset(offset+25)}>Mais eventos</Button></div>}</>}
  </section>
}
