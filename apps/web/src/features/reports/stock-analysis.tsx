"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Pagination } from "@/components/workspace/pagination"
import { DataTable } from "@/components/workspace/data-table"
import { GuardedLink } from "@/components/shell/navigation-guard"
import { ReportActions,ReportDocument } from "@/components/documents/report-document"
import { useResource } from "@/hooks/use-operation"
import { stockUrl,textLink,type StockList } from "@/features/inventory/stock-model"
import { allStockRows,downloadStockCsv,type StockAnalysisResult } from "./stock-export"

type Catalog={tenantId:string;sources:Record<string,{label:string}>;warehouses:{id:string;name:string}[]}
const selectStyle="min-h-11 min-w-0 max-w-full rounded-lg border bg-background px-3 text-sm"
const fieldStyle="grid min-w-0 gap-1 text-sm font-medium"
const hasPeriod=(source:string)=>["stock_turnover","stock_kardex","stock_divergences","stock_accuracy"].includes(source)

function formatted(key:string,value:string|number|null){
  if(value===null)return key==="last_issue"?"Sem saída registrada":key==="positive_since"?"Sem data registrada":key==="warehouse"?"Consolidado":"A apurar"
  if(key==="date"||key==="last_issue"||key==="positive_since")return String(value).split("-").reverse().join("/")
  if(["quantity","reserved","available","cost","value","opening","closing","receipts","issues","demand","average","turnover","coverage","expected","counted","difference","accuracy","share","cumulative"].includes(key))return String(value).replace(".",",")
  return String(value)
}

const documentRoutes:Record<string,string>={
  "Venda":"/vendas/pedidos/","Compras":"/compras/recebimentos/","Produção":"/estoque/ordens-producao/",
  "PDV":"/vendas/pdv/historico?venda=","Inventário":"/estoque/inventarios/","Transferência":"/estoque/transferencias?documento=","Garantia":"/vendas/garantias/",
}
function cell(row:StockAnalysisResult["data"][number],key:string){
  const value=row[key]??null
  const path=key==="document"&&typeof row.kind==="string"?documentRoutes[row.kind]:null
  return path&&typeof value==="string"?<GuardedLink className={textLink} href={path+encodeURIComponent(value)}>{value}</GuardedLink>:formatted(key,value)
}

function ReportOutput({tenant,report,query}:{tenant:string;report:StockAnalysisResult;query:string}){
  const [print,setPrint]=useState<StockAnalysisResult|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("")
  const controller=useRef<AbortController|null>(null)
  useEffect(()=>()=>controller.current?.abort(),[])
  async function loadAll(pdf:boolean){
    if(pdf&&print){setPrint(null);return}
    if(busy)return
    const request=new AbortController()
    controller.current=request
    setBusy(true);setError("")
    try{
      const all=await allStockRows(new URLSearchParams(query),tenant,request.signal)
      if(request.signal.aborted)return
      if(pdf)setPrint(all);else downloadStockCsv(all)
    }catch(reason){if(!request.signal.aborted)setError(reason instanceof Error?reason.message:"Falha ao gerar o relatório")}
    finally{if(!request.signal.aborted)setBusy(false)}
  }
  return <>
    <div className="flex flex-wrap items-center gap-2"><Button variant="outline" disabled={busy||!report.total} onClick={()=>loadAll(false)}>Exportar CSV completo</Button>
      <ReportActions open={!!print} disabled={busy||!report.total} onToggle={()=>loadAll(true)}/>{busy&&<span role="status">Preparando todos os registros…</span>}</div>
    {error&&<p role="alert">{error}</p>}
    {print&&<ReportDocument tenantId={tenant} title={print.title} scope={"Todos os "+print.total+" registros do filtro."} period={print.dataset==="stock_position"?"Posição atual":hasPeriod(print.dataset)?"Período • "+formatted("date",print.startDate)+" a "+formatted("date",print.endDate):"Data-base • "+formatted("date",print.endDate)}
      note={print.method} metrics={[["Registros",String(print.total)]]} columns={print.columns.map(c=>c.label)} rows={print.data.map(r=>print.columns.map(c=>formatted(c.key,r[c.key]??null)))}/>}
  </>
}

export function StockAnalysis({tenant}:{tenant:string}){
  const params=useSearchParams()
  const [dataset,setDataset]=useState(params.get("dataset")||"stock_position")
  const [definition,setDefinition]=useState(params.get("definitionId")||"")
  const [productId,setProduct]=useState(params.get("productId")||""),[warehouse,setWarehouse]=useState(params.get("warehouseId")||"")
  const [search,setSearch]=useState(""),[start,setStart]=useState(params.get("startDate")||""),[end,setEnd]=useState(params.get("endDate")||"")
  const [days,setDays]=useState("90"),[offset,setOffset]=useState(0)
  const catalog=useResource<Catalog>("/api/erp/stock/reports?catalog=true")
  const products=useResource<StockList>(stockUrl("/api/erp/stock",{q:search,limit:25}))
  const query=useMemo(()=>{
    const q=new URLSearchParams(definition?{definitionId:definition}:{dataset})
    if(productId)q.set("productId",productId)
    if(warehouse)q.set("warehouseId",warehouse)
    if(hasPeriod(dataset)&&start)q.set("startDate",start)
    if(dataset!=="stock_position"&&end)q.set("endDate",end)
    if(dataset==="stock_idle"&&days)q.set("idleDays",days)
    return q.toString()
  },[dataset,definition,productId,warehouse,start,end,days])
  const resource=useResource<StockAnalysisResult>("/api/erp/stock/reports?"+query+"&offset="+offset)
  const report=resource.value?.tenantId===tenant?resource.value:null
  const options=catalog.value?.tenantId===tenant?catalog.value:null
  const items=products.value?.tenantId===tenant?products.value.data:[]
  const chosen=report?.product
  const source=definition?(report?.dataset||dataset):dataset
  function change(update:()=>void){setOffset(0);update()}
  return <div data-report-workspace className="workspace-page-frame min-w-0 space-y-5">
    <PageHeader title="Análises de estoque" back={{href:"/relatorios/estoque",label:"Relatório de estoque"}}/>
    <section aria-label="Filtros da análise" className="form-section grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <label className={fieldStyle}>Análise<select className={selectStyle} value={source} onChange={e=>change(()=>{setDefinition("");setDataset(e.target.value)})}>
        {Object.entries(options?.sources||{}).map(([id,s])=><option key={id} value={id}>{s.label}</option>)}</select></label>
      <label className={fieldStyle}>Buscar produto ou SKU<Input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
      <label className={fieldStyle}>Produto<select className={selectStyle} value={productId} onChange={e=>change(()=>setProduct(e.target.value))}>
        <option value="">{source==="stock_kardex"?"Selecione um produto":"Todos os produtos"}</option>
        {productId&&!items.some(p=>p.productId===productId)&&<option value={productId}>{chosen?chosen.sku+" • "+chosen.name:productId}</option>}
        {items.map(p=><option key={p.productId} value={p.productId}>{p.sku} • {p.name}</option>)}</select></label>
      {!!options?.warehouses.length&&<label className={fieldStyle}>Depósito<select className={selectStyle} value={warehouse} onChange={e=>change(()=>setWarehouse(e.target.value))}>
        <option value="">Todos os depósitos</option>{options.warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
      {hasPeriod(source)&&<label className={fieldStyle}>Data inicial<Input type="date" value={start||report?.startDate||""} onChange={e=>change(()=>{setDataset(source);setStart(e.target.value)})}/></label>}
      {source!=="stock_position"&&<label className={fieldStyle}>Data final<Input type="date" value={end||report?.endDate||""} onChange={e=>change(()=>{setDataset(source);setEnd(e.target.value)})}/></label>}
      {source==="stock_idle"&&<label className={fieldStyle}>Dias sem saída<Input type="number" min={1} max={36500} value={days} onChange={e=>change(()=>{setDataset(source);setDays(e.target.value)})}/></label>}
    </section>
    {products.error&&<p role="alert">{products.error}</p>}
    {(catalog.error||resource.error)&&<div role="alert">{catalog.error||resource.error} <Button variant="outline" onClick={()=>{catalog.reload();resource.reload()}}>Tentar novamente</Button></div>}
    {resource.loading&&<p role="status">Consultando análise…</p>}
    {report&&<section className="form-section min-w-0 space-y-4"><h2 className="text-lg font-semibold">{report.title}</h2>
      <p className="text-sm text-muted-foreground">{report.method}</p>
      {report.dataset==="stock_kardex"&&!productId?<p>Selecione o produto para consultar o Kardex.</p>:<>
        <ReportOutput key={query} tenant={tenant} report={report} query={query}/>
        {report.total?<div className="max-w-full overflow-x-auto"><DataTable aria-label={report.title} className="w-full text-left text-sm"><thead><tr>{report.columns.map(c=><th scope="col" className="whitespace-nowrap border-b p-2" key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>{report.data.map((r,i)=><tr key={i}>{report.columns.map(c=><td className="border-b p-2" key={c.key}>{cell(r,c.key)}</td>)}</tr>)}</tbody></DataTable></div>:<p>Nenhum registro para os filtros selecionados.</p>}
        <Pagination offset={offset} pageSize={report.limit} total={report.total} onOffsetChange={setOffset}/>
      </>}
    </section>}
    <GuardedLink className={textLink} href="/preferencias/sistema/relatorios-customizados">Relatórios personalizados</GuardedLink>
  </div>
}
