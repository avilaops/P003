import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import type { AuthorizedContext } from "../../platform/access.js"
import { canonicalJson } from "../../platform/json.js"
import { record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { channelCode, evaluate } from "../order-imports/service.js"

const token=/^Bearer (erp_([0-9a-f-]{36})_[a-f0-9]{64})$/i
const eventSchema=z.strictObject({eventId:z.string().trim().min(1).max(120),externalNumber:z.string().trim().min(1).max(120),kind:z.enum(["order","cancel","return"]),
 customer:z.string().max(22).optional(),due:z.iso.date().optional(),
 items:z.array(z.strictObject({reference:z.string().min(1).max(120),quantity:z.string().max(20),
 structureColor:z.string().max(120).optional(),swingArmColor:z.string().max(120).optional(),upholsteryColor:z.string().max(120).optional(),plateHolderType:z.string().max(120).optional()})).max(100).optional()})
const notAllowed=()=>new Problem(401,"invalid_service_key","Credencial de integração inválida ou canal inativo")
async function withConnector<T>(deps:AppDependencies,req:FastifyRequest,channel:string,operation:(ctx:AuthorizedContext)=>Promise<T>){
 const match=token.exec(req.headers.authorization||"")
 if(!match || !z.guid().safeParse(match[2]).success || !channelCode.safeParse(channel).success) throw notAllowed()
 const tenant=match[2]!.toLowerCase(),db=await deps.pool.connect()
 try{
  await db.query("BEGIN")
  await db.query("SELECT set_config('app.tenant_id',$1,true)",[tenant])
  const key=(await db.query(`SELECT k.id FROM service_api_keys k JOIN sales_connectors c ON (c.tenant_id,c.service_key_id)=(k.tenant_id,k.id)
    JOIN tenants t ON t.id=k.tenant_id AND t.status='active' WHERE k.tenant_id=$1 AND k.key_hash=$2 AND k.revoked_at IS NULL AND c.code=$3 AND c.enabled FOR UPDATE OF t,k,c`,[tenant,createHash("sha256").update(match[1]!).digest(),channel])).rows[0]
  if(!key) throw notAllowed()
  const subject="service:"+String(key.id)
  await db.query("SELECT set_config('app.auth_subject',$1,true)",[subject])
  await db.query("UPDATE service_api_keys SET last_used_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[tenant,key.id])
  const result=await operation({tenantId:tenant,authSubject:subject,client:db,permissions:[],identity:{subject,email:"",name:channel,emailVerified:false}})
  await db.query("COMMIT")
  return result
 }catch(error){await db.query("ROLLBACK");throw error}finally{db.release()}
}
const base="/api/v1/integrations/sales-channels/:channel"
export function channelServiceRoute(method: string, path: string) {
 return method === "GET" && path === base+"/deliveries" ||
   method === "POST" && (path === base+"/events" || path === base+"/deliveries/:id/confirmation")
}
export function registerChannelTransport(app:FastifyInstance,deps:AppDependencies){
 app.get<{Params:{channel:string}}>(base+"/deliveries",async(req,reply)=>{
  const data=await withConnector(deps,req,req.params.channel,async ctx=>(await ctx.client.query(`SELECT d.id,d.action,d.payload FROM sales_channel_deliveries d JOIN sales_channel_listings l ON (l.tenant_id,l.id)=(d.tenant_id,d.listing_id)
   WHERE d.tenant_id=$1 AND l.channel=$2 AND d.status='pending' ORDER BY d.created_at,d.id LIMIT 100`,[ctx.tenantId,req.params.channel])).rows)
  return reply.header("cache-control","no-store").send({data})
 })
 app.post<{Params:{channel:string;id:string}}>(base+"/deliveries/:id/confirmation",async(req,reply)=>{
  const result=await withConnector(deps,req,req.params.channel,async ctx=>{
   const decision=z.strictObject({status:z.enum(["confirmed","failed"]),reference:z.string().trim().min(1).max(300)}).safeParse(req.body)
  if(!decision.success||!z.guid().safeParse(req.params.id).success) throw new Problem(422,"invalid_input","Confirmação do conector inválida")
   const {client,tenantId}=ctx,id=req.params.id
   const row=(await client.query(`SELECT d.status,d.confirmation,d.listing_id,d.action FROM sales_channel_deliveries d JOIN sales_channel_listings l ON (l.tenant_id,l.id)=(d.tenant_id,d.listing_id)
    WHERE d.tenant_id=$1 AND l.channel=$2 AND d.id=$3`,[tenantId,req.params.channel,id])).rows[0]
   if(!row)throw new Problem(404,"not_found","Operação não encontrada neste canal")
   const {status,reference}=decision.data
   if(row.status!=="pending"){
    if(row.status===status && row.confirmation===reference) return {id,status}
    throw new Problem(409,"domain_conflict","Esta operação já recebeu outra confirmação")
   }
   await client.query("UPDATE sales_channel_deliveries SET status=$3,confirmation=$4,confirmed_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,id,status,reference])
   await client.query(`UPDATE sales_channel_listings SET revision=revision+1,status=CASE WHEN $3='confirmed' THEN CASE WHEN $4='pause' THEN 'paused' ELSE 'published' END ELSE status END WHERE tenant_id=$1 AND id=$2`,[tenantId,row.listing_id,status,row.action])
   await record(ctx,req.headers,"sales_channel_delivery",id,"channel.delivery."+status,{channel:req.params.channel,reference,service:ctx.authSubject})
   return {id,status}
  })
  return reply.header("cache-control","no-store").send(result)
 })
 app.post<{Params:{channel:string}}>(base+"/events",async(req,reply)=>{
  const channel=req.params.channel
  const result=await withConnector(deps,req,channel,async ctx=>{
   const parsed=eventSchema.safeParse(req.body)
  if(!parsed.success) throw new Problem(422,"invalid_input","Evento de canal inválido")
   const input=parsed.data
   const {tenantId,client}=ctx, digest=createHash("sha256").update(canonicalJson(input)).digest("hex")
   const old=(await client.query("SELECT digest,import_id,return_id FROM sales_channel_inbox WHERE tenant_id=$1 AND channel=$2 AND event_id=$3",[tenantId,channel,input.eventId])).rows[0]
   if(old && old.digest!==digest) throw new Problem(409,"domain_conflict","O evento já chegou com conteúdo diferente")
   let job=old?.import_id
   if(!old){
    if(input.kind==="order"){
     if(!input.items?.length||!input.customer||!input.due) throw new Problem(422,"invalid_input","Pedido exige cliente, vencimento e itens")
     const rows=[]
     for(const [idx,item] of input.items.entries()){
      const source=(await client.query(`SELECT p.sku FROM sales_channel_listings l JOIN products p ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id)
       WHERE l.tenant_id=$1 AND l.channel=$2 AND l.external_ref=$3 AND l.status='published' AND p.status='active'`,[tenantId,channel,item.reference])).rows[0]
      if(!source)throw new Problem(422,"invalid_input","Item sem anúncio publicado neste canal")
      const {reference:_,...fields}=item
      rows.push({...fields,sku:String(source.sku),line:idx+2,external:input.externalNumber,customer:input.customer,due:input.due})
     }
     job=randomUUID()
     const results=await evaluate(ctx,channel,rows)
     await client.query("INSERT INTO sales_order_imports(tenant_id,id,filename,channel,rows,results,status,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'previewed',$7)",[tenantId,job,"Canal "+input.externalNumber,channel,JSON.stringify(rows),JSON.stringify(results),ctx.authSubject])
    }
    await client.query("INSERT INTO sales_channel_inbox(tenant_id,channel,event_id,external_number,kind,digest,import_id) VALUES($1,$2,$3,$4,$5,$6,$7)",[tenantId,channel,input.eventId,input.externalNumber,input.kind,digest,job??null])
    await record(ctx,req.headers,"sales_connector",channel,"channel.event.received",{eventId:input.eventId,externalNumber:input.externalNumber,kind:input.kind})
   }
   const order=(await client.query("SELECT o.id,o.status FROM sales_channel_orders c JOIN sales_orders o ON (o.tenant_id,o.id)=(c.tenant_id,c.order_id) WHERE c.tenant_id=$1 AND c.channel=$2 AND c.external_number=$3",[tenantId,channel,input.externalNumber])).rows[0]
   const status=input.kind==="order"?(order?.status??"awaiting_import"):input.kind==="cancel"&&order?.status==="cancelled"||input.kind==="return"&&old?.return_id?"reconciled":"awaiting_reconciliation"
   return {eventId:input.eventId,importId:job??null,orderId:order?.id??null,orderStatus:order?.status??null,status,...(old?.return_id?{returnId:old.return_id}:{})}
  })
  return reply.header("cache-control","no-store").send(result)
 })
}
