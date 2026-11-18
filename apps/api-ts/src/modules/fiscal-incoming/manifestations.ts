import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest,requirePermission,type AuthorizedContext } from "../../platform/access.js"
import { commandKey,record,replay,remember } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision,revisionValue } from "../../platform/revision.js"
import { queryInteger } from "../registrations/query.js"
import { prefix,manage,notFound,conflict,recipient,signedId } from "./received.js"
import { invalid,key55 } from "./xml.js"
import { events, inspectDistributed } from "./distributed-xml.js"
import { storedEvidence } from "./evidence.js"
import { actorOf,fiscalEngine,settle } from "./transaction.js"

const types=z.enum(["ciencia","confirmacao","desconhecimento","nao_realizada"]), codes=z.enum(["210200","210210","210220","210240"])
const justification=z.string().trim().max(255).nullable().optional()
const accessKey=z.string().refine(key55)
const base=prefix+"/manifestations"
const selection='id,access_key AS "accessKey",kind,status,revision,issued_at AS "issuedAt",response AS result'
async function read(c:AuthorizedContext,id:string) {
  const r=(await c.client.query("SELECT "+selection+" FROM fiscal_recipient_manifestations WHERE tenant_id=$1 AND id=$2 AND environment=2",[c.tenantId,id])).rows[0]??notFound()
  return {...r,id:r.id,kind:r.kind,status:r.status,accessKey:r.accessKey,revision:revisionValue(r.revision)}
}
function classify(r:Record<string,unknown>|null, key:string, kind:string, tax:string, environment:number){
  if (r?.registered === true) {
    try {
      const proof = inspectDistributed(String(r.xml), "event", tax, environment)
      if (proof.key !== key || proof.evidence?.eventType !== kind ||
          proof.evidence.protocol !== r.protocol || proof.evidence.code !== r.code) return "unknown"
    } catch { return "unknown" }
  }
  const code=String(r?.code??"")
  if(r?.registered===true && ["135","136"].includes(code) && /^\d{15}$/.test(String(r.protocol)))return "accepted"
  if(r?.registered===false && /^\d{3}$/.test(code) && !["108","109","128","135","136","573"].includes(code))return "rejected"
  return "unknown"
}
const idOf=(value:string)=>z.guid().safeParse(value).success?value:invalid("Identificador de manifestação inválido")
export function registerManifestations(app:FastifyInstance,deps:AppDependencies){
  app.get(base,async(req,reply)=>authorizeRequest(req,deps,async c=>{
    requirePermission(c,manage)
    const q=z.strictObject({accessKey:accessKey.optional(),offset:queryInteger(0,1000000).default(0),limit:queryInteger(1,100).default(100)}).safeParse(req.query)
    if(!q.success)invalid("Filtro de manifestação inválido")
    const rows=(await c.client.query("SELECT "+selection+" FROM fiscal_recipient_manifestations WHERE tenant_id=$1 AND environment=2 AND ($2::text IS NULL OR access_key=$2) ORDER BY issued_at DESC,id LIMIT $3 OFFSET $4",[c.tenantId,q.data.accessKey,q.data.limit,q.data.offset])).rows
    return reply.header("cache-control","no-store").send({tenantId:c.tenantId,data:rows.map(r=>({...r,revision:revisionValue(r.revision)}))})
  }))
  app.get<{Params:{id:string}}>(base+"/:id",async(req,reply)=>authorizeRequest(req,deps,async c=>{
    requirePermission(c,manage);const body=await read(c,idOf(req.params.id))
    return reply.header("etag",'"'+body.revision+'"').header("cache-control","no-store").send(body)
  }))
  app.post<{Params:{id:string}}>(base+"/:id/reconcile",async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,manage)
      const id=idOf(req.params.id),rev=parseRevision(req.headers["if-match"]),key=commandKey(req.headers["idempotency-key"])
      if(!z.strictObject({}).safeParse(req.body).success)invalid("Conciliação usa os eventos distribuídos")
      const scope="fiscal.manifestation.reconcile",input={id,revision:rev}
      const previous=await replay(c,key,scope,input)
      if(previous)return previous
      const current=await read(c,id)
      if(current.revision!==rev)throw new Problem(412,"revision_conflict","A manifestação mudou. Atualize o resultado")
      const proof=(await storedEvidence(c,String(current.accessKey),false)).find(e=>events[current.kind as keyof typeof events]===e.eventType)
      if(proof && ["pending","unknown"].includes(String(current.status))) {
        await c.client.query("UPDATE fiscal_recipient_manifestations SET status='accepted',response=$3,revision=revision+1 WHERE tenant_id=$1 AND id=$2",[c.tenantId,id,{registered:true,code:proof.code,protocol:proof.protocol,evidenceNsu:proof.nsu,xml:proof.xml}])
        await record(c,req.headers,"recipient_manifestation",id,"fiscal.manifestation.reconciled",{evidenceNsu:proof.nsu,code:proof.code})
      }
      const body={...await read(c,id),reconciliation:{status:proof?"matched":"no_evidence"}}
      await remember(c,key,scope,input,body)
      return body
    })
    return reply.header("cache-control","no-store").header("etag",'"'+result.revision+'"').send(result)
  })
  for(const prod of [false,true]) app.post<{Params:{id?:string}}>(prod?prefix+"/monitor/documents/:id/manifest":base,async(req,reply)=>{
    const perm=prod?"fiscal.monitor.manifest":manage
    const reserved=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,perm);if(prod)requirePermission(c,"fiscal.monitor.read")
      const key=commandKey(req.headers["idempotency-key"]),doc=prod?signedId(req.params.id!):null
      const p=(prod?z.strictObject({eventType:codes,justification}):z.strictObject({accessKey,kind:types,justification})).safeParse(req.body)
      if(!p.success)invalid("Tipo, chave ou justificativa da manifestação inválidos")
      const input=p.data,kind="kind" in input?input.kind:Object.keys(events).find(k=>events[k as keyof typeof events]===input.eventType)! as keyof typeof events
      const eventType=events[kind],reason=input.justification??null
      if(kind==="nao_realizada"?(reason??"").length<15 || /\p{Cc}/u.test(reason??""):reason!==null)invalid("Justificativa de 15 a 255 caracteres somente para Operação não realizada")
      const prior=(await c.client.query(prod?'SELECT id,auth_subject,document_id,event_type,justification,outcome,status,protocol FROM fiscal_monitor_manifestations WHERE tenant_id=$1 AND command_key=$2':'SELECT id,request,auth_subject FROM fiscal_recipient_manifestations WHERE tenant_id=$1 AND command_key=$2 AND auth_subject=$3',[c.tenantId,key,...(prod?[]:[c.authSubject])])).rows[0]
      if(prior){
        const original=prod?{doc:String(prior.document_id),eventType:prior.event_type,reason:prior.justification}:prior.request as {accessKey:string;kind:string;justification:string|null}
        const same=prod?String(prior.document_id)===doc&&prior.event_type===eventType&&prior.justification===reason:"accessKey" in original&&"accessKey" in input&&original.accessKey===input.accessKey&&original.kind===kind&&original.justification===reason
        if(prior.auth_subject!==c.authSubject||!same)conflict("Chave reutilizada com outra manifestação")
        return {prior:prod?{id:prior.id,eventType,outcome:prior.outcome,status:prior.status,protocol:prior.protocol}:await read(c,String(prior.id))}
      }
      if(!prod && parseRevision(req.headers["if-match"])!==1)throw new Problem(412,"revision_conflict","Revisão de manifestação inválida")
      const engine=fiscalEngine(deps)
      if(prod&&!engine.productionRecipient?.(c.tenantId))throw new Problem(503,"monitor_disabled","Manifestação de produção desativada")
      let noteKey:string
      if(prod){
        const n=(await c.client.query("SELECT access_key,kind,situation FROM fiscal_monitor_documents WHERE tenant_id=$1 AND id=$2",[c.tenantId,doc])).rows[0]??notFound()
        if(!["summary","nfe"].includes(String(n.kind))||n.situation!=="1"||!key55(String(n.access_key)))conflict("A manifestação exige um documento autorizado recebido pela empresa")
        noteKey=String(n.access_key)
        const previous=(await c.client.query("SELECT event_type,outcome FROM fiscal_monitor_manifestations WHERE tenant_id=$1 AND access_key=$2",[c.tenantId,noteKey])).rows
        const blocked=(await c.client.query("SELECT 1 FROM fiscal_monitor_documents WHERE tenant_id=$1 AND access_key=$2 AND situation IN ('2','3') LIMIT 1",[c.tenantId,noteKey])).rows.length
        const evidence=await storedEvidence(c,noteKey,true)
        if(blocked||previous.some(r=>r.outcome==="unknown"||r.event_type===eventType||kind==="ciencia"&&r.event_type!=="210210"&&r.outcome==="accepted")||evidence.some(e=>e.eventType==="110111"||e.eventType===eventType||kind==="ciencia"&&e.eventType!=="210210"))conflict("Documento cancelado, manifestação duplicada ou resultado anterior pendente")
      }else{
        noteKey="accessKey" in input?input.accessKey:invalid("Chave fiscal obrigatória")
        const found=(await c.client.query("SELECT 1 FROM fiscal_received_nfes WHERE tenant_id=$1 AND environment=2 AND access_key=$2 UNION ALL SELECT 1 FROM fiscal_distribution_documents WHERE tenant_id=$1 AND environment=2 AND access_key=$2",[c.tenantId,noteKey])).rows.length
        if(!found)notFound()
        const same=(await c.client.query("SELECT 1 FROM fiscal_recipient_manifestations WHERE tenant_id=$1 AND environment=2 AND access_key=$2 AND kind=$3",[c.tenantId,noteKey,kind])).rows.length
        if(same)conflict("Manifestação já solicitada. Confira o resultado")
      }
      const material=await engine.material(c),tax=await recipient(c)
      if(tax!==material.issuerTaxId)conflict("Certificado e empresa incompatíveis")
      if (prod) {
        const owner = (await c.client.query("SELECT tax_id FROM fiscal_monitor_state WHERE tenant_id=$1", [c.tenantId])).rows[0]
        if (owner?.tax_id !== tax) conflict("CNPJ incompatível com o cursor de distribuição")
      }
      const id=randomUUID(),issuedAt=new Date().toISOString()
      if(prod) await c.client.query("INSERT INTO fiscal_monitor_manifestations(id,tenant_id,document_id,access_key,event_type,justification,command_key,auth_subject) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,c.tenantId,doc,noteKey,eventType,reason,key,c.authSubject])
      else await c.client.query("INSERT INTO fiscal_recipient_manifestations(id,tenant_id,environment,access_key,kind,justification,auth_subject,command_key,request,status,issued_at) VALUES($1,$2,2,$3,$4,$5,$6,$7,$8,'pending',$9)",[id,c.tenantId,noteKey,kind,reason,c.authSubject,key,{accessKey:noteKey,kind,justification:reason},issuedAt])
      await record(c,req.headers,"recipient_manifestation",id,"fiscal.manifestation.requested",{accessKey:noteKey,kind,environment:prod?1:2})
      return {id,eventType,actor:actorOf(c),payload:{...material,environment:prod?"production":"homologation",accessKey:noteKey,kind,justification:reason,issuedAt}}
    })
    let body:Record<string,unknown>
    if("prior" in reserved){body=reserved.prior!;reply.header("idempotency-replayed","true")}
    else {
      const {id,actor,payload,eventType}=reserved
      const result=await fiscalEngine(deps).call("manifest",payload).catch(()=>null),status=classify(result,payload.accessKey,eventType,payload.issuerTaxId,prod?1:2)
      body=await settle(deps,actor,async c=>{
        let snapshot:Record<string,unknown>
        if(prod){
          await c.client.query("UPDATE fiscal_monitor_manifestations SET outcome=$3,status=$4,protocol=$5,signed_xml=$6,response_xml=$7,completed_at=now() WHERE tenant_id=$1 AND id=$2 AND outcome='unknown' AND completed_at IS NULL",[c.tenantId,id,status,result?.code,result?.protocol,result?.xml,result?.rawXml])
          snapshot=(await c.client.query('SELECT id,event_type AS "eventType",outcome,status,protocol FROM fiscal_monitor_manifestations WHERE tenant_id=$1 AND id=$2',[c.tenantId,id])).rows[0]!
        }else{
          await c.client.query("UPDATE fiscal_recipient_manifestations SET status=$3,response=$4,revision=revision+1 WHERE tenant_id=$1 AND id=$2 AND status='pending'",[c.tenantId,id,status,result])
          snapshot=await read(c,id)
        }
        await record(c,req.headers,"recipient_manifestation",id,"fiscal.manifestation.result",{status:snapshot.outcome??snapshot.status,eventType})
        return snapshot
      })
      await authorizeRequest(req,deps,async c=>requirePermission(c,perm),false)
    }
    if(!prod)reply.header("etag",'"'+body.revision+'"')
    return reply.code(prod?202:200).header("cache-control","no-store").send(body)
  })
}
