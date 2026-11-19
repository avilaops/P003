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
import { historyPath, manualPath, stockUrl,textLink,type StockList } from "@/features/inventory/stock-model"
import { allStockRows,downloadStockCsv,type StockAnalysisResult } from "./stock-export"
import { StockAnalysisChart } from "./stock-analysis-chart"
import { changeAnalysisFilters, hasPeriod, reconcileDefinitionFilters, specificFilter, statusLabel, stockAnalysisQuery, tenantAnalysisParams } from "./stock-analysis-filters"

type Catalog={tenantId:string;sources:Record<string,{label:string}>;warehouses:{id:string;name:string}[]}
const selectStyle="min-h-9 min-w-0 max-w-full rounded-lg border bg-background px-3 text-sm"
const fieldStyle="grid min-w-0 gap-1 text-sm font-medium"

function formatted(key:string,value:string|number|null,dataset=""){
  if (key === "document" && value === null && dataset === "stock_movement_ledger") return "Sem documento vinculado"
  if(value===null)return key==="last_issue"?"Sem saída registrada":key==="positive_since"?"Sem data registrada":key==="warehouse"?"Consolidado":"A apurar"
  if(key==="date"||key==="last_issue"||key==="positive_since")return String(value).split("-").reverse().join("/")
  if(key==="status")return statusLabel(dataset,String(value))
  if(["quantity","reserved","available","cost","value","opening","closing","receipts","issues","demand","average","turnover","coverage","expected","counted","difference","accuracy","share","cumulative","progress"].includes(key))return String(value).replace(".",",")
  return String(value)
}

const documentRoutes:Record<string,string>={
  "Venda":"/vendas/pedidos/","Compras":"/compras/recebimentos/","Produção":"/estoque/ordens-producao/",
  "PDV":"/vendas/pdv/historico?venda=","Inventário":"/estoque/inventarios/","Transferência":"/estoque/transferencias?documento=","Garantia":"/vendas/garantias/",
}
function cell(row:StockAnalysisResult["data"][number],key:string,dataset:string){
  const value=row[key]??null
  const path=key==="document"&&typeof row.kind==="string"&&Object.hasOwn(documentRoutes,row.kind)?documentRoutes[row.kind]:null
  return path&&typeof value==="string"?<GuardedLink className={textLink} href={path+encodeURIComponent(value)}>{value}</GuardedLink>:formatted(key,value,dataset)
}

function AnalysisResults({tenant,report,query,selection,onOffsetChange}:{
  tenant:string;report:StockAnalysisResult;query:string;selection:string;onOffsetChange:(value:number)=>void
}){
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
      const exportQuery = new URLSearchParams(query)
      if (hasPeriod(report.dataset)) exportQuery.set("startDate", report.startDate)
      if (report.dataset !== "stock_position") exportQuery.set("endDate", report.endDate)
      const all=await allStockRows(exportQuery,tenant,request.signal)
      if(request.signal.aborted)return
      if (all.dataset !== report.dataset) throw new Error("A fonte do relatório mudou. Consulte a análise novamente.")
      if(pdf)setPrint(all);else downloadStockCsv(all)
    }catch(reason){if(!request.signal.aborted)setError(reason instanceof Error?reason.message:"Falha ao gerar o relatório")}
    finally{if(!request.signal.aborted)setBusy(false)}
  }
  return <>
    <section className="form-section min-w-0 space-y-4"><h2 className="text-lg font-semibold">{report.title}</h2>
      <p className="text-sm text-muted-foreground">{report.method}</p>
      {report.dataset==="stock_kardex"&&!report.product?<p>Selecione o produto para consultar o Kardex.</p>:<>
        <StockAnalysisChart report={report}/>
        <div className="flex flex-wrap items-center gap-2"><Button variant="outline" disabled={busy||!report.total} onClick={()=>loadAll(false)}>Exportar CSV completo</Button>
          <ReportActions open={!!print} disabled={busy||!report.total} onToggle={()=>loadAll(true)}/>{busy&&<span role="status">Preparando todos os registros…</span>}</div>
        {error&&<p role="alert">{error}</p>}
        {report.data.length?<div className="max-w-full overflow-x-auto"><DataTable aria-label={report.title} className="w-full text-left text-sm"><thead><tr>{report.columns.map(c=><th scope="col" className="whitespace-nowrap border-b p-2" key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>{report.data.map((r,i)=><tr key={i}>{report.columns.map(c=><td className="border-b p-2" key={c.key}>{cell(r,c.key,report.dataset)}</td>)}</tr>)}</tbody></DataTable></div>:<p>{report.total?"Nenhum registro nesta página.":"Nenhum registro para os filtros selecionados."}</p>}
        {(report.offset > 0 || report.total > report.limit) && <Pagination offset={report.offset} pageSize={report.limit} total={report.total} onOffsetChange={onOffsetChange}/>}
      </>}
    </section>
    {print&&<ReportDocument tenantId={tenant} title={print.title} scope={[`Registros incluídos • ${print.total}`,selection].filter(Boolean).join(" • ")} period={print.dataset==="stock_position"?"Posição atual":hasPeriod(print.dataset)?"Período • "+formatted("date",print.startDate)+" a "+formatted("date",print.endDate):"Data-base • "+formatted("date",print.endDate)}
      note={print.method} metrics={[["Registros",String(print.total)]]} columns={print.columns.map(c=>c.label)} rows={print.data.map(r=>print.columns.map(c=>formatted(c.key,r[c.key]??null,print.dataset)))}/>}
  </>
}

export function StockAnalysis({tenant, movementLedger = false}:{tenant:string; movementLedger?:boolean}){
  const rawParams = useSearchParams().toString()
  if (movementLedger) return <AnalysisWorkspace tenant={tenant} rawParams={rawParams} movementLedger/>
  const definition = tenantAnalysisParams(rawParams, tenant).get("definitionId")
  return definition
    ? <SavedStockAnalysis key={definition} tenant={tenant} rawParams={rawParams} definition={definition}/>
    : <AnalysisWorkspace tenant={tenant} rawParams={rawParams}/>
}

type WorkspaceProps = { tenant: string; rawParams: string }

function SavedStockAnalysis({tenant, rawParams, definition}: WorkspaceProps & {definition: string}) {
  const metadata = useResource<{tenantId: string; data: {id: string; dataset: string}[]}>("/api/erp/system/custom-reports")
  const saved = metadata.value?.tenantId === tenant ? metadata.value.data.find(item => item.id.toLowerCase() === definition.toLowerCase()) : null
  if (metadata.loading) return <p role="status">Consultando a definição do relatório…</p>
  if (!saved) return <div className="workspace-page-frame space-y-4">
    <PageHeader title="Análises de estoque" back={{href:"/relatorios/estoque", label:"Relatório de estoque"}}/>
    <div role="alert">{metadata.error || "Relatório personalizado indisponível nesta empresa."}</div>
    <Button variant="outline" onClick={metadata.reload}>Tentar novamente</Button>
    <GuardedLink className={textLink} href="/relatorios/estoque/analises">Consultar análises de estoque</GuardedLink>
  </div>
  return <AnalysisWorkspace tenant={tenant} rawParams={rawParams} savedDataset={saved.dataset} refreshDefinition={metadata.reload}/>
}

function AnalysisWorkspace({tenant, rawParams, savedDataset, refreshDefinition, movementLedger = false}: WorkspaceProps & {savedDataset?: string; refreshDefinition?: () => void; movementLedger?: boolean}){
  const params = useMemo(() => {
    const scoped = tenantAnalysisParams(rawParams, tenant)
    if (movementLedger) {
      scoped.delete("definitionId")
      scoped.set("dataset", "stock_movement_ledger")
    }
    return savedDataset ? reconcileDefinitionFilters(scoped, tenant, savedDataset) : scoped
  }, [rawParams, tenant, savedDataset, movementLedger])
  useEffect(() => {
    if (!movementLedger && params.toString() !== rawParams && new URLSearchParams(window.location.search).toString() === rawParams)
      window.history.replaceState(null, "", window.location.pathname + "?" + params + window.location.hash)
  }, [params, rawParams, movementLedger])
  const dataset = params.get("dataset") || "stock_position", definition = params.get("definitionId") || ""
  const productId = params.get("productId") || "", warehouse = params.get("warehouseId") || ""
  const requestedOffset = Number(params.get("offset")), offset = Number.isSafeInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0
  const [search,setSearch]=useState("")
  const catalog=useResource<Catalog>("/api/erp/stock/reports?catalog=true")
  const products=useResource<StockList>(stockUrl("/api/erp/stock",{q:search,limit:25}))
  const query = stockAnalysisQuery(params).toString()
  const resource=useResource<StockAnalysisResult>("/api/erp/stock/reports?"+query+"&offset="+offset)
  const report=resource.value?.tenantId===tenant?resource.value:null
  const options=catalog.value?.tenantId===tenant?catalog.value:null
  const items=products.value?.tenantId===tenant?products.value.data:[]
  const chosen=report?.product
  const changedDefinition = Boolean(savedDataset && report && savedDataset !== report.dataset)
  useEffect(() => {
    if (changedDefinition) refreshDefinition?.()
  }, [changedDefinition, refreshDefinition])
  const source=dataset
  const filter = specificFilter(source)
  const specificValue = filter && params.get(filter.key)
  const selection = [
    chosen && "Produto " + chosen.sku + " • " + chosen.name,
    warehouse && "Depósito " + (options?.warehouses.find(item => item.id === warehouse)?.name ?? warehouse),
    filter && specificValue && filter.label + " • " + (filter.options[specificValue] ?? specificValue),
    source === "stock_idle" && "Dias sem saída • " + (params.get("idleDays") || "90"),
  ].filter(Boolean).join(" • ")
  function update(changes: Record<string, string>, clear = false) {
    const latest = window.location.search
    const resolved = new URLSearchParams(latest).get("definitionId") === definition ? savedDataset : undefined
    const url = changeAnalysisFilters(latest, tenant, movementLedger ? {...changes, dataset: "stock_movement_ledger", definitionId: ""} : changes, clear, resolved)
    window.history.replaceState(null, "", window.location.pathname + "?" + url + window.location.hash)
  }
  const error = catalog.error || resource.error || (resource.value && !report ? "A análise retornou dados de outra empresa." : "")
  const context = {tenant, warehouseId: warehouse, productId, startDate: params.get("startDate"), endDate: params.get("endDate"), direction: params.get("movementDirection")}
  const returnQuery = stockAnalysisQuery(params)
  returnQuery.set("tenant", tenant)
  if (offset) returnQuery.set("offset", String(offset))
  const detailContext = {
    ...context, startDate: context.startDate || report?.startDate || null, endDate: context.endDate || report?.endDate || null,
    from: historyPath, returnQuery: returnQuery.toString(),
  }
  return <div data-report-workspace className="workspace-page-frame min-w-0 space-y-5">
    {movementLedger ? <PageHeader title="Lançamentos de estoque" actions={<>
      {!resource.loading && products.value?.tenantId === tenant && products.value.canEdit && <GuardedLink className={textLink} href={stockUrl(manualPath, detailContext)}>Novo lançamento</GuardedLink>}
      {!resource.loading && <GuardedLink className={textLink} href={stockUrl(historyPath, productId ? detailContext : {...detailContext, view:"products"})}>
        {productId ? "Consultar Kardex do produto" : "Selecionar produto para consultar o Kardex"}
      </GuardedLink>}
      {options?.sources.stock_movement_activity && <GuardedLink className={textLink} href={stockUrl("/relatorios/estoque/analises", {
        dataset:"stock_movement_activity", productId, warehouseId: warehouse, tenant: productId || warehouse ? tenant : null,
        startDate: context.startDate, endDate: context.endDate, movementDirection: context.direction,
      })}>Consultar atividade de movimentação</GuardedLink>}
    </>}/> : <PageHeader title="Análises de estoque" back={{href:"/relatorios/estoque",label:"Relatório de estoque"}}/>}
    <section aria-label="Filtros da análise" className="form-section grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {!movementLedger && <label className={fieldStyle}>Análise<select className={selectStyle} value={source} onChange={e=>update({definitionId:"",dataset:e.target.value})}>
        {Object.entries(options?.sources||{}).map(([id,s])=><option key={id} value={id}>{s.label}</option>)}</select></label>}
      <label className={fieldStyle}>Buscar produto ou SKU<Input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
      <label className={fieldStyle}>Produto<select className={selectStyle} value={productId} onChange={e=>update({productId:e.target.value})}>
        <option value="">{source==="stock_kardex"?"Selecione um produto":"Todos os produtos"}</option>
        {productId&&!items.some(p=>p.productId===productId)&&<option value={productId}>{chosen?chosen.sku+" • "+chosen.name:productId}</option>}
        {items.map(p=><option key={p.productId} value={p.productId}>{p.sku} • {p.name}</option>)}</select></label>
      {!!options?.warehouses.length&&<label className={fieldStyle}>Depósito<select className={selectStyle} value={warehouse} onChange={e=>update({warehouseId:e.target.value})}>
        <option value="">Todos os depósitos</option>{options.warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
      {hasPeriod(source)&&<label className={fieldStyle}>Data inicial<Input type="date" value={params.get("startDate")||report?.startDate||""} onChange={e=>update({startDate:e.target.value})}/></label>}
      {source!=="stock_position"&&<label className={fieldStyle}>Data final<Input type="date" value={params.get("endDate")||report?.endDate||""} onChange={e=>update({endDate:e.target.value})}/></label>}
      {source==="stock_idle"&&<label className={fieldStyle}>Dias sem saída<Input type="number" min={1} max={36500} value={params.get("idleDays")||"90"} onChange={e=>update({idleDays:e.target.value})}/></label>}
      {filter && <label className={fieldStyle}>{filter.label}<select className={selectStyle} value={params.get(filter.key) || ""} onChange={e=>update({[filter.key]:e.target.value})}>
        <option value="">{filter.all}</option>{Object.entries(filter.options).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>}
      <Button variant="outline" className="self-end justify-self-start" onClick={()=>{setSearch("");update({},true)}}>Limpar filtros</Button>
    </section>
    {products.error&&<p role="alert">{products.error}</p>}
    {error&&<div role="alert">{error} <Button variant="outline" onClick={()=>{catalog.reload();resource.reload();refreshDefinition?.()}}>Tentar novamente</Button></div>}
    {(resource.loading||changedDefinition)&&<p role="status">Consultando análise…</p>}
    {report&&!changedDefinition&&<AnalysisResults key={query} tenant={tenant} report={report} query={query} selection={selection}
      onOffsetChange={value=>update({offset:String(value)})}/>}
    {!movementLedger && <GuardedLink className={textLink} href="/preferencias/sistema/relatorios-customizados">Relatórios personalizados</GuardedLink>}
  </div>
}
