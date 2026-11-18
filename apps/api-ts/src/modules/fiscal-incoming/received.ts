import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission,type AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { sha256 } from "../nfe-email/danfe.js"
import { inspectInvoice } from "./xml.js"

export const prefix="/api/v1/fiscal"
export const manage="fiscal.received_nfe.manage"
export const notFound=():never=>{throw new Problem(404,"not_found","Registro fiscal não encontrado nesta empresa")}
export function conflict(title:string):never {throw new Problem(409,"domain_conflict",title)}
export async function recipient(c:AuthorizedContext) {
  return String((await c.client.query("SELECT tax_id FROM tenants WHERE id=$1",[c.tenantId])).rows[0]!.tax_id)
}
export function signedId(raw:string) {
  if(!/^[1-9]\d{0,18}$/.test(raw)||BigInt(raw)>9223372036854775807n) throw new Problem(422,"invalid_input","Número de registro inválido")
  return raw
}
export async function storeReceived(c:AuthorizedContext,headers:Parameters<typeof record>[1],xml:string,tax:string,environment?:number) {
  const note=inspectInvoice(xml,tax)
  if(environment && environment!==note.environment) conflict("Ambiente do XML diferente da distribuição")
  const digest=sha256(xml)
  const existing=(await c.client.query("SELECT id,xml_sha256 FROM fiscal_received_nfes WHERE tenant_id=$1 AND access_key=$2",[c.tenantId,note.key])).rows[0]
  if(existing && existing.xml_sha256!==digest) conflict("Chave de acesso já importada com outro conteúdo")
  const id=existing?.id ?? (await c.client.query(`INSERT INTO fiscal_received_nfes(tenant_id,access_key,issuer_document,issuer_name,recipient_document,number,series,issued_at,total_cents,item_count,environment,xml,xml_sha256,imported_by_identity_id) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,id FROM identities WHERE auth_subject=$14 RETURNING id`,[c.tenantId,note.key,note.issuer,note.name,note.recipient,note.number,note.series,note.issuedAt,note.total,note.items.length,note.environment,xml,digest,c.authSubject])).rows[0]!.id
  const snapshot=(await c.client.query(`SELECT jsonb_build_object('id',id,'accessKey',access_key,'issuerDocument',issuer_document,'issuerName',issuer_name,'recipientDocument',recipient_document,'number',number,'series',series,'issuedAt',issued_at,'totalCents',total_cents,'itemCount',item_count,'environment',environment,'xmlSha256',xml_sha256,'createdAt',created_at) AS data FROM fiscal_received_nfes WHERE tenant_id=$1 AND id=$2`,[c.tenantId,id])).rows[0]!.data
  if(!existing) await record(c,headers,"fiscal_received_nfe",String(id),"fiscal.received_nfe.imported",{accessKey:note.key,environment:note.environment,xmlSha256:digest})
  return {id:String(id),snapshot,replayed:!!existing}
}
export function registerReceivedImport(app:FastifyInstance,deps:AppDependencies) {
  app.post(prefix+"/received-nfes/import",{bodyLimit:1048576},async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,manage)
      const input=z.strictObject({xml:z.string().min(1)}).safeParse(req.body)
      if(!input.success) throw new Problem(422,"invalid_input","Envie um XML de NF-e autorizada")
      return storeReceived(c,req.headers,input.data.xml,await recipient(c))
    })
    if(result.replayed) reply.header("idempotency-replayed","true")
    return reply.code(result.replayed?200:201).header("cache-control","no-store").send(result.snapshot)
  })
}
