import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { validateDate } from "../sales/fixed.js"
import { projectedCosts } from "./valuation.js"
import { recalculateCosts } from "./cost-jobs.js"
import { adjustCostBasis, costBasisSchema, basisQuery,readReceiptBasis } from "./stock-cost-input.js"

const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
const closeInput=z.strictObject({month})
const reopenInput=closeInput.extend({reason:z.string().trim().min(3).max(500)})
const conflict=(message:string)=>new Problem(409,"domain_conflict",message)
async function periodState(ctx:AuthorizedContext){
  const periods=await ctx.client.query(`SELECT p.id,to_char(p.month,'YYYY-MM') AS month,p.closed_at AS "closedAt",p.closed_by AS "closedBy",
    p.reopened_at AS "reopenedAt",p.reason,(SELECT count(*)::int FROM stock_period_positions s WHERE s.tenant_id=p.tenant_id AND s.period_id=p.id) AS positions
    FROM stock_periods p WHERE p.tenant_id=$1 ORDER BY p.month DESC,p.closed_at DESC LIMIT 120`,[ctx.tenantId])
  const jobs=await ctx.client.query(`SELECT j.product_id AS "productId",p.sku,p.name,to_char(j.dirty_since,'YYYY-MM-DD') AS since,j.status,j.error_text AS error
    FROM stock_cost_jobs j JOIN products p ON (p.tenant_id,p.id)=(j.tenant_id,j.product_id) WHERE j.tenant_id=$1
    ORDER BY (j.status='failed') DESC,(j.status='pending') DESC,j.updated_at DESC,p.id LIMIT 50`,[ctx.tenantId])
  return {tenantId:ctx.tenantId,periods:periods.rows,jobs:jobs.rows,canClose:ctx.permissions.includes("inventory.periods.close"),
    canReopen:ctx.permissions.includes("inventory.periods.reopen"),canManage:ctx.permissions.includes("inventory.stock.manage")}
}
async function closePeriod(ctx:AuthorizedContext,month:string) {
  const {client,tenantId}=ctx
  const first=validateDate(month+"-01")
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('stock-period:'||$1::text,0))",[tenantId])
  const calendar=(await client.query<{last:string;previous:string|null; ended:boolean}>(`SELECT to_char($2::date+interval '1 month - 1 day','YYYY-MM-DD') AS last,
    to_char(max(month)+interval '1 month','YYYY-MM') AS previous,
    $2::date+interval '1 month' <= (now() AT TIME ZONE 'America/Sao_Paulo')::date AS ended
    FROM stock_periods WHERE tenant_id=$1 AND reopened_at IS NULL`,[tenantId,first])).rows[0]!
  if(!calendar.ended) throw conflict("O mês precisa ter terminado antes do fechamento")
  if(calendar.previous && calendar.previous!==month) throw conflict("Feche a próxima competência em sequência")
  const check=(await client.query<{counts:boolean;costs:boolean;receipts:boolean}>(`
    SELECT EXISTS(SELECT 1 FROM inventory_counts WHERE tenant_id=$1 AND status='open' AND created_at < (($2::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')) AS counts,
      EXISTS(SELECT 1 FROM stock_cost_jobs WHERE tenant_id=$1 AND dirty_since<=$2 AND status<>'done') AS costs,
      EXISTS(SELECT 1 FROM purchase_receipts r JOIN purchase_receipt_lines l ON (l.tenant_id,l.receipt_id)=(r.tenant_id,r.id)
        WHERE r.tenant_id=$1 AND r.occurred_on<=$2 AND NOT EXISTS(SELECT 1 FROM stock_movements m WHERE
          (m.tenant_id,m.source_purchase_receipt_id,m.product_id)=(r.tenant_id,r.id,l.product_id))) AS receipts`,[tenantId,calendar.last])).rows[0]!
  if(check.counts) throw conflict("Conclua ou cancele os inventários abertos no período")
  if(check.costs) throw conflict("Conclua o recálculo de custos pendente antes do fechamento")
  if(check.receipts) throw conflict("Há recebimentos com lançamento físico pendente no período")
  const id=randomUUID()
  await client.query("INSERT INTO stock_periods(tenant_id,id,month,closed_by) VALUES($1,$2,$3,$4)",[tenantId,id,first,ctx.authSubject])
  const products=await client.query<{product_id:string}>("SELECT product_id FROM stock_balances WHERE tenant_id=$1 UNION SELECT product_id FROM stock_cost_jobs WHERE tenant_id=$1",[tenantId])
  let count=0
  for(let i=0;i<products.rows.length;i+=100) {
    const {positions,movements}=await projectedCosts(ctx,products.rows.slice(i,i+100).map(r=>r.product_id),calendar.last)
    if([...movements.values()].some(m=>(!calendar.previous || m.date>=first) && m.amount===null))
      throw conflict("Há movimentos sem custo no período. Confira as entradas e o saldo de abertura")
    const rows=[]
    for(const p of positions.values()) {
      if(p.quantity<0n || p.value===null) throw conflict("Há saldo com custo pendente no período. Confira as entradas e o valor de abertura")
      rows.push({product_id:p.productId,warehouse_id:p.warehouseId,quantity:p.quantity.toString(),value:p.value.toString()})
    }
    if(rows.length) await client.query(`INSERT INTO stock_period_positions(tenant_id,period_id,product_id,warehouse_id,quantity_micros,value_micros)
      SELECT $1,$2,x.product_id,x.warehouse_id,x.quantity,x.value FROM jsonb_to_recordset($3::jsonb) AS x(product_id uuid,warehouse_id uuid,quantity numeric,value numeric)`,
      [tenantId,id,JSON.stringify(rows)])
    count+=rows.length
  }
  return {tenantId,id,month,positions:count}
}
async function reopenPeriod(ctx:AuthorizedContext,month:string,reason:string){
  const {client,tenantId}=ctx
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('stock-period:'||$1::text,0))",[tenantId])
  const result=await client.query<{id:string}>(`UPDATE stock_periods SET reopened_at=clock_timestamp(),reopened_by=$3,reason=$4
    WHERE tenant_id=$1 AND month=$2::date AND reopened_at IS NULL AND month=(
      SELECT max(month) FROM stock_periods WHERE tenant_id=$1 AND reopened_at IS NULL) RETURNING id`,[tenantId,validateDate(month+"-01"),ctx.authSubject,reason])
  if(!result.rows[0]) throw conflict("Reabra primeiro a última competência fechada")
  return {tenantId,id:result.rows[0].id,month,reason}
}
export function registerPeriods(app:FastifyInstance,deps:AccessDependencies){
  const path="/api/v1/stock/periods"
  app.get(path+"/basis",(req,reply)=>{
    reply.header("cache-control","no-store")
    return authorizeRequest(req,deps,ctx=>{
      requirePermission(ctx,"inventory.stock.manage")
      const parsed=basisQuery.safeParse(req.query)
      if(!parsed.success) throw new Problem(422,"invalid_input","Informe o movimento de entrada e o produto")
      return readReceiptBasis(ctx,parsed.data)
    })
  })
  app.get(path,(req,reply)=>{
    reply.header("cache-control","no-store")
    return authorizeRequest(req,deps,ctx=>{requirePermission(ctx,"inventory.stock.read");return periodState(ctx)})
  })
  for(const action of ["close","reopen","recalculate","basis"] as const){
    app.post(path+"/"+action,async(req,reply)=>{
      const result=await authorizeRequest(req,deps,async ctx=>{
        requirePermission(ctx,action==="close"?"inventory.periods.close":action==="reopen"?"inventory.periods.reopen":"inventory.stock.manage")
        const schema=action==="close"?closeInput:action==="reopen"?reopenInput:action==="basis"?costBasisSchema:z.strictObject({})
        const parsed=schema.safeParse(req.body)
        if(!parsed.success) throw new Problem(422,"invalid_input","Confira os dados informados para esta operação de estoque")
        const key=commandKey(req.headers["idempotency-key"]),scope="stock.period."+action
        const previous=await replay(ctx,key,scope,parsed.data)
        if(previous) return previous
        const outcome=action==="close"?await closePeriod(ctx,closeInput.parse(parsed.data).month):
          action==="reopen"?await reopenPeriod(ctx,reopenInput.parse(parsed.data).month,reopenInput.parse(parsed.data).reason):
          action==="basis"?await adjustCostBasis(ctx,costBasisSchema.parse(parsed.data)):await recalculateCosts(ctx,true)
        const event=action==="close"?"stock.period.closed":action==="reopen"?"stock.period.reopened":scope
        await record(ctx,req.headers,"stock_period","id" in outcome ? outcome.id : ctx.tenantId,event,outcome)
        await remember(ctx,key,scope,parsed.data,outcome)
        return outcome
      })
      return reply.header("cache-control","no-store").header("etag",'"'+req.headers["idempotency-key"]+'"').send(result)
    })
  }
}
