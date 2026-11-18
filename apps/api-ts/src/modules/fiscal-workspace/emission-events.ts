import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest,requirePermission,type AuthorizedContext } from "../../platform/access.js"
import { commandKey,replay,remember,record } from "../../platform/commands.js"
import { parseRevision,revisionValue } from "../../platform/revision.js"
import { Problem } from "../../platform/problem.js"
import { conflict,guid,invalid,type ObjectData } from "./draft-data.js"
import { document,validEvent } from "./emission.js"

const projection=`tenant_id AS "tenantId",id,document_id AS "documentId",kind,sequence,revision,status,request,result`
type EventRow={tenantId:string;id:string;documentId:string;kind:string;sequence:number;revision:string;status:string;request:ObjectData;result:ObjectData}
async function get(c:AuthorizedContext,id:string) {
  const e=(await c.client.query<EventRow>(`SELECT ${projection} FROM fiscal_nfe_events WHERE tenant_id=$1 AND id=$2`,[c.tenantId,id])).rows[0]
  if (!e)throw new Problem(404,"not_found","Evento fiscal não encontrado")
  return {...e,revision:revisionValue(e.revision)}
}
async function cancellationSource(c:AuthorizedContext,source:string) {
  requirePermission(c,"fiscal.nfe.read")
  const cancellation=(await c.client.query<{order_id:string;reason:string}>("SELECT order_id,reason FROM sales_order_cancellations WHERE tenant_id=$1 AND id=$2",[c.tenantId,source])).rows[0]
  if(!cancellation)throw new Problem(404,"not_found","Cancelamento comercial não encontrado")
  const rows=(await c.client.query<{id:string;environment:string;revision:string;status:string;number:number;series:number;pending:boolean}>(`SELECT d.id,d.environment,d.revision,d.status,d.number::int,d.series,
    EXISTS(SELECT 1 FROM fiscal_nfe_events e WHERE e.tenant_id=d.tenant_id AND e.document_id=d.id AND e.kind='cancelamento' AND e.status IN('pending','unknown')) AS pending FROM fiscal_nfe_documents d
    WHERE tenant_id=$1 AND source_order_id=$2 AND status<>'rejected' ORDER BY (environment='production') DESC,id`,[c.tenantId,cancellation.order_id])).rows
  // A commercial order can have a separate homologation run. Prefer its production document.
  const relevant=rows.some(d=>d.environment==="production")?rows.filter(d=>d.environment==="production"):rows
  if(relevant.length!==1)return conflict("O cancelamento exige uma única nota vinculada no ambiente da venda")
  return {document:relevant[0]!,reason:cancellation.reason}
}
export function registerEmissionEvents(app:FastifyInstance,deps:AppDependencies) {
  const path="/api/v1/fiscal/nfe/:id/"
  app.get<{Params:{id:string}}>(path+"events",async(r,reply)=>authorizeRequest(r,deps,async c=>{
    requirePermission(c,"fiscal.nfe.read")
    const id=guid(r.params.id)
    if(!await document(c,id))throw new Problem(404,"not_found","Documento sem emissão")
    const rows=(await c.client.query<EventRow>(`SELECT ${projection} FROM fiscal_nfe_events WHERE tenant_id=$1 AND document_id=$2 ORDER BY created_at,id`,[c.tenantId,id])).rows
    return reply.header("cache-control","no-store").send({tenantId:c.tenantId,data:rows.map(e=>({...e,revision:revisionValue(e.revision)}))})
  }))
  app.get("/api/v1/fiscal/nfe-events",async(r,reply)=>authorizeRequest(r,deps,async c=>{
    requirePermission(c,"fiscal.nfe.read")
    const params=z.strictObject({kind:z.enum(["correcao","inutilizacao"]),cursor:z.guid().optional(),limit:z.coerce.number().int().min(1).max(100).default(25)}).safeParse(r.query)
    if(!params.success)return invalid("Confira os filtros do histórico fiscal")
    const {kind,cursor,limit}=params.data
    const rows=(await c.client.query(`SELECT e.id,e.document_id AS "documentId",e.kind,e.sequence,e.status,
        coalesce(d.environment,e.request->>'environment','homologation') AS environment,d.series,d.number::int,d.access_key AS "accessKey",
        e.request,e.result,e.created_at AS "createdAt" FROM fiscal_nfe_events e LEFT JOIN fiscal_nfe_documents d
        ON d.tenant_id=e.tenant_id AND d.id=e.document_id WHERE e.tenant_id=$1 AND e.kind=$2 AND ($3::uuid IS NULL OR e.id<$3)
        ORDER BY e.id DESC LIMIT $4`,[c.tenantId,kind,cursor,limit+1])).rows
    const data=rows.slice(0,limit)
    return reply.header("cache-control","no-store").send({tenantId:c.tenantId,data,nextCursor:rows.length>limit?data.at(-1)?.id:null})
  }))
  app.post("/api/v1/fiscal/number-voids",async(r,reply)=>{
    const result=await authorizeRequest(r,deps,async c=>{
      requirePermission(c,"fiscal.nfe.read");requirePermission(c,"fiscal.nfe.void")
      const input=z.strictObject({year:z.number().int().min(2000).max(2099),series:z.number().int().min(1).max(999),
        first:z.number().int().min(1).max(999999999),last:z.number().int().min(1).max(999999999),text:z.string().trim().min(15).max(255)}).safeParse(r.body)
      if(!input.success || input.data.last<input.data.first || input.data.last-input.data.first>9999)return invalid("Confira a faixa e a justificativa de inutilização")
      const key=commandKey(r.headers["idempotency-key"])
      const existing=await replay(c,key,"fiscal.nfe.void",input.data)
      if(existing)return get(c,String(existing.id))
      if(r.headers["if-match"]!=='"0"')throw new Problem(412,"revision_conflict","Confira a revisão da solicitação de inutilização")
      return conflict("A inutilização está indisponível no perfil de emissão de São Paulo. Consulte o histórico de faixas registradas")
    })
    return reply.code(["pending","unknown"].includes(result.status)?202:200).header("cache-control","no-store").header("etag",'"'+result.revision+'"').send(result)
  })
  const orderPath="/api/v1/fiscal/order-cancellations/:id/process"
  app.get<{Params:{id:string}}>(orderPath,async(r,reply)=>authorizeRequest(r,deps,async c=>{
    const source=guid(r.params.id),{document:d}=await cancellationSource(c,source)
    return reply.header("cache-control","no-store").header("etag",'"'+d.revision+'"').send({tenantId:c.tenantId,sourceCancellationId:source,
      documentId:d.id,environment:d.environment,status:d.status,number:d.number,series:d.series,pending:d.pending,revision:revisionValue(d.revision),canProcess:c.permissions.includes("fiscal.nfe.cancel")})
  }))
  for(const operation of ["cancel","correction","process"] as const)app.post<{Params:{id:string}}>(operation==="process"?orderPath:path+operation,async(r,reply)=>{
    const sourceCancellationId=operation==="process"?guid(r.params.id):null
    const source=sourceCancellationId ? await authorizeRequest(r,deps,c=>cancellationSource(c,sourceCancellationId),false) : undefined
    const action=operation==="process"?"cancel":operation
    const parsed=z.strictObject({text:z.string().trim().min(15).max(action==="cancel"?255:1000)}).safeParse(source?{text:source.reason}:r.body)
    if(!parsed.success || /\p{Cc}/u.test(parsed.data.text))return invalid("Confira a justificativa do evento fiscal")
    const text=parsed.data.text.replace(/\s+/g," "),id=source?.document.id ?? guid(r.params.id),key=commandKey(r.headers["idempotency-key"]),revision=parseRevision(r.headers["if-match"])
    const kind=action==="cancel"?"cancelamento":"correcao", scope="fiscal.nfe."+action,input={id,revision,kind,text,sourceCancellationId}
    const flow=deps.fiscalOperations
    const access=(c:AuthorizedContext)=>{requirePermission(c,"fiscal.nfe.read");requirePermission(c,scope)}
    const start=await authorizeRequest(r,deps,async c=>{
      access(c)
      const d=await document(c,id)
      if(!d)throw new Problem(404,"not_found","Emissão não encontrada")
      const previous=await replay(c,key,scope,input)
      let snapshot=previous ? await get(c,String(previous.id)) : undefined
      if(snapshot && (d.busy || ["registered","rejected"].includes(snapshot.status)))return {snapshot}
      if(!flow)throw new Problem(503,"fiscal_engine_unavailable","Motor fiscal indisponível")
      if(!previous && revisionValue(d.revision)!==revision)throw new Problem(412,"revision_conflict","A emissão mudou")
      let uncertain=!!previous
      if(!snapshot){
        const existing=(await c.client.query("SELECT id,kind,request FROM fiscal_nfe_events WHERE tenant_id=$1 AND document_id=$2 AND status IN('pending','unknown')",[c.tenantId,id])).rows[0]
        if(existing){
          if(existing.kind!==kind || (existing.request as ObjectData).text!==text)conflict("Confira o evento pendente no histórico antes de solicitar outro")
          snapshot=await get(c,String(existing.id))
          uncertain=true
          await remember(c,key,scope,input,snapshot)
        }
      }
      if(snapshot && d.busy)return {snapshot}
      if(!snapshot && (d.status!=="authorized" || !d.access_key || d.busy))conflict("O evento exige nota autorizada e disponível")
      if(!snapshot && action==="cancel" && d.source_return_kind==="sale_partial_return" && (await c.client.query("SELECT id FROM sales_self_return_plans WHERE tenant_id=$1 AND id=$2 AND status IN('applied','simulated')",[c.tenantId,id])).rows.length)
        conflict("A entrada de devolução já foi conciliada. Confira os vínculos comerciais antes do cancelamento")
      if(!snapshot && action==="cancel" && (await c.client.query(`SELECT 1 FROM sales_invoice_lots l JOIN sales_self_return_plans p
          ON (p.tenant_id,p.lot_id)=(l.tenant_id,l.id) WHERE l.tenant_id=$1 AND l.draft_id=$2 AND p.status IN('pending','ready','applied','simulated')
          UNION ALL SELECT 1 FROM sales_invoice_lots l JOIN sales_partial_returns r ON (r.tenant_id,r.lot_id)=(l.tenant_id,l.id)
          WHERE l.tenant_id=$1 AND l.draft_id=$2
          UNION ALL SELECT 1 FROM sales_invoice_lots l JOIN sales_return_requests r ON (r.tenant_id,r.lot_id)=(l.tenant_id,l.id)
          WHERE l.tenant_id=$1 AND l.draft_id=$2 AND r.status='pending' LIMIT 1`,[c.tenantId,id])).rows.length)
        conflict("A nota de venda tem devolução vinculada. Confira o pedido antes do cancelamento")
      if(d.model===65 && action==="correction")conflict("O modelo 65 não aceita carta de correção")
      if(d.environment==="production" && !flow.production(c.tenantId))conflict("Eventos de produção precisam estar liberados para a empresa")
      const material=await flow.material(c)
      if(d.access_key?.slice(6,20)!==material.issuerTaxId)conflict("O emitente da nota diverge do certificado")
      if(!snapshot) {
        const n=kind==="cancelamento"?1:Number((await c.client.query("SELECT coalesce(max(sequence),0)+1 AS seq FROM fiscal_nfe_events WHERE tenant_id=$1 AND document_id=$2 AND kind='correcao'",[c.tenantId,id])).rows[0]!.seq)
        if(n>20)conflict("Limite de cartas de correção atingido")
        const eventId=randomUUID(),data={kind,text,sourceCancellationId,sequence:n,issuedAt:new Date().toISOString(),environment:d.environment,issuerTaxId:material.issuerTaxId,accessKey:d.access_key,protocol:d.protocol}
        await c.client.query("INSERT INTO fiscal_nfe_events(tenant_id,id,document_id,kind,sequence,request,status) VALUES($1,$2,$3,$4,$5,$6,'pending')",[c.tenantId,eventId,id,kind,n,data])
        snapshot=await get(c,eventId)
        await remember(c,key,scope,input,snapshot)
        await record(c,r.headers,"fiscal_event",eventId,"fiscal.nfe.event.requested",{documentId:id,kind,sequence:n})
      }
      await c.client.query("UPDATE fiscal_nfe_events SET status='unknown',lease_until=clock_timestamp()+interval '120 seconds' WHERE tenant_id=$1 AND id=$2",[c.tenantId,snapshot.id])
      await c.client.query("UPDATE fiscal_nfe_documents SET lease_until=clock_timestamp()+interval '120 seconds' WHERE tenant_id=$1 AND id=$2",[c.tenantId,id])
      return {event:snapshot,material,d,uncertain}
    })
    const answer=(v:Awaited<ReturnType<typeof get>>)=>reply.code(v.status==="unknown"?202:200).header("cache-control","no-store").header("etag",`"${v.revision}"`).send(v)
    if(start.snapshot)return answer(start.snapshot)
    const event=start.event!, payload={...event.request,certificate:start.material!.certificate}
    let result:ObjectData
    try {
      if(start.uncertain){
        const consult=await flow!.call("consult",{...payload,signedXml:start.d!.signed_xml})
        const match=Array.isArray(consult.events) && (consult.events as ObjectData[]).find(e=>e.kind===kind && e.sequence===event.sequence && e.text===text)
        result=match?{...match,registered:true}:{code:"event_reconciliation_pending",reason:"A consulta ainda não confirmou o evento"}
      } else result=await flow!.call("event",payload)
    } catch {result={code:"event_reconciliation_pending",reason:"Resultado incerto. Confirme a mesma solicitação para consultar a chave"}}
    const final=await authorizeRequest(r,deps,async c=>{
      access(c)
      const valid=await validEvent(c,event.request,result)
      const code=String(result.code || ""),definite=result.registered===false && /^\d{3}$/.test(code) && !["135","136","155","573"].includes(code)
      const status=valid?"registered":definite?"rejected":"unknown"
      const saved={code,reason:String(result.reason || "").slice(0,550),...(valid ? {protocol:result.protocol,xml:result.xml}:{})}
      const changed=await c.client.query("UPDATE fiscal_nfe_events SET status=$3,result=$4,lease_until=NULL,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND revision=$5 RETURNING id",
        [c.tenantId,event.id,status,saved,event.revision])
      if(!changed.rows.length)return get(c,event.id)
      await c.client.query("UPDATE fiscal_nfe_documents SET status=CASE WHEN $3 THEN 'cancelled' ELSE status END,revision=revision+1,updated_at=now(),lease_until=NULL WHERE tenant_id=$1 AND id=$2",[c.tenantId,id,valid && kind==="cancelamento"])
      await record(c,r.headers,"fiscal_event",event.id,"fiscal.nfe.event.reconciled",{documentId:id,kind,status})
      return get(c,event.id)
    })
    return answer(final)
  })
}
