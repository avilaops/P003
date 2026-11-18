import { erpFetch } from "@/lib/api/client"
import { downloadCsv } from "@/lib/csv-export"
import { statusLabel } from "./stock-analysis-filters"

export type StockAnalysisResult={
  tenantId:string; dataset:string; title:string; method:string; columns:{key:string;label:string}[]; data:Record<string,string|number|null>[]
  total:number;limit:number;offset:number;startDate:string;endDate:string;product:{id:string;name:string;sku:string;unit:string}|null
}
const textKeys=new Set(["sku","product","unit","status","document","reason","warehouse","kind","reference","history","class","stage"])
export function exportCell(key:string,value:string|number|null){
  if(value===null){
    if(key==="last_issue")return "Sem saída registrada"
    if(key==="positive_since")return "Sem data registrada"
    return ["value","cost","share","cumulative","class","turnover","coverage","accuracy","idle_days","progress"].includes(key)?"A apurar":""
  }
  const s=String(value)
  if(textKeys.has(key)&&/^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(s))return "'"+s
  return s
}
export async function allStockRows(query:URLSearchParams,tenant:string,signal?:AbortSignal){
  const params=new URLSearchParams(query)
  params.delete("offset");params.delete("limit");params.set("all","true")
  const response=await erpFetch("/api/erp/stock/reports?"+params,{signal})
  const body=await response.json()
  if(!response.ok)throw new Error(body.title||"Não foi possível exportar a análise")
  if(body.tenantId!==tenant||!Array.isArray(body.data)||body.data.length!==body.total)throw new Error("A empresa ou o número de registros mudou. Consulte a análise novamente.")
  return body as StockAnalysisResult
}
export function downloadStockCsv(report:StockAnalysisResult,columns=report.columns,filename=report.dataset+".csv"){
  downloadCsv(filename,[columns.map(c=>c.label),...report.data.map(row=>columns.map(c=>{
    const value=row[c.key]??null
    return exportCell(c.key,c.key==="status" && report.dataset!=="stock_position" && typeof value==="string"?statusLabel(report.dataset,value):value)
  }))])
}
