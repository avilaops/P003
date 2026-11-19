import type {FastifyInstance,FastifyReply} from "fastify"
import {z} from "zod"
import {authorizeRequest,requirePermission,type AccessDependencies,type AuthorizedContext} from "../../platform/access.js"
import {Problem} from "../../platform/problem.js"
import {renderDanfe,sha256} from "../nfe-email/danfe.js"
import {parseXml,ns,child,children,value,key55,fiscalDecimal,invalid} from "../fiscal-incoming/xml.js"
import {checkDigit} from "./emission.js"
import {signedId} from "./incoming.js"
import {paging} from "./outgoing.js"

const params=z.strictObject(paging)
function readBody(raw:unknown) {
  const body=z.strictObject({xml:z.string().min(1)}).safeParse(raw)
  if(!body.success)throw new Problem(422,"invalid_input","Envie o XML completo da nota")
  return body.data
}
const fields=`id,access_key AS "accessKey",issuer_document AS "issuerDocument",issuer_name AS "issuerName",recipient_document AS "recipientDocument",
  recipient_name AS "recipientName",number,series,issued_at AS "issuedAt",total_cents AS "totalCents",item_count AS "itemCount",
  environment,xml_sha256 AS "xmlSha256",created_at AS "createdAt"`
const pdfInput=(xml:string,key:string,issuer:string,env:number)=>({xml,accessKey:key,issuerTaxId:issuer,environment:env===1?"production":"homologation"})
function headers(reply:FastifyReply,key:string,xml:string,env:number,pdf?:Buffer) {
  if(pdf)reply.header("x-pdf-sha256",sha256(pdf)).header("x-nfe-authorization-check","xml-protocol-only")
  return reply.header("cache-control","no-store").header("x-content-type-options","nosniff").header("x-xml-sha256",sha256(xml)).header("x-nfe-environment",env)
    .header("content-disposition",'attachment; filename="'+(pdf?"DANFE":"NFE")+"-"+key+(pdf?'.pdf"':'.xml"')).type(pdf?"application/pdf":"application/xml; charset=utf-8")
}
export function metadata(xml:string,archive=true) {
  const root=parseXml(xml)
  if(root.localName!=="nfeProc" || root.namespaceURI!==ns)invalid("Envie um XML autorizado completo")
  const info=child(child(root,"NFe"),"infNFe"),ide=child(info,"ide"),emit=child(info,"emit"),dest=children(info,"dest")[0],prot=child(child(root,"protNFe"),"infProt")
  const key=(info.getAttribute("Id")||"").slice(3),env=Number(value(ide,"tpAmb")),issuer=children(emit,"CNPJ").length?value(emit,"CNPJ"):value(emit,"CPF")
  const model=value(ide,"mod")
  if(!(key55(key) || !archive && /^\d{44}$/.test(key) && key.slice(20,22)==="65" && checkDigit(key.slice(0,43))===Number(key[43])) || info.getAttribute("Id")!=="NFe"+key || ![1,2].includes(env) || model!==key.slice(20,22) || value(prot,"tpAmb")!==String(env) ||
    !["100","150"].includes(value(prot,"cStat")) || value(prot,"chNFe")!==key || key.slice(6,20)!==issuer.padStart(14,"0"))invalid("A autorização, o ambiente ou a chave divergem do XML")
  const number=Number(value(ide,"nNF")),series=Number(value(ide,"serie")),issuedAt=value(ide,"dhEmi"),total=fiscalDecimal(value(child(child(info,"total"),"ICMSTot"),"vNF"),2)
  const quantity=children(info,"det").length
  if(number!==Number(key.slice(25,34)) || series!==Number(key.slice(22,25)) || !Number.isFinite(Date.parse(issuedAt)) || total>99999999999999n || !quantity || quantity>990)invalid("Identificação ou totais da NF-e inválidos")
  if(archive && !dest)invalid("Confira o destinatário da NF-e de saída")
  const recipient=dest && children(dest,"CNPJ").length ? value(dest,"CNPJ"):dest && children(dest,"CPF").length?value(dest,"CPF"):null
  return {key,env,issuer,recipient,issuerName:value(emit,"xNome"),recipientName:dest && children(dest,"xNome").length?value(dest,"xNome"):"Consumidor não identificado",number,series,issuedAt,total,quantity,direction:value(ide,"tpNF")}
}
async function tenantTax(c:AuthorizedContext){return (await c.client.query("SELECT tax_id FROM tenants WHERE id=$1",[c.tenantId])).rows[0]!.tax_id}
export function registerOutgoingImports(app:FastifyInstance,deps:AccessDependencies,render=renderDanfe) {
  const path="/api/v1/fiscal/outgoing-imports"
  app.get(path,async(r,reply)=>authorizeRequest(r,deps,async c=>{
    requirePermission(c,"fiscal.nfe.read")
    const parsed=params.safeParse(r.query)
    if(!parsed.success || parsed.data.from && parsed.data.to && parsed.data.from>parsed.data.to)throw new Problem(422,"invalid_input","Confira os filtros da consulta")
    const {q,from,to,limit,offset}=parsed.data
    const row=(await c.client.query(`WITH found AS MATERIALIZED (SELECT ${fields} FROM fiscal_outgoing_imports
      WHERE tenant_id=$1 AND strpos(lower(concat_ws(' ',recipient_name,recipient_document,issuer_name,issuer_document,access_key,number)),lower($2))>0
        AND ($3::date IS NULL OR issued_at>=($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo')) AND ($4::date IS NULL OR issued_at<(($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))),
      page AS (SELECT * FROM found ORDER BY "issuedAt" DESC,id DESC LIMIT $5 OFFSET $6)
      SELECT (SELECT count(*)::int FROM found) AS total,coalesce(jsonb_agg(to_jsonb(page) ORDER BY "issuedAt" DESC,id DESC),'[]') AS data FROM page`,[c.tenantId,q,from,to,limit,offset])).rows[0]
    return reply.header("cache-control","no-store").send({tenantId:c.tenantId,canImport:c.permissions.includes("fiscal.nfe.manage"),...row})
  }))
  for(const mode of ["detail","xml","danfe"] as const)app.get<{Params:{id:string}}>(path+"/:id"+(mode==="detail"?"":"/"+mode),async(r,reply)=>{
    const id=signedId(r.params.id)
    const result=await authorizeRequest(r,deps,async c=>{
      requirePermission(c,"fiscal.nfe.read")
      const row=(await c.client.query<{xml:string;data:{accessKey:string;issuerDocument:string;xmlSha256:string;environment:number}}>(`SELECT ${mode==="detail"?"NULL::text":"n.xml"} AS xml,to_jsonb(d) AS data FROM fiscal_outgoing_imports n
        CROSS JOIN LATERAL(SELECT ${fields}) d WHERE n.tenant_id=$1 AND n.id=$2`,[c.tenantId,id])).rows[0]
      if(!row)throw new Problem(404,"not_found","Nota importada não encontrada")
      return {...row,tenantId:c.tenantId}
    })
    const {data,xml}=result
    if(mode==="detail")return reply.header("cache-control","no-store").send({tenantId:result.tenantId,data})
    if(sha256(xml)!==data.xmlSha256)throw new Problem(409,"document_conflict","Integridade do XML não confirmada")
    const pdf=mode==="danfe"?await render(pdfInput(xml,data.accessKey,data.issuerDocument,data.environment)):undefined
    if(pdf)await authorizeRequest(r,deps,async c=>requirePermission(c,"fiscal.nfe.read"))
    return headers(reply,data.accessKey,xml,data.environment,pdf).send(pdf??xml)
  })
  app.post(path+"/import",async(r,reply)=>{
    const {xml}=readBody(r.body),n=metadata(xml),digest=sha256(xml)
    if(n.direction!=="1")invalid("O arquivo deve corresponder a uma NF-e de saída")
    const existing=async(c:AuthorizedContext)=>{
      requirePermission(c,"fiscal.nfe.manage")
      if(n.issuer!==await tenantTax(c))throw new Problem(403,"document_company_mismatch","A empresa ativa deve ser emitente desta NF-e")
      if((await c.client.query("SELECT id FROM fiscal_nfe_documents WHERE tenant_id=$1 AND access_key=$2",[c.tenantId,n.key])).rows.length)throw new Problem(409,"outgoing_issuance_exists","A chave já pertence a uma emissão desta empresa")
      const saved=(await c.client.query<{data:{xmlSha256:string}}>(`SELECT to_jsonb(d) AS data FROM (SELECT ${fields} FROM fiscal_outgoing_imports WHERE tenant_id=$1 AND access_key=$2) d`,[c.tenantId,n.key])).rows[0]?.data
      if(saved && saved.xmlSha256!==digest)throw new Problem(409,"outgoing_import_conflict","A chave já foi importada com outro conteúdo")
      return saved
    }
    const prior=await authorizeRequest(r,deps,existing,false)
    if(prior)return reply.header("cache-control","no-store").send(prior)
    await render(pdfInput(xml,n.key,n.issuer,n.env))
    const saved=await authorizeRequest(r,deps,async c=>{
      const duplicate=await existing(c)
      if(duplicate)return {data:duplicate,created:false}
      const result=(await c.client.query<{data:{id:number}}>(`WITH added AS (INSERT INTO fiscal_outgoing_imports(tenant_id,access_key,issuer_document,issuer_name,recipient_document,recipient_name,number,series,issued_at,total_cents,item_count,environment,xml,xml_sha256,imported_by_identity_id)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,id FROM identities WHERE auth_subject=$15 RETURNING ${fields})
        SELECT to_jsonb(added) AS data FROM added`,[c.tenantId,n.key,n.issuer,n.issuerName,n.recipient,n.recipientName,n.number,n.series,n.issuedAt,n.total,n.quantity,n.env,xml,digest,c.authSubject])).rows[0]!.data
      await c.client.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,entity_id,request_id,details) SELECT $1,id,'fiscal.outgoing_import.imported','fiscal_outgoing_import',$2,$3,$4 FROM identities WHERE auth_subject=$5",[c.tenantId,String(result.id),r.headers["x-request-id"],{accessKey:n.key,xmlSha256:digest},c.authSubject])
      return {data:result,created:true}
    })
    return reply.code(saved.created?201:200).header("cache-control","no-store").send(saved.data)
  })
  app.post("/api/v1/fiscal/danfe",async(r,reply)=>{
    const {xml}=readBody(r.body),n=metadata(xml,false)
    const access=async(c:AuthorizedContext)=>{requirePermission(c,"fiscal.nfe.read");const tax=await tenantTax(c);if(tax!==n.issuer && tax!==n.recipient)throw new Problem(403,"document_company_mismatch","Confira o emitente e o destinatário da empresa")}
    await authorizeRequest(r,deps,access,false)
    const pdf=await render(pdfInput(xml,n.key,n.issuer,n.env))
    await authorizeRequest(r,deps,access,false)
    return headers(reply,n.key,xml,n.env,pdf).send(pdf)
  })
}
