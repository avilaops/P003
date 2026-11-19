import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission,type AuthorizedContext } from "../../platform/access.js"
import { commandKey,record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision,revisionValue } from "../../platform/revision.js"
import { queryInteger } from "../registrations/query.js"
import { sha256 } from "../nfe-email/danfe.js"
import { actorOf,fiscalEngine,settle } from "./transaction.js"
import { prefix,manage,notFound,conflict,recipient,storeReceived,signedId } from "./received.js"
import { events,inspectDistributed } from "./distributed-xml.js"
import { storedEvidence } from "./evidence.js"
import { invalid,parseXml } from "./xml.js"

const zero="000000000000000",nsu=z.string().regex(/^\d{15}$/)
const page=z.strictObject({offset:queryInteger(0,1000000).default(0),limit:queryInteger(1,100).default(25)})
const schema=z.object({code:z.enum(["137","138","656"]),lastNsu:nsu,maxNsu:nsu,documents:z.array(z.object({nsu,schema:z.string().max(120),kind:z.enum(["summary","full","event"]),xml:z.string().min(1)})).max(50)})
type Batch=z.infer<typeof schema>
const columns=`lpad(nsu::text,15,'0') AS nsu,schema_name AS schema,kind,access_key AS "accessKey",metadata,received_nfe_id AS "receivedNfeId",xml_sha256 AS "xmlSha256"`
async function cursor(c:AuthorizedContext){
  const r=(await c.client.query(`SELECT lpad(last_nsu::text,15,'0') AS "lastNsu",lpad(max_nsu::text,15,'0') AS "maxNsu",revision,next_query_at AS "nextQueryAt",last_code AS "lastCode",coalesce(lease_until>now(),false) AS running FROM fiscal_distribution_cursors WHERE tenant_id=$1 AND environment=2`,[c.tenantId])).rows[0]
  return {tenantId:c.tenantId,environment:"homologation",lastNsu:r?.lastNsu??zero,maxNsu:r?.maxNsu??zero,nextQueryAt:r?.nextQueryAt??null,lastCode:r?.lastCode??null,running:r?.running??false,revision:revisionValue(r?.revision??1)}
}
const monitorRun=`SELECT id,outcome,status,document_count AS "documentCount" FROM fiscal_monitor_runs WHERE tenant_id=$1`
async function applyBatch(c:AuthorizedContext,headers:Parameters<typeof record>[1],id:string,b:Batch,last:string,tax:string,prod:boolean){
  const next=b.code==="656"?last:b.lastNsu
  if(next<last || b.code!=="656"&&b.maxNsu<next || (b.code==="138")!==Boolean(b.documents.length)) invalid("Cursor e quantidade do lote incompatíveis")
  const seen=new Set<string>()
  for(const doc of b.documents){
    if(doc.nsu<=last || doc.nsu>next || seen.has(doc.nsu)) invalid("NSU fora do cursor ou repetido")
    seen.add(doc.nsu)
    const valid=doc.kind==="full"?/^procNFe_/:doc.kind==="summary"?/^resNFe_/:/^(?:procEventoNFe|resEvento)_/
    if(!valid.test(doc.schema)){
      if(!prod || /^(?:procNFe|resNFe|procEventoNFe|resEvento)_/.test(doc.schema)) invalid("Schema incompatível com o documento distribuído")
      parseXml(doc.xml)
      await c.client.query("INSERT INTO fiscal_monitor_documents(tenant_id,run_id,nsu,schema,kind,xml,xml_sha256) VALUES($1,$2,$3,$4,'other',$5,$6)",[c.tenantId,id,doc.nsu,doc.schema,doc.xml,sha256(doc.xml)])
      continue
    }
    const env=prod?1:2,{key,metadata:m,evidence}=inspectDistributed(doc.xml,doc.kind,tax,env),digest=sha256(doc.xml)
    if(prod && doc.kind==="full" && m.recipientDocument!==tax) {
      await c.client.query("INSERT INTO fiscal_monitor_documents(tenant_id,run_id,nsu,schema,kind,xml,xml_sha256) VALUES($1,$2,$3,$4,'other',$5,$6)",[c.tenantId,id,doc.nsu,doc.schema,doc.xml,digest])
      continue
    }
    const received=doc.kind==="full"?(await storeReceived(c,headers,doc.xml,tax,env)).id:null
    if(prod){
      await c.client.query(`INSERT INTO fiscal_monitor_documents(tenant_id,run_id,nsu,schema,kind,access_key,issuer_document,issuer_name,issued_at,total_cents,situation,xml,xml_sha256,received_nfe_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[c.tenantId,id,doc.nsu,doc.schema,doc.kind==="full"?"nfe":doc.kind,key,m.issuerDocument,m.issuerName,m.issuedAt,m.totalCents,evidence?.eventType==="110111"?"3":evidence?"event:"+evidence.eventType+":"+evidence.sequence:m.situation,doc.xml,digest,received])
      if(evidence) {
        const matches=await c.client.query("UPDATE fiscal_monitor_manifestations SET outcome='accepted',status=$4,protocol=$5,response_xml=$6,completed_at=now() WHERE tenant_id=$1 AND access_key=$2 AND event_type=$3 AND outcome='unknown' RETURNING id",[c.tenantId,key,evidence.eventType,evidence.code,evidence.protocol,doc.xml])
        for(const row of matches.rows) await record(c,headers,"recipient_manifestation",String(row.id),"fiscal.manifestation.reconciled",{nsu:doc.nsu,protocol:evidence.protocol})
      }
    }else{
      await c.client.query("INSERT INTO fiscal_distribution_documents(tenant_id,environment,nsu,schema_name,kind,access_key,xml,xml_sha256,metadata,received_nfe_id) VALUES($1,2,$2,$3,$4,$5,$6,$7,$8,$9)",[c.tenantId,doc.nsu,doc.schema,doc.kind,key,doc.xml,digest,m,received])
      if(evidence){
        const kind=Object.entries(events).find(([,v])=>v===evidence.eventType)?.[0]
        if(kind) {
          const matches=await c.client.query("UPDATE fiscal_recipient_manifestations SET status='accepted',revision=revision+1,response=$4 WHERE tenant_id=$1 AND environment=2 AND access_key=$2 AND kind=$3 AND status IN ('pending','unknown') RETURNING id",[c.tenantId,key,kind,{registered:true,code:evidence.code,protocol:evidence.protocol,sourceNsu:doc.nsu}])
          for(const row of matches.rows) await record(c,headers,"recipient_manifestation",String(row.id),"fiscal.manifestation.reconciled",{nsu:doc.nsu,protocol:evidence.protocol})
        }
      }
    }
  }
  if(b.code==="138"&&!seen.has(next))invalid("Lote incompleto para o último NSU informado")
  if(prod){
    const pending=await c.client.query("SELECT id,access_key,event_type FROM fiscal_monitor_manifestations WHERE tenant_id=$1 AND outcome='unknown'",[c.tenantId])
    for(const row of pending.rows){
      const proof=(await storedEvidence(c,String(row.access_key),true)).find(e=>e.eventType===row.event_type)
      if(!proof) continue
      await c.client.query("UPDATE fiscal_monitor_manifestations SET outcome='accepted',status=$3,protocol=$4,response_xml=$5,completed_at=now() WHERE tenant_id=$1 AND id=$2 AND outcome='unknown'",[c.tenantId,row.id,proof.code,proof.protocol,proof.xml])
      await record(c,headers,"recipient_manifestation",String(row.id),"fiscal.manifestation.reconciled",{nsu:proof.nsu,protocol:proof.protocol})
    }
  }
}
export function registerDistribution(app:FastifyInstance,deps:AppDependencies){
  app.get(prefix+"/distribution/status",async(req,reply)=>authorizeRequest(req,deps,async c=>{
    requirePermission(c,manage);const body=await cursor(c)
    return reply.header("etag",'"'+body.revision+'"').header("cache-control","no-store").send(body)
  }))
  for(const detail of [false,true]) app.get<{Params:{nsu?:string}}>(prefix+"/distribution/documents"+(detail?"/:nsu":""),async(req,reply)=>authorizeRequest(req,deps,async c=>{
    requirePermission(c,manage)
    if(detail){
      const query=nsu.safeParse(req.params.nsu);if(!query.success) invalid("NSU deve conter 15 dígitos")
      const row=(await c.client.query(`SELECT ${columns},xml FROM fiscal_distribution_documents WHERE tenant_id=$1 AND environment=2 AND nsu=$2`,[c.tenantId,query.data])).rows[0]??notFound()
      return reply.header("cache-control","no-store").send(row)
    }
    const q=page.safeParse(req.query);if(!q.success)invalid("Paginação inválida")
    const rows=(await c.client.query(`SELECT ${columns} FROM fiscal_distribution_documents WHERE tenant_id=$1 AND environment=2 ORDER BY nsu DESC LIMIT $2 OFFSET $3`,[c.tenantId,q.data.limit,q.data.offset])).rows
    const total=(await c.client.query("SELECT count(*)::int AS total FROM fiscal_distribution_documents WHERE tenant_id=$1 AND environment=2",[c.tenantId])).rows[0]!.total
    return reply.header("cache-control","no-store").send({tenantId:c.tenantId,data:rows,total})
  }))
  app.get(prefix+"/monitor",async(req,reply)=>authorizeRequest(req,deps,async c=>{
    requirePermission(c,"fiscal.monitor.read");const q=page.safeParse(req.query);if(!q.success)invalid("Paginação inválida")
    const data=(await c.client.query(`SELECT d.id::text,d.nsu,d.schema,d.kind,d.access_key AS "accessKey",d.issuer_name AS "issuerName",d.total_cents AS "totalCents",CASE WHEN EXISTS(SELECT FROM fiscal_monitor_documents b WHERE b.tenant_id=d.tenant_id AND b.access_key=d.access_key AND b.situation IN ('2','3')) THEN '3' ELSE d.situation END AS situation,d.xml_sha256 AS "xmlSha256",coalesce(d.received_nfe_id,n.id) AS "receivedNfeId",coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'eventType',m.event_type,'outcome',m.outcome,'status',m.status,'protocol',m.protocol) ORDER BY m.created_at) FROM fiscal_monitor_manifestations m WHERE m.tenant_id=d.tenant_id AND m.access_key=d.access_key),'[]'::jsonb) AS manifestations FROM fiscal_monitor_documents d LEFT JOIN fiscal_received_nfes n ON n.tenant_id=d.tenant_id AND n.access_key=d.access_key AND n.environment=1 WHERE d.tenant_id=$1 ORDER BY d.nsu DESC LIMIT $2 OFFSET $3`,[c.tenantId,q.data.limit,q.data.offset])).rows
    const state=(await c.client.query(`SELECT last_nsu AS "lastNsu",max_nsu AS "maxNsu",next_query_at AS "nextQueryAt",last_status AS "lastStatus" FROM fiscal_monitor_state WHERE tenant_id=$1`,[c.tenantId])).rows[0]
    const cert=(await c.client.query("SELECT metadata FROM fiscal_a1_certificates WHERE tenant_id=$1 AND ciphertext IS NOT NULL",[c.tenantId])).rows[0]?.metadata as {validUntil?:number;validFrom?:number}|undefined
    const total=(await c.client.query("SELECT count(*)::int AS n FROM fiscal_monitor_documents WHERE tenant_id=$1",[c.tenantId])).rows[0]!.n
    const lastRun=(await c.client.query(monitorRun.replace(" FROM",',created_at AS "createdAt",completed_at AS "completedAt" FROM')+" ORDER BY created_at DESC,id DESC LIMIT 1",[c.tenantId])).rows[0]??null
    const now=Date.now()/1000
    return reply.header("cache-control","no-store").send({tenantId:c.tenantId,canSync:c.permissions.includes("fiscal.monitor.manage"),canManifest:c.permissions.includes("fiscal.monitor.manifest"),certificateReady:!!cert && Number(cert.validUntil)>now && Number(cert.validFrom)<=now,collectionEnabled:!!deps.fiscalOperations?.productionRecipient?.(c.tenantId),lastNsu:zero,maxNsu:zero,lastStatus:null,nextQueryAt:null,...state,lastRun,documents:data.map(d=>({...d,id:BigInt(String(d.id)),totalCents:d.totalCents==null?null:BigInt(String(d.totalCents)),receivedNfeId:d.receivedNfeId==null?null:BigInt(String(d.receivedNfeId))})),total})
  }))
  app.get<{Params:{id:string}}>(prefix+"/monitor/documents/:id/xml",async(req,reply)=>authorizeRequest(req,deps,async c=>{
    requirePermission(c,"fiscal.monitor.read")
    const id=signedId(req.params.id),row=(await c.client.query("SELECT nsu,xml,xml_sha256 FROM fiscal_monitor_documents WHERE tenant_id=$1 AND id=$2",[c.tenantId,id])).rows[0]??notFound()
    if(sha256(String(row.xml))!==row.xml_sha256)conflict("Integridade do XML não confirmada")
    return reply.type("application/xml").header("cache-control","no-store").header("content-disposition",'attachment; filename="NSU-'+row.nsu+'.xml"').send(String(row.xml))
  }))
  for(const prod of [false,true]) app.post(prefix+(prod?"/monitor/sync":"/distribution/query"),async(req,reply)=>{
    const perm=prod?"fiscal.monitor.manage":manage
    const start=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,perm);if(prod)requirePermission(c,"fiscal.monitor.read")
      if(!z.strictObject({}).safeParse(req.body).success)invalid("Consulta fiscal não recebe parâmetros")
      const key=commandKey(req.headers["idempotency-key"]),rev=prod?null:parseRevision(req.headers["if-match"])
      const run=(await c.client.query(prod?monitorRun+" AND command_key=$2 AND auth_subject=$3":"SELECT id,status,result FROM fiscal_distribution_runs WHERE tenant_id=$1 AND command_key=$2 AND auth_subject=$3",[c.tenantId,key,c.authSubject])).rows[0]
      if(run)return {prior:prod?run:run.result??{...await cursor(c),runId:run.id,status:run.status}}
      const engine=fiscalEngine(deps)
      if(prod&&!engine.productionRecipient?.(c.tenantId))throw new Problem(503,"monitor_disabled","Coleta de produção desativada")
      const id=randomUUID(),tax=await recipient(c),material=await engine.material(c)
      if(material.issuerTaxId!==tax)conflict("Certificado e empresa incompatíveis")
      let last:string, authorState:string|undefined
      if(prod){
        const profile=(await c.client.query("SELECT details->>'state' AS state FROM company_profiles WHERE tenant_id=$1",[c.tenantId])).rows[0]
        authorState=String(profile?.state??"").toUpperCase()
        if (!/^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/.test(authorState)) conflict("Preencha a UF no cadastro da empresa")
        await c.client.query("INSERT INTO fiscal_monitor_state(tenant_id,tax_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[c.tenantId,tax])
        const state=(await c.client.query("SELECT last_nsu,tax_id,next_query_at>now() AS cooling FROM fiscal_monitor_state WHERE tenant_id=$1 FOR UPDATE",[c.tenantId])).rows[0]!
        if(state.tax_id!==tax)conflict("CNPJ mudou após iniciar o cursor fiscal")
        if(state.cooling)throw new Problem(429,"distribution_wait","Aguarde o intervalo da próxima consulta")
        last=String(state.last_nsu)
        await c.client.query("UPDATE fiscal_monitor_runs SET outcome='failed',status='unknown',completed_at=now() WHERE tenant_id=$1 AND outcome='pending'",[c.tenantId])
        await c.client.query("UPDATE fiscal_monitor_state SET next_query_at=now()+interval '2 minutes' WHERE tenant_id=$1",[c.tenantId])
        await c.client.query("INSERT INTO fiscal_monitor_runs(id,tenant_id,command_key,auth_subject,cursor_before) VALUES($1,$2,$3,$4,$5)",[id,c.tenantId,key,c.authSubject,last])
      }else{
        await c.client.query("INSERT INTO fiscal_distribution_cursors(tenant_id,environment) VALUES($1,2) ON CONFLICT DO NOTHING",[c.tenantId])
        const state=await cursor(c)
        if(rev!==state.revision)throw new Problem(412,"revision_conflict","O cursor mudou. Atualize a distribuição")
        if(state.running || state.nextQueryAt && +new Date(String(state.nextQueryAt))>Date.now())conflict("Consulta em andamento ou em intervalo obrigatório")
        last=String(state.lastNsu)
        await c.client.query("UPDATE fiscal_distribution_runs SET status='unknown' WHERE tenant_id=$1 AND status='running'",[c.tenantId])
        await c.client.query("UPDATE fiscal_distribution_cursors SET lease_id=$2,lease_until=now()+interval '2 minutes',revision=revision+1 WHERE tenant_id=$1 AND environment=2",[c.tenantId,id])
        await c.client.query("INSERT INTO fiscal_distribution_runs(id,tenant_id,environment,auth_subject,command_key,requested_nsu,status) VALUES($1,$2,2,$3,$4,$5,'running')",[id,c.tenantId,c.authSubject,key,last])
      }
      await record(c,req.headers,"fiscal_distribution",id,"fiscal.distribution.requested",{environment:prod?1:2,lastNsu:last})
      return {id,last,tax,material,authorState,actor:actorOf(c)}
    })
    let body:Record<string,unknown>
    if("prior" in start)body=start.prior as Record<string,unknown>
    else{
      const {id,last,tax,material,authorState,actor}=start
      const raw=await fiscalEngine(deps).call("distribute",{...material,authorState,environment:prod?"production":"homologation",lastNsu:last}).catch(()=>null)
      body=await settle(deps,actor,async c=>{
        const owns=(await c.client.query(prod?"SELECT 1 FROM fiscal_monitor_runs WHERE tenant_id=$1 AND id=$2 AND outcome='pending'":"SELECT 1 FROM fiscal_distribution_cursors WHERE tenant_id=$1 AND environment=2 AND lease_id=$2",[c.tenantId,id])).rows.length
        if(!owns)conflict("Consulta substituída. Consulte o cursor")
        const parsed=schema.safeParse(raw)
        let applied=false
        if(parsed.success){
          await c.client.query("SAVEPOINT incoming_batch")
          try{await applyBatch(c,req.headers,id,parsed.data,last,tax,prod);applied=true;await c.client.query("RELEASE SAVEPOINT incoming_batch")}
          catch(error){await c.client.query("ROLLBACK TO SAVEPOINT incoming_batch");if(!(error instanceof Problem))throw error}
        }
        const b=parsed.data,code=applied?b!.code:"invalid_or_unknown",next=applied&&code!=="656"?b!.lastNsu:last,max=applied&&code!=="656"?b!.maxNsu:last
        const delay=code==="137"||code==="656"||applied&&next===max?3600:applied?2:60
        let result:Record<string,unknown>
        if(prod){
          await c.client.query("UPDATE fiscal_monitor_state SET last_nsu=$2,max_nsu=greatest(max_nsu,$3),last_status=$4,next_query_at=now()+make_interval(secs=>$5),updated_at=now() WHERE tenant_id=$1",[c.tenantId,next,max,code,delay])
          await c.client.query("UPDATE fiscal_monitor_runs SET outcome=$3,status=$4,document_count=$5,completed_at=now() WHERE tenant_id=$1 AND id=$2",[c.tenantId,id,applied?"applied":"failed",code,applied?b!.documents.length:0])
          result=(await c.client.query(monitorRun+" AND id=$2",[c.tenantId,id])).rows[0]!
        }else{
          await c.client.query("UPDATE fiscal_distribution_cursors SET last_nsu=$2,max_nsu=greatest(max_nsu,$3),last_code=$4,next_query_at=now()+make_interval(secs=>$5),revision=revision+1,lease_id=NULL,lease_until=NULL WHERE tenant_id=$1 AND environment=2",[c.tenantId,next,max,code,delay])
          result={...await cursor(c),runId:id,status:applied?"completed":raw?"failed":"unknown"}
          await c.client.query("UPDATE fiscal_distribution_runs SET status=$3,result=$4 WHERE tenant_id=$1 AND id=$2",[c.tenantId,id,result.status,result])
        }
        await record(c,req.headers,"fiscal_distribution",id,"fiscal.distribution.result",{code,lastNsu:next})
        return result
      })
      await authorizeRequest(req,deps,async c=>requirePermission(c,perm),false)
    }
    if(!prod)reply.header("etag",'"'+body.revision+'"')
    return reply.code(prod?202:200).header("cache-control","no-store").send(body)
  })
}
