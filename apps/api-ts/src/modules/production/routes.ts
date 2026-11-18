import type {FastifyInstance,FastifyRequest,FastifyReply} from "fastify"
import {z} from "zod"
import {type AccessDependencies,type AuthorizedContext,authorizeRequest,requirePermission} from "../../platform/access.js"
import {normalizedDatabaseId as id} from "../../platform/database-id.js"
import {commandKey,remember,replay} from "../../platform/commands.js"
import {parseRevision,revisionValue,nextRevision} from "../../platform/revision.js"
import {queryInteger} from "../registrations/query.js"
import {consume,consumeInput,postRun,postingInput,reason,reverseManual,reversePostings,type Job} from "./movements.js"
import {detail,history,invalid,listOrders,load,missing,stages,stale,stockPermission,structure,conflict,type Headers} from "./read.js"
import {createOrders,publish,saveStage} from "./setup.js"

const query=z.strictObject({orderId:id.optional(),offset:queryInteger(0,100000).default(0),limit:queryInteger(1,100).default(25)})
const change=z.discriminatedUnion("kind",[
  z.strictObject({kind:z.literal("Move"),body:z.strictObject({stageId:id})}),
  z.strictObject({kind:z.literal("Consume"),body:consumeInput}),
  z.strictObject({kind:z.literal("Reverse"),movement:id,body:z.strictObject({reason})}),
  z.strictObject({kind:z.literal("Post"),body:postingInput}),
])
function param(input:unknown){const parsed=id.safeParse(input);if(!parsed.success)throw missing();return parsed.data}
async function mutate(ctx:AuthorizedContext,headers:Headers,jobId:string,raw:unknown){
  const parsed=change.safeParse(raw)
  if(!parsed.success)throw invalid("Confira produtos, quantidades, custo e motivo")
  const action=parsed.data,revision=parseRevision(headers["if-match"]),key=commandKey(headers["idempotency-key"])
  const scope=action.kind==="Post"?"production.post":"production.change"
  if(action.kind!=="Move")stockPermission(ctx)
  const input={id:jobId,revision,action:{[action.kind]:action.kind==="Reverse"?[action.movement,action.body]:action.body}}
  const previous=await replay(ctx,key,scope,input)
  if(previous){if(Array.isArray(previous.stockMovementIds)&&previous.stockMovementIds.length)stockPermission(ctx);return previous}
  const job=(await ctx.client.query<Job & {sale_status:string}>(`SELECT o.*,s.status AS sale_status FROM production_orders o JOIN sales_orders s
    ON (s.tenant_id,s.id)=(o.tenant_id,o.order_id) WHERE o.tenant_id=$1 AND o.id=$2 FOR UPDATE OF o`,[ctx.tenantId,jobId])).rows[0]
  if(!job)throw missing()
  if(revisionValue(job.revision)!==revision)throw stale()
  if(job.status==="cancelled"||!["accepted","confirmed","completed"].includes(job.sale_status))throw conflict("A ordem ou seu pedido de origem está encerrado para movimentação")
  const next=nextRevision(revision)
  let event:string,ids:string[]=[],details:object
  switch(action.kind){
    case "Move":{
      const target=(await ctx.client.query("SELECT kind FROM production_stages WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,action.body.stageId])).rows[0]
      if(!target)throw missing()
      if(action.body.stageId===job.stage_id)throw conflict("Ordem já está nesta etapa")
      const status=target.kind==="pronta"?"ready":"open"
      if(status==="ready"&&job.bom_version)throw conflict("Conclua o apontamento das quantidades para encerrar esta ordem")
      if(status==="ready"&&(await ctx.client.query("SELECT 1 FROM production_postings WHERE tenant_id=$1 AND production_order_id=$2 LIMIT 1",[ctx.tenantId,jobId])).rows.length)throw conflict("Conclua as quantidades que faltam por apontamento")
      if(job.status==="ready"&&status==="open"){
        ids=await reversePostings(ctx,headers,jobId,"Reabertura da ordem de produção")
        ids.push(...await reverseManual(ctx,headers,jobId,"Reabertura da ordem de produção"))
      }
      await ctx.client.query(`UPDATE production_orders SET stage_id=$3,status=$4,finished_at=CASE WHEN $4='ready' THEN coalesce(finished_at,clock_timestamp()) END
        WHERE tenant_id=$1 AND id=$2`,[ctx.tenantId,jobId,action.body.stageId,status])
      event="production.stage_changed";details={previousStageId:job.stage_id,stageId:action.body.stageId,previousStatus:job.status,status,stockMovementIds:ids}
      break
    }
    case "Consume":ids=await consume(ctx,headers,job,action.body);event="production.consumed";details={...action.body,stockMovementId:ids[0]};break
    case "Reverse":ids=await reverseManual(ctx,headers,jobId,action.body.reason,action.movement);event="production.consumption_reversed";details={reversesId:action.movement,reason:action.body.reason,stockMovementIds:ids};break
    case "Post":{const run=await postRun(ctx,headers,job,action.body);ids=run.ids;event="production.posted";details=run.details;break}
  }
  await ctx.client.query("UPDATE production_orders SET revision=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,jobId,next])
  await history(ctx,headers,jobId,event,{...details,revision:next})
  const result={tenantId:ctx.tenantId,data:await load(ctx,jobId),stockMovementIds:ids}
  await remember(ctx,key,scope,input,result)
  return result
}

export function registerProduction(app:FastifyInstance,deps:AccessDependencies){
  const base="/api/v1/production"
  async function handle(req:FastifyRequest,reply:FastifyReply,fn:(ctx:AuthorizedContext)=>Promise<Record<string,unknown>>,code=200){
    const result=await authorizeRequest(req,deps,ctx=>{
      requirePermission(ctx,"production.read");if(req.method!=="GET")requirePermission(ctx,"production.manage")
      return fn(ctx)
    })
    const data=result.data
    if(data&&typeof data==="object"&&"revision" in data)reply.header("etag",'"'+String(data.revision)+'"')
    else if("version" in result)reply.header("etag",'"'+String(result.version)+'"')
    return reply.code(code).header("cache-control","no-store").send(result)
  }
  app.get(base+"/orders",(r,p)=>handle(r,p,ctx=>{const f=query.safeParse(r.query);if(!f.success)throw invalid("Filtros de produção inválidos");return listOrders(ctx,f.data)}))
  app.get<{Params:{id:string}}>(base+"/orders/:id",(r,p)=>handle(r,p,ctx=>detail(ctx,param(r.params.id))))
  app.get(base+"/stages",(r,p)=>handle(r,p,stages))
  app.post(base+"/orders",(r,p)=>handle(r,p,ctx=>createOrders(ctx,r.headers,r.body),201))
  app.post(base+"/stages",(r,p)=>handle(r,p,ctx=>saveStage(ctx,r.headers,null,r.body),201))
  app.put<{Params:{id:string}}>(base+"/stages/:id",(r,p)=>handle(r,p,ctx=>saveStage(ctx,r.headers,param(r.params.id),r.body)))
  app.get<{Params:{id:string}}>(base+"/structures/:id",(r,p)=>handle(r,p,ctx=>structure(ctx,param(r.params.id))))
  app.post<{Params:{id:string}}>(base+"/structures/:id",(r,p)=>handle(r,p,ctx=>publish(ctx,r.headers,param(r.params.id),r.body),201))
  for(const [path,kind] of [["stage","Move"],["consumptions","Consume"],["postings","Post"]] as const)
    app.post<{Params:{id:string}}>(base+"/orders/:id/"+path,(r,p)=>handle(r,p,ctx=>mutate(ctx,r.headers,param(r.params.id),{kind,body:r.body})))
  app.post<{Params:{id:string;movement:string}}>(base+"/orders/:id/consumptions/:movement/reverse",(r,p)=>handle(r,p,ctx=>mutate(ctx,r.headers,param(r.params.id),{kind:"Reverse",movement:r.params.movement,body:r.body})))
}
