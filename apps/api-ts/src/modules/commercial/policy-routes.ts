import { registerSalesChannels } from "./channels.js"
import { registerSalesPerformance } from "./performance.js"
import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { commandKey,replay,remember,record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { normalizedDatabaseId as id } from "../../platform/database-id.js"
import { revisionValue } from "../../platform/revision.js"
import {loadTerm,paymentSchedule,termReference} from "./payment-term.js"
import { decideReview,decisionSchema,listReviews,reviewAuthority,reviewNotifications,type ReviewKind } from "./reviews.js"

const root = "/api/v1/commercial/policies"
const rev = z.number().int().nonnegative().safe()
const term = z.strictObject({kind:z.literal("term"),id:id.optional(),revision:rev,name:z.string().trim().min(1).max(120),entryBps:z.number().int().min(0).max(10000),days:z.array(z.number().int().min(0).max(3650)).max(120),methodId:id,active:z.boolean()})
const buyer = z.strictObject({kind:z.literal("customer"),id,revision:rev,creditLimitCents:z.number().int().min(0).max(99999999999999).nullable(),validUntil:z.iso.date().nullable(),blocked:z.boolean(),overdueDays:z.number().int().min(0).max(3650).nullable(),termId:id.nullable(),listId:id.nullable(),sellerId:id.nullable().default(null),region:z.string().trim().min(1).max(80).nullable().default(null)})
const channel = z.strictObject({kind:z.literal("channel"),channel:z.string().trim().min(1).max(80),listId:id,revision:rev})
const routing = z.strictObject({kind:z.literal("routing"),level:z.enum(["manager","director","credit"]),dueHours:z.number().int().min(1).max(2160),substituteId:id.nullable(),until:z.iso.date().nullable(),revision:rev})
const settings = z.discriminatedUnion("kind",[term,buyer,channel,routing])
const decisions = decisionSchema.extend({requests:z.array(z.strictObject({kind:z.enum(["order","proposal","credit"]),id,revision:rev.min(1)})).min(1).max(50)})
const invalid = (text:string):never=>{throw new Problem(422,"invalid_input",text)}
export function registerSalesPolicies(app:FastifyInstance,deps:AppDependencies){
 registerSalesPerformance(app,deps)
 registerSalesChannels(app,deps)
 app.post(root+"/plan",async(req,reply)=>{
  const input=z.strictObject({term:termReference,totalCents:z.number().int().positive().max(99999999999999)}).safeParse(req.body)
  if(!input.success) return invalid("Confira a condição e o valor do documento")
  const body=await authorizeRequest(req,deps,async ctx=>{
   if(!ctx.permissions.includes("sales.orders.read")) requirePermission(ctx,"sales.proposals.read")
   const term=await loadTerm(ctx,input.data.term)
   return {tenantId:ctx.tenantId,term,...paymentSchedule(BigInt(input.data.totalCents),term)}
  },false)
  return reply.header("etag",'"'+String(body.term.revision)+'"').header("cache-control","no-store").send(body)
 })
 app.get(root+"/queue",async(req,reply)=>{
  const body=await authorizeRequest(req,deps,async ctx=>({tenantId:ctx.tenantId,data:await listReviews(ctx),notifications:await reviewNotifications(ctx),canManage:ctx.permissions.includes("platform.company.manage")}))
  return reply.header("cache-control","no-store").send(body)
 })
 app.post(root+"/decisions",async(req,reply)=>{
  const parsed=decisions.safeParse(req.body)
  if(!parsed.success) return invalid("Confira os documentos e a justificativa da decisão")
  const input=parsed.data
  const body=await authorizeRequest(req,deps,async ctx=>{
   const key=commandKey(req.headers["idempotency-key"])
   const saved=await replay(ctx,key,"sales.review.batch",input)
   if(saved) {
     for(const item of saved.data as {kind:ReviewKind;level:string}[]) if (!await reviewAuthority(ctx,item.kind,item.level)) throw new Problem(403,"forbidden","Alçada da decisão indisponível")
     return saved
   }
   const results=[]
   for(const item of input.requests) results.push(await decideReview(ctx,req.headers,item.kind,item.id,item.revision,input))
   const result={tenantId:ctx.tenantId,data:results}
   await remember(ctx,key,"sales.review.batch",input,result)
   return result
  })
  return reply.header("etag",'"'+createHash("sha256").update(JSON.stringify(body.data)).digest("hex")+'"').header("cache-control","no-store").send(body)
 })
 app.get<{Params:{customer?:string}}>(root+"/catalog/:customer?",async(req,reply)=>{
  const customer=req.params.customer ? id.safeParse(req.params.customer) : null
  if(customer && !customer.success) return invalid("Cliente inválido")
  const body=await authorizeRequest(req,deps,async ctx=>{
   if (!ctx.permissions.includes("sales.orders.read")) requirePermission(ctx,"sales.proposals.read")
   const {client,tenantId}=ctx, manage=ctx.permissions.includes("platform.company.manage")
   const terms=await client.query("SELECT id,revision::int,name,entry_bps AS \"entryBps\",due_days AS days,method_id AS \"methodId\",active FROM sales_payment_terms WHERE tenant_id=$1 AND (active OR $2) ORDER BY name",[tenantId,manage])
   const policy=customer?(await client.query("SELECT revision::int,payment_term_id AS \"termId\",price_list_id AS \"listId\",credit_limit_cents::float8 AS \"creditLimitCents\",valid_until::text AS \"validUntil\",blocked,overdue_days AS \"overdueDays\",seller_staff_id AS \"sellerId\",(SELECT name FROM staff s WHERE s.tenant_id=c.tenant_id AND s.id=c.seller_staff_id) AS \"sellerName\",region FROM sales_customer_policies c WHERE tenant_id=$1 AND customer_id=$2",[tenantId,customer.data])).rows[0]:null
   const channels=(await client.query("SELECT channel,price_list_id AS \"listId\",revision::int FROM sales_channel_prices WHERE tenant_id=$1 ORDER BY channel",[tenantId])).rows
   const lists=manage?(await client.query("SELECT id,name FROM price_lists WHERE tenant_id=$1 AND status='active' ORDER BY name",[tenantId])).rows:[]
   const methods=(await client.query("SELECT id,name FROM payment_methods WHERE tenant_id=$1 AND status='active' ORDER BY name",[tenantId])).rows
   const routes=manage?(await client.query("SELECT level,revision::int,due_hours AS \"dueHours\",substitute_id AS \"substituteId\",substitute_until::text AS until FROM sales_approval_routing WHERE tenant_id=$1",[tenantId])).rows:[]
   const people=manage?(await client.query("SELECT i.id,i.display_name AS name FROM identities i JOIN tenant_memberships m ON m.identity_id=i.id WHERE m.tenant_id=$1 AND m.status='active' ORDER BY i.display_name",[tenantId])).rows:[]
   const sellers=manage?(await client.query("SELECT id,name FROM staff WHERE tenant_id=$1 AND is_seller AND status='active' ORDER BY name",[tenantId])).rows:[]
   return {tenantId,manage,terms:terms.rows,defaultTermId:policy?.termId??null,defaultSeller:policy?.sellerId?{id:policy.sellerId,name:policy.sellerName}:null,region:policy?.region??null,sellers,policy:manage?policy??null:null,channels:manage?channels:channels.map(c=>({channel:c.channel})),lists,methods,routes,people}
  })
  return reply.header("cache-control","no-store").send(body)
 })
 app.post(root+"/settings",async(req,reply)=>{
  const parsed=settings.safeParse(req.body)
  if(!parsed.success) return invalid("Confira os dados da política comercial")
  const input=parsed.data
  const body=await authorizeRequest(req,deps,async ctx=>{
   requirePermission(ctx,"platform.company.manage")
   const {tenantId,client}=ctx,key=commandKey(req.headers["idempotency-key"]),scope="sales.policies.save"
   const saved=await replay(ctx,key,scope,input)
   if(saved) return saved
   let result
   if(input.kind==="term"){
    if((input.entryBps===10000)!==(input.days.length===0)||input.days.some((day,i)=>i>0&&day<=input.days[i-1]!)) return invalid("Confira os vencimentos em dias crescentes e a entrada")
    const method=await client.query("SELECT id FROM payment_methods WHERE tenant_id=$1 AND id=$2 AND status='active'",[tenantId,input.methodId])
    if(!method.rows.length) return invalid("Escolha uma forma de pagamento ativa")
    const termId=input.id??randomUUID()
    result=await client.query(`INSERT INTO sales_payment_terms(tenant_id,id,name,entry_bps,due_days,method_id,active)
     SELECT $1,$2,$3,$4,$5,$6,$7 WHERE $8::bigint=0 OR EXISTS(SELECT 1 FROM sales_payment_terms WHERE tenant_id=$1 AND id=$2)
     ON CONFLICT(tenant_id,id) DO UPDATE SET name=$3,entry_bps=$4,due_days=$5,method_id=$6,active=$7,revision=sales_payment_terms.revision+1 WHERE sales_payment_terms.revision=$8 RETURNING id,revision`,[tenantId,termId,input.name,input.entryBps,input.days,input.methodId,input.active,input.revision])
   }else if(input.kind==="customer"){
    const person=await client.query("SELECT id FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer",[tenantId,input.id])
    if(!person.rows.length) return invalid("Selecione um cliente desta empresa")
    if(input.sellerId&&!(await client.query("SELECT id FROM staff WHERE tenant_id=$1 AND id=$2 AND is_seller AND status='active'",[tenantId,input.sellerId])).rows.length) return invalid("Escolha um vendedor ativo desta empresa")
    result=await client.query(`INSERT INTO sales_customer_policies(tenant_id,customer_id,credit_limit_cents,valid_until,blocked,overdue_days,payment_term_id,price_list_id,seller_staff_id,region)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$10,$11 WHERE $9::bigint=0 OR EXISTS(SELECT 1 FROM sales_customer_policies WHERE tenant_id=$1 AND customer_id=$2)
     ON CONFLICT(tenant_id,customer_id) DO UPDATE SET credit_limit_cents=$3,valid_until=$4,blocked=$5,overdue_days=$6,payment_term_id=$7,price_list_id=$8,seller_staff_id=$10,region=$11,revision=sales_customer_policies.revision+1 WHERE sales_customer_policies.revision=$9 RETURNING customer_id AS id,revision`,[tenantId,input.id,input.creditLimitCents,input.validUntil,input.blocked,input.overdueDays,input.termId,input.listId,input.revision,input.sellerId,input.region])
   }else if(input.kind==="channel"){
    result=await client.query(`INSERT INTO sales_channel_prices(tenant_id,channel,price_list_id) SELECT $1,$2,$3 WHERE $4::bigint=0 OR EXISTS(SELECT 1 FROM sales_channel_prices WHERE tenant_id=$1 AND channel=$2)
     ON CONFLICT(tenant_id,channel) DO UPDATE SET price_list_id=$3,revision=sales_channel_prices.revision+1 WHERE sales_channel_prices.revision=$4 RETURNING channel AS id,revision`,[tenantId,input.channel,input.listId,input.revision])
   }else{
    if(Boolean(input.substituteId)!==Boolean(input.until)) return invalid("Informe o substituto e a validade juntos")
    if(input.substituteId && !(await client.query("SELECT identity_id FROM tenant_memberships WHERE tenant_id=$1 AND identity_id=$2 AND status='active'",[tenantId,input.substituteId])).rows.length) return invalid("Substituto precisa pertencer à empresa")
    result=await client.query(`INSERT INTO sales_approval_routing(tenant_id,level,due_hours,substitute_id,substitute_until) SELECT $1,$2,$3,$4,$5 WHERE $6::bigint=0 OR EXISTS(SELECT 1 FROM sales_approval_routing WHERE tenant_id=$1 AND level=$2)
     ON CONFLICT(tenant_id,level) DO UPDATE SET due_hours=$3,substitute_id=$4,substitute_until=$5,revision=sales_approval_routing.revision+1 WHERE sales_approval_routing.revision=$6 RETURNING level AS id,revision`,[tenantId,input.level,input.dueHours,input.substituteId,input.until,input.revision])
   }
   const row=result.rows[0]
   if(!row) throw new Problem(412,"revision_conflict","Outra pessoa alterou a política. Atualize a consulta")
   const response={tenantId,id:row.id,revision:revisionValue(row.revision)}
   await record(ctx,req.headers,"sales_policy",String(row.id),scope,{kind:input.kind,revision:response.revision})
   await remember(ctx,key,scope,input,response)
   return response
  })
  return reply.header("etag",'"'+String(body.revision)+'"').header("cache-control","no-store").send(body)
 })
}
