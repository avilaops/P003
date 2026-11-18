import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest,requirePermission } from "../../platform/access.js"
import { commandKey,record,remember,replay } from "../../platform/commands.js"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { abcQuery,goalQuery,marginQuery,ordersQuery,reportTotals } from "./performance-query.js"

const root="/api/v1/commercial/policies"
const basis=z.enum(["accepted","invoiced"])
const filters=z.strictObject({from:z.iso.date(),to:z.iso.date(),seller:normalizedDatabaseId.optional(),channel:z.string().trim().min(1).max(80).optional(),basis:basis.default("invoiced")})
const goal=z.strictObject({sellerId:normalizedDatabaseId,month:z.string().regex(/^20\d{2}-(?:0[1-9]|1[0-2])$/),line:z.enum(["national","imported","catalog"]),basis,
 targetCents:z.number().int().positive().max(99999999999999),targetMicros:z.string().regex(/^[1-9][0-9]{0,17}$/),alertBps:z.number().int().min(0).max(10000),revision:z.number().int().nonnegative().safe()})
export function registerSalesPerformance(app:FastifyInstance,deps:AppDependencies){
 app.get(root+"/performance",async(req,reply)=>{
  const parsed=filters.safeParse(req.query)
  if(!parsed.success || parsed.data.to<parsed.data.from || (Date.parse(parsed.data.to)-Date.parse(parsed.data.from))/86400000>366) throw new Problem(422,"invalid_input","Informe um período de até 367 dias")
  const f=parsed.data
  const body=await authorizeRequest(req,deps,async ctx=>{
   requirePermission(ctx,"sales.orders.read")
   const {client,tenantId,permissions}=ctx
   const args=[tenantId,f.from,f.to,f.seller??null,f.channel??null]
   const marginAllowed=permissions.includes("platform.company.manage")&&permissions.includes("sales.approvals.director")
   const totals=(await client.query(reportTotals,args)).rows[0]!
   if(!permissions.includes("finance.receivables.read")) totals.receivedCents=null
   const abc=(await client.query(abcQuery,[...args,f.basis])).rows
   const goals=(await client.query(goalQuery,args)).rows
   const orders=(await client.query(ordersQuery,[...args,permissions.includes("finance.receivables.read")])).rows
   const margins=marginAllowed?(await client.query(marginQuery,args)).rows:null
   const sellers=(await client.query("SELECT id,name FROM staff WHERE tenant_id=$1 AND is_seller ORDER BY name,id",[tenantId])).rows
   const channels=(await client.query(`SELECT channel FROM sales_channel_prices WHERE tenant_id=$1 UNION SELECT channel FROM sales_channel_orders WHERE tenant_id=$1
   UNION SELECT public_snapshot#>>'{input,channel}' FROM commercial_order_quotes WHERE tenant_id=$1 AND public_snapshot#>>'{input,channel}' IS NOT NULL UNION SELECT 'Direto' ORDER BY 1`,[tenantId])).rows.map(r=>r.channel)
   return {tenantId,totals,abc,goals,orders,margins,sellers,channels,manage:permissions.includes("platform.company.manage")}
  })
  return reply.header("cache-control","no-store").send(body)
 })
 app.post(root+"/goals",async(req,reply)=>{
  const parsed=goal.safeParse(req.body)
  if(!parsed.success) throw new Problem(422,"invalid_input","Confira vendedor, competência, quantidade e valor da meta")
  const input=parsed.data
  const body=await authorizeRequest(req,deps,async ctx=>{
   requirePermission(ctx,"platform.company.manage");requirePermission(ctx,"sales.orders.read")
   const key=commandKey(req.headers["idempotency-key"]),scope="sales.target.saved"
   const saved=await replay(ctx,key,scope,input)
   if(saved) return saved
   const {tenantId,client}=ctx
   const eligible=(await client.query("SELECT id FROM staff WHERE tenant_id=$1 AND id=$2 AND is_seller AND status='active'",[tenantId,input.sellerId])).rows[0]
   if(!eligible) throw new Problem(422,"invalid_input","Selecione um vendedor ativo desta empresa")
   const result=(await client.query(`INSERT INTO sales_targets(tenant_id,seller_id,month,product_line,basis,amount_cents,quantity_micros,alert_bps)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE $9::bigint=0 OR EXISTS(SELECT 1 FROM sales_targets WHERE tenant_id=$1 AND seller_id=$2 AND month=$3 AND product_line=$4)
    ON CONFLICT(tenant_id,seller_id,month,product_line) DO UPDATE SET basis=$5,amount_cents=$6,quantity_micros=$7,alert_bps=$8,revision=sales_targets.revision+1
    WHERE sales_targets.revision=$9 RETURNING revision::int`,[tenantId,input.sellerId,input.month+"-01",input.line,input.basis,input.targetCents,input.targetMicros,input.alertBps,input.revision])).rows[0]
   if(!result) throw new Problem(412,"revision_conflict","A meta mudou. Atualize a consulta")
   const response={tenantId,revision:result.revision}
   await record(ctx,req.headers,"sales_target",input.sellerId,scope,{month:input.month,line:input.line,revision:result.revision})
   await remember(ctx,key,scope,input,response)
   return response
  })
  return reply.header("etag",'"'+String(body.revision)+'"').header("cache-control","no-store").send(body)
 })
}
