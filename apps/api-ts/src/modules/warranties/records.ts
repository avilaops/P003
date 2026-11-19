import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision } from "../../platform/revision.js"
import { activeCase, bump } from "./service.js"
import { command, conflict, event, idParam, invalid, limitedText, manage, parse, read, readWith } from "./shared.js"

const formats = z.enum(["application/pdf","image/jpeg","image/png","video/mp4"])
const limit = 10 * 1024 * 1024
const title = limitedText(3,160)
const inputSchema = z.discriminatedUnion("kind",[
  z.strictObject({kind:z.literal("evidence"),title,filename:limitedText(1,160).regex(/^[^/\\\r\n]+$/),mediaType:formats,base64:z.base64().min(4).max(4*Math.ceil(limit/3))}),
  z.strictObject({kind:z.literal("term"),title,contractId:idParam}),
  z.strictObject({kind:z.literal("report"),title,serviceOrderId:idParam,cause:limitedText(2,160),diagnosis:limitedText(3,4000),conclusion:limitedText(3,4000),scheduledAt:z.iso.datetime({offset:true}).nullable(),status:z.enum(["scheduled","in_repair","awaiting_parts","completed"])})
])
function matchesFile(content:Buffer,mediaType:z.infer<typeof formats>) {
  if(mediaType==="application/pdf") return content.subarray(0,5).toString("ascii")==="%PDF-"
  if(mediaType==="image/png") return content.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex"))
  if(mediaType==="image/jpeg") return content.subarray(0,3).equals(Buffer.from("ffd8ff","hex"))
  return content.length>=12 && content.subarray(4,8).toString("ascii")==="ftyp"
}
const schema=inputSchema.transform(input=>{
  if(input.kind!=="evidence") return input
  const content=Buffer.from(input.base64,"base64")
  if(content.length>limit || !matchesFile(content,input.mediaType)) return invalid("Confira o formato e o tamanho do arquivo")
  return {kind:input.kind,title:input.title,filename:input.filename,mediaType:input.mediaType,content,sha256:createHash("sha256").update(content).digest("hex")}
})
const contractQuery=`SELECT c.id,c.template_name AS name,c.status,c.signature_policy AS policy,
  CASE WHEN c.signature_policy='icp_each_participant' THEN s.phase='completed'
       ELSE c.status='completed' AND EXISTS(SELECT FROM commercial_contract_files f WHERE f.tenant_id=c.tenant_id AND f.contract_id=c.id AND f.kind='signed') END AS accepted
  FROM commercial_contracts c LEFT JOIN contract_signature_envelopes e ON (e.tenant_id,e.contract_id)=(c.tenant_id,c.id)
  LEFT JOIN contract_signature_states s ON (s.tenant_id,s.envelope_id)=(e.tenant_id,e.id)
  WHERE c.tenant_id=$1 AND c.order_id=$2 AND c.customer_id=$3`
export function registerWarrantyRecords(app:FastifyInstance,deps:AccessDependencies) {
  const path="/api/v1/warranty-cases/:id/records"
  app.get<{Params:{id:string}}>(path,async(req,reply)=>reply.header("cache-control","no-store").send(await readWith(req,deps,async ctx=>{
    const id=parse(idParam,req.params.id),args=[ctx.tenantId,id]
    const row=(await ctx.client.query("SELECT order_id,customer_id,revision FROM warranty_cases WHERE tenant_id=$1 AND id=$2",args)).rows[0]
    if(!row) throw new Problem(404,"not_found","Protocolo não encontrado")
    const canReadTerms=ctx.permissions.includes("sales.orders.read")
    const records=(await ctx.client.query(`SELECT id,kind,title,info,sha256,contract_id AS "contractId",service_order_id AS "serviceOrderId",created_at AS "createdAt"
      FROM warranty_case_records WHERE tenant_id=$1 AND case_id=$2 AND (kind<>'term' OR $3) ORDER BY created_at DESC,id`,[...args,canReadTerms])).rows
    const contracts=row.order_id && canReadTerms?(await ctx.client.query(contractQuery+" ORDER BY c.created_at DESC",[ctx.tenantId,row.order_id,row.customer_id])).rows:[]
    return {records,contracts,canReadTerms}
  })))
  command(app,deps,path,schema,"warranty.case.recorded","warranty_case",manage,async(ctx,input,caseId,revision)=>{
    const row=await activeCase(ctx,caseId,revision),id=randomUUID()
    let info:Record<string,unknown>
    if(input.kind==="term"){
      requirePermission(ctx,"sales.orders.read")
      const contract=(await ctx.client.query(contractQuery+" AND c.id=$4",[ctx.tenantId,row.order_id,row.customer_id,input.contractId])).rows[0]
      if(!contract) return invalid("Selecione um termo do pedido e do cliente deste protocolo")
      info={policy:contract.policy,template:contract.name}
    }else if(input.kind==="report"){
      if(input.status==="scheduled" && !input.scheduledAt) return invalid("Informe a data de agendamento")
      const order=await ctx.client.query(`UPDATE warranty_service_orders SET diagnosis=$4,report=$5,scheduled_at=$6,status=$7,
        completed_at=CASE WHEN $7='completed' THEN clock_timestamp() END,revision=revision+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND case_id=$2 AND id=$3 AND status NOT IN ('completed','cancelled') RETURNING id`,[ctx.tenantId,caseId,input.serviceOrderId,input.diagnosis,{cause:input.cause,conclusion:input.conclusion},input.scheduledAt,input.status])
      if(!order.rows.length) return conflict("Selecione uma ordem de serviço em andamento neste protocolo")
      info={cause:input.cause,diagnosis:input.diagnosis,conclusion:input.conclusion,status:input.status,scheduledAt:input.scheduledAt}
    }else info={filename:input.filename,mediaType:input.mediaType,bytes:input.content.length}
    const saved=await ctx.client.query(`INSERT INTO warranty_case_records(tenant_id,id,case_id,kind,title,info,content,sha256,contract_id,service_order_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,[ctx.tenantId,id,caseId,input.kind,input.title,info,
      input.kind==="evidence"?input.content:null,input.kind==="evidence"?input.sha256:null,input.kind==="term"?input.contractId:null,input.kind==="report"?input.serviceOrderId:null,ctx.authSubject])
    if(!saved.rows.length) return conflict("Este arquivo ou termo já está no protocolo")
    await bump(ctx,caseId)
    const data={id,caseId,kind:input.kind,revision:nextRevision(revision)}
    await event(ctx,caseId,input.kind==="evidence"?"attachment":"note",String(row.status),{...data,title:input.title})
    return {data,aggregateId:caseId}
  },{bodyLimit:14_100_000,fingerprint:input=>input.kind==="evidence"?{kind:input.kind,filename:input.filename,mediaType:input.mediaType,title:input.title,sha256:input.sha256}:input})
  app.get<{Params:{id:string}}>("/api/v1/warranty-evidence/:id/file",async(req,reply)=>authorizeRequest(req,deps,async ctx=>{
    requirePermission(ctx,read)
    const id=parse(idParam,req.params.id)
    const row=(await ctx.client.query<{content:Buffer;info:{filename:string;mediaType:string}}>("SELECT content,info FROM warranty_case_records WHERE tenant_id=$1 AND id=$2 AND kind='evidence'",[ctx.tenantId,id])).rows[0]
    if(!row) throw new Problem(404,"not_found","Evidência não encontrada")
    return reply.header("cache-control","no-store").header("x-content-type-options","nosniff").header("content-disposition","attachment; filename*=UTF-8''"+encodeURIComponent(row.info.filename).replace(/['()*]/g,c=>"%"+c.charCodeAt(0).toString(16))).type(row.info.mediaType).send(row.content)
  },false))
}
