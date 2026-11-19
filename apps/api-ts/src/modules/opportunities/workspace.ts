import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { pipeline, stageSchema, validateOwner } from "./pipeline.js"

const path="/api/v1/opportunities/settings"
export function registerPipelineWorkspace(app:FastifyInstance,deps:AppDependencies) {
  app.get(path,async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,"sales.orders.read")
      return {tenantId:c.tenantId,canEdit:c.permissions.includes("platform.company.manage"),data:await pipeline(c)}
    })
    return reply.header("etag",`"${result.data.revision}"`).header("cache-control","no-store").send(result)
  })
  app.put(path,async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,"platform.company.manage")
      const parsed=z.strictObject({stages:z.array(stageSchema).min(6).max(30)}).safeParse(req.body)
      if(!parsed.success) throw new Problem(422,"invalid_input","Informe etapas com código permanente e nome")
      const expected=parseRevision(req.headers["if-match"]), key=commandKey(req.headers["idempotency-key"])
      const input={...parsed.data,revision:expected},scope="opportunity.stages_configured"
      const saved=await replay(c,key,scope,input)
      if(saved) return saved
      const current=await pipeline(c), stages=input.stages
      if(expected!==current.revision) throw new Problem(412,"revision_conflict","As etapas mudaram. Atualize o quadro")
      const codes=new Set(stages.map(s=>s.code))
      if(codes.size!==stages.length || new Set(stages.map(s=>s.label.toLocaleLowerCase("pt-BR"))).size!==stages.length
        || current.stages.some(s=>!codes.has(s.code)) || stages.some(s=>!s.active && ["new","proposed","won","lost"].includes(s.code))) {
        throw new Problem(422,"invalid_input","Preserve os códigos históricos e as etapas Novo, Proposta, Ganho e Perdido. Use nomes únicos")
      }
      const revision=nextRevision(expected)
      await c.client.query("INSERT INTO sales_pipeline_settings(tenant_id,stages,revision) VALUES($1,$2::jsonb,$3) ON CONFLICT(tenant_id) DO UPDATE SET stages=excluded.stages,revision=excluded.revision",[c.tenantId,JSON.stringify(stages),revision])
      const body={tenantId:c.tenantId,canEdit:true,data:{stages,revision}}
      await record(c,req.headers,"sales_pipeline",c.tenantId,scope,{revision,stages})
      await remember(c,key,scope,input,body)
      return body
    })
    return reply.header("etag",`"${(result.data as {revision:number}).revision}"`).header("cache-control","no-store").send(result)
  })
  const activitySchema=z.strictObject({kind:z.enum(["call","visit","email"]),subject:z.string().trim().min(1).max(240),dueDate:z.iso.date(),ownerId:z.guid()})
  for(const complete of [false,true]) {
    const route="/api/v1/opportunities/:id/activities"+(complete?"/:activityId/complete":"")
    app.post<{Params:{id:string;activityId?:string}}>(route,async(req,reply)=>{
      const result=await authorizeRequest(req,deps,async c=>{
        requirePermission(c,"sales.orders.read")
        requirePermission(c,"sales.orders.manage")
        const id=z.guid().safeParse(req.params.id), activityId=z.guid().safeParse(req.params.activityId)
        if(!id.success || complete && !activityId.success) throw new Problem(422,"invalid_input","Identificador de atividade inválido")
        const details=complete?null:activitySchema.safeParse(req.body)
        if(details && !details.success || complete && !z.strictObject({}).safeParse(req.body).success) throw new Problem(422,"invalid_input","Informe tipo, assunto, prazo e responsável")
        const expected=parseRevision(req.headers["if-match"]),key=commandKey(req.headers["idempotency-key"])
        const scope=complete?"opportunity.activity_completed":"opportunity.activity_created"
        const input={id:id.data,activity:activityId.data,revision:expected,details:details?.data}
        const prior=await replay(c,key,scope,input)
        if(prior) return prior
        const row=(await c.client.query("SELECT revision FROM sales_opportunities WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[c.tenantId,id.data])).rows[0]
        if(!row) throw new Problem(404,"not_found","Oportunidade não encontrada")
        if(revisionValue(row.revision)!==expected) throw new Problem(412,"revision_conflict","A oportunidade mudou. Atualize antes de continuar")
        const activity=complete?activityId.data!:randomUUID()
        if(details?.success) {
          const a=details.data
          await validateOwner(c,a.ownerId)
          await c.client.query("INSERT INTO sales_pipeline_activities(tenant_id,opportunity_id,id,kind,subject,due_date,owner_id) VALUES($1,$2,$3,$4,$5,$6,$7)",[c.tenantId,id.data,activity,a.kind,a.subject,a.dueDate,a.ownerId])
        } else {
          const done=await c.client.query("UPDATE sales_pipeline_activities SET completed_at=now() WHERE tenant_id=$1 AND opportunity_id=$2 AND id=$3 AND completed_at IS NULL RETURNING id",[c.tenantId,id.data,activity])
          if(!done.rows.length) throw new Problem(409,"domain_conflict","Atividade inexistente ou já concluída")
        }
        const revision=nextRevision(expected)
        await c.client.query("UPDATE sales_opportunities SET revision=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[c.tenantId,id.data,revision])
        await record(c,req.headers,"sales_opportunity",id.data,scope,{activityId:activity,revision})
        const body={tenantId:c.tenantId,data:{id:activity,revision}}
        await remember(c,key,scope,input,body)
        return body
      })
      return reply.code(complete?200:201).header("etag",`"${(result.data as {revision:number}).revision}"`).header("cache-control","no-store").send(result)
    })
  }
}
