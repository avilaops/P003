import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { requirePermission } from "../../platform/access.js"
import { normalizedDatabaseId as databaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { validateDate } from "../sales/fixed.js"
import { queryInteger } from "../registrations/query.js"
import { stockCatalog, stockPermission, stockSource, visibleStockCatalog } from "./stock-catalog.js"
import { dayBefore, stockMetrics, type Product } from "./stock-metrics.js"
import { operationalDataset, operationalReport } from "./stock-operations.js"

const querySchema=z.strictObject({dataset:z.string().optional(),definitionId:databaseId.optional(),productId:databaseId.optional(),warehouseId:databaseId.optional(),
  startDate:z.string().optional(),endDate:z.string().optional(),idleDays:queryInteger(1,36500).default(90),
  movementDirection:z.enum(["receipt","issue"]).optional(),countStatus:z.enum(["open","approved","cancelled"]).optional(),
  productionStatus:z.enum(["open","ready","cancelled"]).optional(),
  limit:queryInteger(1,100).default(25),offset:queryInteger(0,Number.MAX_SAFE_INTEGER).default(0),all:z.enum(["true"]).optional(),catalog:z.enum(["true"]).optional()})
const missing=()=>new Problem(404,"not_found","Registro não encontrado nesta empresa")
const numeric=new Set(["quantity","reserved","available","cost","value","opening","closing","receipts","issues","demand","average","turnover","coverage","expected","counted","difference","accuracy","share","cumulative","idle_days","lines","matched",
  "receipt_count","issue_count","movements","counted_lines","pending_lines","progress","orders"])
function matches(column:string,value:string|number|null|undefined,filter:unknown){
  if(value==null)return false
  if(!numeric.has(column))return String(value)===String(filter)
  const normalize=(input:unknown)=>{
    const match=/^([+-]?)(\d+)(?:[.,](\d+))?$/.exec(String(input).trim())
    if(!match)return null
    const units=BigInt(match[2]!),digits=(match[3]??"").replace(/0+$/,"")
    return (match[1]==="-" && (units>0n||digits)?"-":"")+units+(digits?"."+digits:"")
  }
  return normalize(value)===normalize(filter)
}
export async function runStockReport(ctx:AuthorizedContext,raw:unknown){
  requirePermission(ctx,"inventory.stock.read")
  const parsed=querySchema.safeParse(raw)
  if(!parsed.success)throw new Problem(422,"invalid_input","Parâmetros da análise inválidos")
  const q=parsed.data
  const warehouseSql=`SELECT w.id,w.name,w.code FROM warehouses w
    JOIN stock_location_settings s ON s.tenant_id=w.tenant_id WHERE w.tenant_id=$1 AND s.enabled`
  if(q.catalog){
    const {rows:warehouses}=await ctx.client.query(warehouseSql+" ORDER BY w.name,w.id",[ctx.tenantId])
    return {tenantId:ctx.tenantId,sources:visibleStockCatalog(ctx.permissions),warehouses}
  }
  let key=q.dataset??"stock_position",columns:string[]|undefined,filters:Record<string,unknown>={},title:string|undefined
  if(q.definitionId){
    requirePermission(ctx,"system.reports.read")
    const {rows:[saved]}=await ctx.client.query<{dataset:string;columns:string[];filters:Record<string,unknown>;name:string}>(
      "SELECT dataset,columns,filters,name FROM system_config.report_definitions WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,q.definitionId])
    if(!saved)throw missing()
    key=saved.dataset;columns=saved.columns;filters=saved.filters;title=saved.name
  }
  if(!stockSource(key))throw new Problem(422,"invalid_input","Fonte de estoque inválida")
  requirePermission(ctx,stockPermission(key))
  if(q.warehouseId&&!(await ctx.client.query(warehouseSql+" AND w.id=$2",[ctx.tenantId,q.warehouseId])).rows.length)throw missing()
  if((q.movementDirection && key!=="stock_movement_activity" && key!=="stock_movement_ledger") || (q.countStatus && key!=="stock_count_progress") ||
    (q.productionStatus && key!=="stock_production_progress"))
    throw new Problem(422,"invalid_input","Filtro incompatível com a fonte de estoque")
  const source=stockCatalog[key]
  const {rows:[clock]}=await ctx.client.query<{today:string}>("SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text today")
  const end=q.endDate?validateDate(q.endDate):clock!.today
  const start=q.startDate?validateDate(q.startDate):key==="stock_kardex"?"1900-01-01":dayBefore(end,29)
  if(start>end)throw new Problem(422,"invalid_input","O início do período deve anteceder o fim")
  if(key==="stock_position"&&(q.startDate||q.endDate))throw new Problem(422,"invalid_input","A posição valorizada mostra as reservas e os saldos atuais")
  const columnFilters=Object.entries(filters)
  const needsCatalog=!operationalDataset(key)&&key!=="stock_accuracy"&&key!=="stock_divergences"&&key!=="stock_kardex"
  const sqlPage=!q.all && !columnFilters.length?{limit:q.limit,offset:q.offset}:undefined
  const pageCatalog=key==="stock_position" && sqlPage && !q.productId
  const totalProducts=pageCatalog?Number((await ctx.client.query<{total:string}>("SELECT count(*) total FROM products WHERE tenant_id=$1",[ctx.tenantId])).rows[0]!.total):null
  const products=needsCatalog||q.productId?(await ctx.client.query<Product>(`SELECT id,sku,name,unit,status FROM products WHERE tenant_id=$1
    AND ($2::uuid IS NULL OR id=$2) ORDER BY sku,id LIMIT $3 OFFSET $4`,
    [ctx.tenantId,key==="stock_abc"?undefined:q.productId,pageCatalog?q.limit:null,pageCatalog?q.offset:0])).rows:[]
  const selected=products.find(p=>p.id===q.productId)
  if(q.productId&&!selected)throw missing()
  const selectedColumns=columns??Object.keys(source.columns)
  const scope={...q,start,end}
  const operations=operationalDataset(key)?await operationalReport(ctx,key,scope,sqlPage):undefined
  const result=operations?.rows??await stockMetrics(ctx,key,products,scope)
  const rows=result.filter(row=>(key!=="stock_abc"||!selected||row.sku===selected.sku) &&
    columnFilters.every(([k,v])=>matches(k,row[k],v)))
  const pagedTotal=totalProducts??(sqlPage?operations?.total:undefined)
  const page=q.all||pagedTotal!==undefined?rows:rows.slice(q.offset,q.offset+q.limit)
  return {tenantId:ctx.tenantId,dataset:key,title:title??source.label,method:source.method,columns:selectedColumns.map(key=>({key,label:source.columns[key]})),
    data:page.map(row=>Object.fromEntries(selectedColumns.map(key=>[key,row[key]??null]))),total:pagedTotal??rows.length,offset:q.all?0:q.offset,limit:q.limit,
    startDate:start,endDate:end,product:selected??null}
}
