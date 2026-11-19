import { fiscalLots } from "./fiscal-lots.js"
import { invoiceLine } from "./equipment.js"
import { policies as loadPolicies,policySchema,traceInput,validateScope,receiptOptions,identification,eligiblePolicies } from "./policy.js"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AccessDependencies, AuthorizedContext } from "../../platform/access.js"
import { nextRevision } from "../../platform/revision.js"
import { queryInteger,searchQuery } from "../registrations/query.js"
import { approve, command, conflict, current, event, idParam, invalid, limitedText, manage, metadata, money, parse, readWith, statuses } from "./shared.js"

export const base = "/api/v1/warranty-cases/:id"
const time = z.iso.datetime({offset:true}).nullish()
const notes = limitedText(0,2000).default("")
const orderStates = z.enum(["open","scheduled","in_repair","awaiting_parts","completed","cancelled"])
const destination: Record<string, readonly string[]> = {
  opened:["triage","cancelled"], triage:["diagnosis","cancelled"], diagnosis:["treatment","cancelled"],
  treatment:["resolved","cancelled"], resolved:["closed"],
}
const eventTypes: Record<string,string> = {triage:"triaged",diagnosis:"diagnosed",treatment:"treated",resolved:"resolved",closed:"closed",cancelled:"cancelled"}
export async function activeCase(ctx: AuthorizedContext,id:string,expected:number | bigint) {
  const row=await current(ctx,"warranty_cases",id,expected)
  if (row.status==="closed" || row.status==="cancelled") conflict("A garantia já está encerrada")
  return row
}
export function bump(ctx: AuthorizedContext,id:string) {
  return ctx.client.query("UPDATE warranty_cases SET revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,id])
}
export function registerWarrantyService(app: FastifyInstance,deps: AccessDependencies) {
  app.get("/api/v1/warranty-staff",async(req,reply)=>reply.header("cache-control","no-store").send(await readWith(req,deps,async ctx=>{
    const f=parse(z.strictObject({q:searchQuery,status:z.literal("active").optional(),limit:queryInteger(1,100).default(10),offset:queryInteger(0,100000).default(0)}),req.query)
    const result=await ctx.client.query(`WITH matches AS (SELECT id,name FROM staff WHERE tenant_id=$1 AND status='active' AND is_employee AND strpos(lower(name),lower($2))>0),
      page AS (SELECT * FROM matches ORDER BY name,id LIMIT $3 OFFSET $4)
      SELECT (SELECT count(*)::int FROM matches) AS total,coalesce(jsonb_agg(to_jsonb(page) ORDER BY name,id),'[]') AS data FROM page`,[ctx.tenantId,f.q,f.limit,f.offset])
    return {...result.rows[0],offset:f.offset,limit:f.limit}
  })))
  const policies = "/api/v1/warranty-policies"
  app.get(policies,async (req,reply) => reply.header("cache-control","no-store").send(await readWith(req,deps,async ctx => {
    const query=parse(z.strictObject({documentId:idParam.optional(),lineNumber:z.coerce.number().int().positive().optional(),...traceInput.shape}).refine(p=>Boolean(p.documentId)===Boolean(p.lineNumber)),req.query)
    const all=await loadPolicies(ctx)
    if(!query.documentId||!query.lineNumber)return {data:all}
    const line=await invoiceLine(ctx,query.documentId,query.lineNumber)
    if(!line)return invalid("Origem fiscal indisponível para consulta de cobertura")
    const receipts=await receiptOptions(ctx,line),trace=identification(line,query,receipts)
    return {data:eligiblePolicies(all,trace,line.soldOn),trace,receipts,lots:await fiscalLots(ctx,line)}
  })))
  command(app,deps,policies,policySchema,"warranty.policy.created","warranty_policy",manage,async(ctx,input)=>{
    await validateScope(ctx,input.scope)
    const id=randomUUID()
    await ctx.client.query("INSERT INTO warranty_policies(id,tenant_id,name,coverage_type,duration_days,scope,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,ctx.tenantId,input.name,input.coverageType,input.durationDays,input.scope,input.validFrom,input.validUntil])
    return {data:{id,...input,status:"active",revision:1},aggregateId:id}
  })
  const filter=z.strictObject({status:orderStates.optional(),offset:queryInteger(0,1000000).default(0),limit:queryInteger(1,100).default(50)})
  app.get("/api/v1/warranty-service-orders",async(req,reply)=>reply.header("cache-control","no-store").send(await readWith(req,deps,async ctx=>{
    const f=parse(filter,req.query)
    const rows=await ctx.client.query('SELECT to_jsonb(t) AS data FROM (SELECT so.id,so.case_id AS "caseId",wc.protocol,wc.title,wc.criticality,so.status,so.diagnosis,so.scheduled_at AS "scheduledAt",so.completed_at AS "completedAt",so.labor_cents AS "laborCents",so.revision,so.created_at AS "createdAt",so.updated_at AS "updatedAt" FROM warranty_service_orders so JOIN warranty_cases wc ON (wc.tenant_id,wc.id)=(so.tenant_id,so.case_id) WHERE so.tenant_id=$1 AND ($2::text IS NULL OR so.status=$2) ORDER BY so.updated_at DESC,so.id DESC LIMIT $3 OFFSET $4) t',[ctx.tenantId,f.status,f.limit,f.offset])
    return {data:rows.rows.map(r=>r.data),offset:f.offset,limit:f.limit}
  })))
  command(app,deps,base+"/assignment",z.strictObject({queue:limitedText(1,80),assignedTo:idParam.nullish(),slaDueAt:time}),"warranty.case.assigned","warranty_case",manage,async(ctx,input,id,expected)=>{
    const row=await activeCase(ctx,id,expected)
    if (input.assignedTo && !(await ctx.client.query("SELECT id FROM staff WHERE tenant_id=$1 AND id=$2 AND status='active' AND is_employee",[ctx.tenantId,input.assignedTo])).rows.length) invalid("Selecione um funcionário ativo desta empresa")
    await ctx.client.query("UPDATE warranty_cases SET queue=$3,assigned_to=$4,sla_due_at=$5,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,id,input.queue,input.assignedTo,input.slaDueAt])
    await event(ctx,id,"note",String(row.status),input)
    return {data:{id,...input,revision:nextRevision(expected)},aggregateId:id}
  })
  command(app,deps,base+"/transition",z.strictObject({status:statuses,details:metadata.default({})}),"warranty.case.transitioned","warranty_case",manage,async(ctx,input,id,expected)=>{
    const row=await current(ctx,"warranty_cases",id,expected)
    if (!destination[String(row.status)]?.includes(input.status)) conflict("Transição indisponível para a situação atual")
    await ctx.client.query("UPDATE warranty_cases SET status=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,id,input.status])
    await event(ctx,id,eventTypes[input.status]!,input.status,input.details)
    return {data:{id,status:input.status,revision:nextRevision(expected)},aggregateId:id}
  })
  command(app,deps,base+"/service-order",z.strictObject({diagnosis:limitedText(1,4000).nullish(),report:metadata,scheduledAt:time,laborCents:money}),"warranty.service_order.created","warranty_service_order",manage,async(ctx,input,caseId,expected)=>{
    await activeCase(ctx,caseId,expected)
    const id=randomUUID()
    await ctx.client.query("INSERT INTO warranty_service_orders(id,tenant_id,case_id,diagnosis,report,scheduled_at,labor_cents) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,ctx.tenantId,caseId,input.diagnosis,input.report,input.scheduledAt,input.laborCents])
    await ctx.client.query("UPDATE warranty_cases SET status='treatment',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,caseId])
    await event(ctx,caseId,"treated","treatment",{serviceOrderId:id})
    return {data:{id,caseId,status:"open",laborCents:input.laborCents,revision:1,caseRevision:nextRevision(expected)},aggregateId:id}
  })
  const decision=z.strictObject({action:z.enum(["exchange","refund","credit"]),decision:z.enum(["approved","rejected"]),amountCents:money.nullish(),notes})
  command(app,deps,base+"/approval",decision,"warranty.case.approval.created","warranty_approval",approve,async(ctx,input,caseId,expected)=>{
    const row=await activeCase(ctx,caseId,expected)
    if (input.decision==="approved" && input.action!=="exchange" && !input.amountCents) invalid("Informe o valor aprovado")
    const id=randomUUID()
    await ctx.client.query("INSERT INTO warranty_approvals(id,tenant_id,case_id,action,decision,amount_cents,notes) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,ctx.tenantId,caseId,input.action,input.decision,input.amountCents,input.notes])
    const data={id,caseId,...input,revision:nextRevision(expected)}
    await ctx.client.query("UPDATE warranty_cases SET resolution=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,caseId,{approvalId:id,action:input.action,decision:input.decision}])
    await event(ctx,caseId,"approval",String(row.status),data)
    return {data,aggregateId:id}
  })
}
