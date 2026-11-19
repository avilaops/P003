import { DOMParser,XMLSerializer } from "@xmldom/xmldom"
import {child} from "../fiscal-incoming/xml.js"
import { createHash,randomInt } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest,requirePermission,type AuthorizedContext } from "../../platform/access.js"
import { commandKey,replay,remember,record } from "../../platform/commands.js"
import { parseRevision,revisionValue } from "../../platform/revision.js"
import { Problem } from "../../platform/problem.js"
import { conflict,guid,loadDraft,type ObjectData } from "./draft-data.js"
import { validateDraft } from "./drafts.js"

export async function document(c:AuthorizedContext,id:string) {
  return (await c.client.query<{id:string;model:number;environment:string;revision:string;status:string;series:number;number:string;access_key:string|null;signed_xml:string|null;authorized_xml:string|null;protocol:string|null;result:ObjectData;busy:boolean;issued_at:string;random_code:string;source_order_id:string|null;source_return_id:string|null;source_return_kind:string|null;return_order:string|null}>(`
    SELECT d.*,coalesce(d.lease_until>clock_timestamp(),false) AS busy,
      CASE WHEN d.model=55 AND d.status='authorized' AND coalesce((f.details->>'purpose')::int,1)=1 THEN coalesce(d.source_order_id,l.order_id) END AS return_order
      FROM fiscal_nfe_documents d JOIN fiscal_nfe_drafts f ON (f.tenant_id,f.id)=(d.tenant_id,d.id) LEFT JOIN sales_invoice_lots l ON (l.tenant_id,l.draft_id)=(d.tenant_id,d.id) WHERE d.tenant_id=$1 AND d.id=$2`,[c.tenantId,id])).rows[0]
}
type Document=NonNullable<Awaited<ReturnType<typeof document>>>
export function emissionSnapshot(c:AuthorizedContext,d:Document){
  return {tenantId:c.tenantId,id:d.id,environment:d.environment,model:d.model,revision:revisionValue(d.revision),series:d.series,number:Number(d.number),status:d.status,accessKey:d.access_key,protocol:d.protocol,result:d.result,
    returnOrderId:c.permissions.includes("sales.orders.read")?d.return_order:null,sourceOrderId:d.source_order_id,sourceReturnId:d.source_return_id,sourceReturnKind:d.source_return_kind}
}
const terminal=(status:string)=>["authorized","cancelled","rejected"].includes(status)
const summary=(v:ObjectData)=>({code:typeof v.code==="string"?v.code.slice(0,80):"",reason:typeof v.reason==="string"?v.reason.slice(0,550):typeof v.title==="string"?v.title.slice(0,550):""})
function cleanXml(value:unknown):value is string {
  return typeof value==="string" && Buffer.byteLength(value)<=4*1024*1024 && !/<!\s*(?:DOCTYPE|ENTITY)|\0/i.test(value)
}
export function checkDigit(prefix:string) {
  let sum=0
  for(let i=0;i<prefix.length;i++)sum+=Number(prefix[prefix.length-1-i])*(2+i%8)
  const result=11-sum%11
  return result>=10?0:result
}
export async function wellFormed(c:AuthorizedContext,xml:unknown){
  return cleanXml(xml) && (await c.client.query("SELECT xml_is_well_formed_document($1) AS ok",[xml])).rows[0]?.ok===true
}
export async function validEvent(c:AuthorizedContext,event:ObjectData,reply:ObjectData) {
  if(reply.registered!==true || typeof reply.protocol!=="string" || !/^\d{15}$/.test(reply.protocol) || !await wellFormed(c,reply.xml))return false
  const cancel=event.kind==="cancelamento"
  const proof=await c.client.query(`SELECT count(*)=1 AND bool_and(r.key=$2 AND r.env=$3 AND r.kind=$4 AND r.seq=$5 AND r.protocol=$6
      AND (r.code='135' OR $4='110111' AND r.code='155') AND s.key=r.key AND s.env=r.env AND s.kind=r.kind AND s.seq=r.seq
      AND s.reason=$7 AND ($4<>'110111' OR s.auth=$8)) AS ok
    FROM XMLTABLE(XMLNAMESPACES('http://www.portalfiscal.inf.br/nfe' AS n),'/n:procEventoNFe/n:retEvento/n:infEvento' PASSING xmlparse(document $1)
      COLUMNS key text PATH 'n:chNFe',env text PATH 'n:tpAmb',kind text PATH 'n:tpEvento',seq int PATH 'n:nSeqEvento',protocol text PATH 'n:nProt',code text PATH 'n:cStat') r
    CROSS JOIN XMLTABLE(XMLNAMESPACES('http://www.portalfiscal.inf.br/nfe' AS n),'/n:procEventoNFe/n:evento/n:infEvento' PASSING xmlparse(document $1)
      COLUMNS key text PATH 'n:chNFe',env text PATH 'n:tpAmb',kind text PATH 'n:tpEvento',seq int PATH 'n:nSeqEvento',
        reason text PATH 'n:detEvento/n:xJust|n:detEvento/n:xCorrecao',auth text PATH 'n:detEvento/n:nProt') s`,
    [reply.xml,event.accessKey,event.environment==="production"?"1":"2",cancel?"110111":"110110",event.sequence,reply.protocol,event.text,event.protocol])
  return proof.rows[0]?.ok===true
}
async function signedEvidence(c:AuthorizedContext,d:Document,key:unknown,xml:unknown,issuer:unknown){
  if (typeof key!=="string" || !/^\d{44}$/.test(key) || !await wellFormed(c,xml) || checkDigit(key.slice(0,43))!==Number(key[43]) || key.slice(6,20)!==issuer || key.slice(20,22)!==String(d.model) ||
    key.slice(22,25)!==String(d.series).padStart(3,"0") || key.slice(25,34)!==String(d.number).padStart(9,"0") || key.slice(35,43)!==d.random_code) return false
  const res=await c.client.query(`SELECT count(*)=1 AND bool_and(x.id=$2 AND x.env=$3 AND x.model=$4 AND x.num=$5 AND x.series=$6 AND x.code=$7 AND x.issuer=$8 AND s.ref='#'||x.id AND length(trim(s.digest))>0) AS ok
    FROM XMLTABLE(XMLNAMESPACES('http://www.portalfiscal.inf.br/nfe' AS n),'/n:NFe/n:infNFe' PASSING xmlparse(document $1) COLUMNS id text PATH '@Id',env text PATH 'n:ide/n:tpAmb',model int PATH 'n:ide/n:mod',num bigint PATH 'n:ide/n:nNF',series int PATH 'n:ide/n:serie',code text PATH 'n:ide/n:cNF',issuer text PATH 'n:emit/n:CNPJ') x
    CROSS JOIN XMLTABLE(XMLNAMESPACES('http://www.portalfiscal.inf.br/nfe' AS n,'http://www.w3.org/2000/09/xmldsig#' AS ds),'/n:NFe/ds:Signature/ds:SignedInfo/ds:Reference' PASSING xmlparse(document $1) COLUMNS ref text PATH '@URI',digest text PATH 'ds:DigestValue') s`,
    [xml,"NFe"+key,d.environment==="production"?"1":"2",d.model,d.number,d.series,d.random_code,issuer])
  return res.rows[0]?.ok===true
}
export async function validProtocol(c:AuthorizedContext,d:Document,v:ObjectData){
  if(!await wellFormed(c,v.xml) || typeof v.protocol!=="string" || !/^\d{15}$/.test(v.protocol) || !d.signed_xml || !d.access_key) return false
  const ns="XMLNAMESPACES('http://www.portalfiscal.inf.br/nfe' AS n,'http://www.w3.org/2000/09/xmldsig#' AS ds)"
  const result=await c.client.query(`SELECT count(*)=1 AND bool_and(p.key=$3 AND p.env=$4 AND p.protocol=$5 AND p.code IN('100','150') AND p.digest=s.digest AND n.info='NFe'||$3 AND n.digest=s.digest AND s.ref='#NFe'||$3) AS ok
    FROM XMLTABLE(${ns},'/n:nfeProc/n:protNFe/n:infProt' PASSING xmlparse(document $1) COLUMNS key text PATH 'n:chNFe',env text PATH 'n:tpAmb',protocol text PATH 'n:nProt',code text PATH 'n:cStat',digest text PATH 'n:digVal') p
    CROSS JOIN XMLTABLE(${ns},'/n:nfeProc/n:NFe' PASSING xmlparse(document $1) COLUMNS info text PATH 'n:infNFe/@Id',digest text PATH 'ds:Signature/ds:SignedInfo/ds:Reference/ds:DigestValue') n
    CROSS JOIN XMLTABLE(${ns},'/n:NFe/ds:Signature/ds:SignedInfo/ds:Reference' PASSING xmlparse(document $2) COLUMNS ref text PATH '@URI',digest text PATH 'ds:DigestValue') s`,[v.xml,d.signed_xml,d.access_key,d.environment==="production"?"1":"2",v.protocol])
  return result.rows[0]?.ok===true
}
export function registerEmission(app:FastifyInstance,deps:AppDependencies) {
  const path="/api/v1/fiscal/nfe/:id/"
  app.get<{Params:{id:string}}>(path+"danfe",async(r,reply)=>{
    const note=await authorizeRequest(r,deps,async c=>{
      requirePermission(c,"fiscal.nfe.read")
      const doc=await document(c,guid(r.params.id))
      if(!doc || !doc.signed_xml || !doc.access_key || doc.access_key[34]!=="9" || doc.model!==65 || !["prepared","unknown"].includes(doc.status))return conflict("Cupom de contingência indisponível")
      return {signedXml:doc.signed_xml,accessKey:doc.access_key,environment:doc.environment}
    })
    if(!deps.fiscalOperations)throw new Problem(503,"fiscal_engine_unavailable","Motor fiscal indisponível")
    const rendered=await deps.fiscalOperations.call("offline-receipt",note)
    const pdf=typeof rendered.pdf==="string" ? Buffer.from(rendered.pdf,"base64"):Buffer.alloc(0)
    const hash=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex")
    if(pdf.length>4*1024*1024 || pdf.subarray(0,5).toString()!=="%PDF-" || !pdf.subarray(-1024).includes("%%EOF") ||
      rendered.xmlHash!==hash(note.signedXml) || rendered.pdfHash!==hash(pdf))throw new Problem(502,"invalid_receipt","O cupom não corresponde ao XML da emissão")
    return reply.type("application/pdf").header("cache-control","no-store").header("content-disposition",'attachment; filename="DANFE-'+note.accessKey+'.pdf"')
      .header("x-xml-sha256",rendered.xmlHash).header("x-pdf-sha256",rendered.pdfHash).header("x-nfe-authorization-check","pending").send(pdf)
  })
  for(const format of ["xml","emission"] as const)app.get<{Params:{id:string}}>(path+format,async(request,reply)=>authorizeRequest(request,deps,async c=>{
    requirePermission(c,"fiscal.nfe.read")
    const d=await document(c,guid(request.params.id))
    if(!d)throw new Problem(404,"not_found","Nota sem emissão nesta empresa")
    reply.header("cache-control","no-store")
    if(format==="emission")return reply.header("etag",`"${d.revision}"`).send(emissionSnapshot(c,d))
    const xml=d.authorized_xml ?? d.signed_xml
    if(!xml || !d.access_key)throw new Problem(404,"not_found","XML ainda não preparado")
    return reply.type("application/xml; charset=utf-8").header("content-disposition",`attachment; filename="NFE-${d.access_key}.xml"`).send(xml)
  }))
  for(const action of ["issue","consult"] as const)app.post<{Params:{id:string}}>(path+action,async(request,reply)=>{
    const id=guid(request.params.id),key=commandKey(request.headers["idempotency-key"]),expected=parseRevision(request.headers["if-match"])
    const scope="fiscal.nfe."+action, input={id,revision:expected}
    const flow=deps.fiscalOperations
    const access=(c:AuthorizedContext)=>{requirePermission(c,"fiscal.nfe.read");requirePermission(c,"fiscal.nfe.issue")}
    const start=await authorizeRequest(request,deps,async c=>{
      access(c)
      const prior=await replay(c,key,scope,input)
      let d=await document(c,id)
      const draft=(await loadDraft(c,id)).data
      if(!prior && revisionValue(d?.revision ?? draft.revision)!==expected)throw new Problem(412,"revision_conflict","A revisão da nota mudou")
      if(action==="consult" && !d)throw new Problem(404,"not_found","Documento ainda sem emissão")
      if(d && (d.busy || (terminal(d.status) && (action==="issue" || prior)) || prior && ["offline_contingency_ready","not_found"].includes(String(d.result.code)))){
        const snap=emissionSnapshot(c,d)
        if(!prior)await remember(c,key,scope,input,snap)
        return {snapshot:snap}
      }
      if(!flow)throw new Problem(503,"fiscal_engine_unavailable","Configure o motor fiscal e o certificado antes desta operação")
      if(action==="issue" && draft.input.environment==="production" && !flow.production(c.tenantId))conflict("A emissão de produção precisa estar liberada para esta empresa")
      if(action==="issue" && draft.input.sourceReturnKind==="sale_partial_return" &&
        !(await c.client.query("SELECT id FROM sales_self_return_plans WHERE tenant_id=$1 AND id=$2 AND status='ready'",[c.tenantId,id])).rows.length)
        conflict("A emissão da devolução exige solicitação aprovada e em aberto")
      const material=await flow.material(c)
      if(material.issuerTaxId!==draft.issuer.taxId)conflict("O certificado precisa pertencer ao emitente")
      let nfce:ObjectData|undefined
      if(action==="issue" && !d?.signed_xml) {
        const fresh=await validateDraft(c,draft.input,true)
        if(fresh.issuer.companyRevision!==draft.issuer.companyRevision || fresh.issuer.profileRevision!==draft.issuer.profileRevision)conflict("Atualize o rascunho após alterar a empresa ou seu perfil fiscal")
        if(draft.input.model===65)nfce=await flow.nfceSecret(c,draft.input.environment)
      }
      if(!d){
        const profile=draft.issuer.profile as ObjectData,consumer=draft.input.model===65 ? (await c.client.query<{data:ObjectData}>("SELECT data FROM fiscal_preferences WHERE tenant_id=$1 AND section='nfce'",[c.tenantId])).rows[0]?.data : undefined
        const series=Number(draft.input.series ?? consumer?.series ?? profile.series),initial=Number((consumer || profile).nextNumber ?? 1)
        if(!Number.isInteger(series) || series<1 || series>999 || !Number.isInteger(initial) || initial<1 || initial>999999999)conflict("Confira a série e a numeração do documento")
        const args=[c.tenantId,draft.input.environment,draft.input.model,series]
        await c.client.query("INSERT INTO fiscal_number_sequences(tenant_id,environment,model,series,next_number) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",[...args,initial])
        const n=(await c.client.query("UPDATE fiscal_number_sequences SET next_number=coalesce($5::bigint,next_number)+1 WHERE tenant_id=$1 AND environment=$2 AND model=$3 AND series=$4 AND next_number<=999999999 AND ($5::bigint IS NULL OR $5 BETWEEN next_number AND 999999999) RETURNING next_number-1 AS num",[...args,draft.input.number])).rows[0]
        if(!n)return conflict("Número já utilizado ou série esgotada")
        await c.client.query(`INSERT INTO fiscal_nfe_documents(tenant_id,id,source_order_id,source_return_id,source_return_kind,environment,model,status,series,number,issued_at,random_code)
          VALUES($1,$2,$3,$4,$5,$6,$7,'preparing',$8,$9,$10,$11)`,[c.tenantId,id,draft.input.sourceOrderId,draft.input.sourceReturnId,draft.input.sourceReturnKind,draft.input.environment,draft.input.model,series,n.num,draft.input.issuedAt ?? new Date().toISOString(),String(randomInt(100000000)).padStart(8,"0")])
        d=(await document(c,id))!
        await record(c,request.headers,"fiscal_nfe",id,"fiscal.nfe.requested",{environment:d.environment,number:d.number,model:d.model})
      }
      if(action==="consult" && !d.access_key)conflict("O documento ainda não possui chave para consulta")
      await c.client.query("UPDATE fiscal_nfe_documents SET lease_until=clock_timestamp()+interval '120 seconds' WHERE tenant_id=$1 AND id=$2",[c.tenantId,id])
      if(!prior)await remember(c,key,scope,input,emissionSnapshot(c,d))
      return {d,draft,material,nfce,tenantId:c.tenantId}
    })
    const answer=(snapshot:ReturnType<typeof emissionSnapshot>)=>reply.header("cache-control","no-store").header("etag",`"${snapshot.revision}"`).send(snapshot)
    if(start.snapshot)return answer(start.snapshot)
    const {draft,material,nfce}=start
    let d=start.d!
    const payload={environment:d.environment,certificate:material!.certificate}
    const finish=(value:ObjectData,status:string,fromProvider=false)=>authorizeRequest(request,deps,async c=>{
      access(c)
      const current=(await document(c,id))!
      if(current.revision!==d.revision || current.status!==d.status)return emissionSnapshot(c,current)
      let resolved=status, result=summary(value),xml:unknown=null,protocol:unknown=null
      if(fromProvider && ["authorized","cancelled"].includes(status)) {
        if(await validProtocol(c,current,value)){
          const original=current.signed_xml!.replace(/^\uFEFF?\s*<\?xml[^?]*\?>\s*/,"")
          const receipt=child(new DOMParser().parseFromString(String(value.xml),"application/xml").documentElement!,"protNFe")
          xml='<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'+original+new XMLSerializer().serializeToString(receipt)+'</nfeProc>'
          protocol=value.protocol
          if(status==="cancelled"){
            const events=Array.isArray(value.events) ? value.events as ObjectData[] : []
            let confirmed=false
            for(const event of events.filter(e=>e.kind==="cancelamento" && e.sequence===1 && typeof e.text==="string")){
              confirmed=await validEvent(c,{...event,accessKey:current.access_key,environment:current.environment,protocol}, {...event,registered:true})
              if(confirmed)break
            }
            if(!confirmed){resolved="authorized";result={code:"cancellation_unconfirmed",reason:"Protocolo de autorização confirmado. Consulte novamente para confirmar o cancelamento"}}
          }
        }
        else {resolved=terminal(current.status)?current.status:"unknown";result={code:"invalid_protocol",reason:"Protocolo não corresponde ao XML assinado. Consulte o documento"}}
      }
      if(current.status==="cancelled" || current.status==="authorized" && resolved!=="cancelled" || terminal(current.status) && resolved==="unknown")resolved=current.status
      await c.client.query(`UPDATE fiscal_nfe_documents SET status=$3,result=(result-'code'-'reason')||$4::jsonb,lease_until=NULL,authorized_xml=coalesce($5,authorized_xml),protocol=coalesce($6,protocol),revision=revision+1,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,[c.tenantId,id,resolved,result,xml,protocol])
      await record(c,request.headers,"fiscal_nfe",id,"fiscal.nfe."+resolved,{status:resolved,code:result.code,environment:d.environment})
      return emissionSnapshot(c,(await document(c,id))!)
    })
    if(!d.signed_xml){
      let prepared:ObjectData
      try {prepared=await flow!.call("prepare",{...payload,issuer:{...draft!.issuer,profile:{...(draft!.issuer.profile as ObjectData),series:d.series}},draft:draft!.input,tenantId:start.tenantId,
        ibptSnapshot:draft!.ibptSnapshot,number:Number(d.number),issuedAt:d.issued_at,randomCode:d.random_code,nfce})}
      catch {return answer(await finish({code:"preparation_unavailable",reason:"A preparação não foi concluída. A numeração foi preservada"},"preparing"))}
      if(prepared.status==="blocked")return answer(await finish({code:"preparation_blocked",reason:prepared.title},"preparing"))
      const valid=await authorizeRequest(request,deps,async c=>{access(c);return signedEvidence(c,d,prepared.accessKey,prepared.signedXml,material!.issuerTaxId)},false)
      if(!valid || d.model===65 && !prepared.qrCode)return answer(await finish({code:"invalid_preparation",reason:"O XML preparado diverge da numeração ou do emitente"},"preparing"))
      d=await authorizeRequest(request,deps,async c=>{
        access(c)
        if((await c.client.query("SELECT id FROM fiscal_outgoing_imports WHERE tenant_id=$1 AND access_key=$2",[c.tenantId,prepared.accessKey])).rows.length)return conflict("A chave já está no arquivo de XML importado da empresa")
        const update=await c.client.query("UPDATE fiscal_nfe_documents SET status='prepared',signed_xml=$3,access_key=$4,revision=revision+1,result=$6 WHERE tenant_id=$1 AND id=$2 AND revision=$5 RETURNING id",[c.tenantId,id,prepared.signedXml,prepared.accessKey,d.revision,typeof prepared.qrCode==="string" ? {qrCode:prepared.qrCode}:{}])
        if(!update.rows.length)conflict("A emissão foi atualizada durante a preparação")
        return (await document(c,id))!
      })
      if(draft!.input.emissionType==="9")return answer(await finish({code:"offline_contingency_ready",reason:"NFC-e offline preparada para transmissão posterior"},"prepared"))
    }
    const operation=action==="consult" || d.status==="unknown" ? "consult":"authorize"
    if(operation==="authorize")d=await authorizeRequest(request,deps,async c=>{
      access(c)
      const update=await c.client.query("UPDATE fiscal_nfe_documents SET status='unknown',revision=revision+1,lease_until=clock_timestamp()+interval '120 seconds' WHERE tenant_id=$1 AND id=$2 AND revision=$3 RETURNING id",[c.tenantId,id,d.revision])
      if(!update.rows.length)conflict("A situação da nota mudou. Consulte a emissão")
      return (await document(c,id))!
    })
    let provider:ObjectData
    try {provider=await flow!.call(operation,{...payload,accessKey:d.access_key,signedXml:d.signed_xml,batch:String(d.number).padStart(15,"0")})}
    catch {return answer(await finish({code:"transport_uncertain",reason:"A autorização não foi confirmada. Consulte a chave antes de repetir"},"unknown"))}
    const result=String(provider.status)
    if(operation==="consult" && result==="not_found" && !terminal(d.status))return answer(await finish({code:"not_found",reason:"A SEFAZ ainda não localizou a chave. Confirme explicitamente uma nova transmissão"},"prepared"))
    const resolved=result==="denied" ? "rejected" : ["authorized","cancelled","rejected"].includes(result) ? result : "unknown"
    return answer(await finish(provider,resolved,true))
  })
}
