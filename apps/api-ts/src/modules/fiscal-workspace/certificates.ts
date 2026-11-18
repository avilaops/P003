import {createHash} from "node:crypto"
import type {FastifyInstance} from "fastify"
import {z} from "zod"
import type {AppDependencies} from "../../app.js"
import {authorizeRequest,requirePermission,type AuthorizedContext} from "../../platform/access.js"
import {record} from "../../platform/commands.js"
import {nextRevision,revisionValue} from "../../platform/revision.js"
import {Problem} from "../../platform/problem.js"
import {certificateStatus} from "./drafts.js"
import {initialRevision} from "./settings.js"
import {metadataSchema} from "../outgoing-nfse/certificate-vault.js"

const payload=z.strictObject({pkcs12Base64:z.string().max(87384),password:z.string().max(1024).refine(v=>!v.includes("\0"))})
async function current(c:AuthorizedContext){
  requirePermission(c,"fiscal.config.read");requirePermission(c,"fiscal.certificate.manage")
  const row=(await c.client.query("SELECT t.tax_id,a.revision,a.metadata FROM tenants t LEFT JOIN fiscal_a1_certificates a ON t.id=a.tenant_id WHERE t.id=$1",[c.tenantId])).rows[0]!
  return {taxId:String(row.tax_id),revision:revisionValue(row.revision??0),present:!!row.metadata}
}
const stale=()=>new Problem(412,"revision_conflict","O certificado foi alterado")
export function registerCertificates(app:FastifyInstance,deps:AppDependencies){
  const path="/api/v1/fiscal/certificate"
  app.put(path,{bodyLimit:128*1024},async(r,reply)=>{
    const expected=initialRevision(r.headers["if-match"]),before=await authorizeRequest(r,deps,current,false)
    if(before.revision!==expected)throw stale()
    const flow=deps.fiscalOperations,vault=deps.fiscalVault
    if(!flow || !vault)throw new Problem(503,"certificate_storage_unavailable","Configure o cofre e o verificador fiscal privado")
    const parsed=payload.safeParse(r.body)
    if(!parsed.success)throw new Problem(422,"invalid_certificate","Envie o PFX e a senha")
    const bytes=Buffer.from(parsed.data.pkcs12Base64,"base64")
    try{
      if(!bytes.length || bytes.length>65536 || bytes.toString("base64")!==parsed.data.pkcs12Base64)throw new Problem(422,"invalid_certificate","O certificado deve ser um PFX de até 64 KiB")
      const proof=metadataSchema.safeParse(await flow.call("verify-a1",{issuerTaxId:before.taxId,certificate:parsed.data}))
      if(!proof.success || proof.data.taxId!==before.taxId || proof.data.validFrom>Date.now()/1000 || proof.data.validUntil<=Date.now()/1000)throw new Problem(422,"invalid_certificate","Confira senha, CNPJ, validade e cadeia ICP-Brasil do A1")
      const next=nextRevision(expected),meta=proof.data
      const answer=await authorizeRequest(r,deps,async c=>{
        const active=await current(c)
        if(active.revision!==expected || active.taxId!==before.taxId)throw stale()
        const aad="avila-erp:fiscal-a1:v1:"+c.tenantId+":"+next+":"+createHash("sha256").update(JSON.stringify(meta)).digest("hex")
        const plain=Buffer.from(JSON.stringify({pkcs12:[...bytes],password:parsed.data.password}))
        try{
          const sealed=vault.seal(aad,plain)
          await c.client.query(`INSERT INTO fiscal_a1_certificates(tenant_id,revision,metadata,encryption_key_id,nonce,ciphertext,updated_by_identity_id)
            VALUES($1,$2,$3,$4,$5,$6,(SELECT id FROM identities WHERE auth_subject=$7))
            ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,metadata=excluded.metadata,encryption_key_id=excluded.encryption_key_id,
              nonce=excluded.nonce,ciphertext=excluded.ciphertext,updated_by_identity_id=excluded.updated_by_identity_id,updated_at=clock_timestamp()`,[c.tenantId,next,meta,sealed.keyId,sealed.nonce,sealed.ciphertext,c.authSubject])
        }finally{plain.fill(0)}
        await record(c,r.headers,"fiscal_certificate",c.tenantId,"fiscal.certificate.updated",{revision:next,fingerprint:meta.fingerprint,validUntil:meta.validUntil})
        return certificateStatus(c,deps)
      })
      return reply.header("etag",'"'+next+'"').header("cache-control","no-store").send(answer)
    }finally{bytes.fill(0)}
  })
  app.delete(path,async(r,reply)=>{
    const result=await authorizeRequest(r,deps,async c=>{
      const active=await current(c)
      if(active.revision!==initialRevision(r.headers["if-match"]))throw stale()
      if(!active.present)throw new Problem(404,"not_found","Certificado não encontrado")
      const next=nextRevision(active.revision)
      await c.client.query("UPDATE fiscal_a1_certificates SET revision=$2,metadata=NULL,encryption_key_id=NULL,nonce=NULL,ciphertext=NULL,updated_by_identity_id=(SELECT id FROM identities WHERE auth_subject=$3),updated_at=clock_timestamp() WHERE tenant_id=$1",[c.tenantId,next,c.authSubject])
      await record(c,r.headers,"fiscal_certificate",c.tenantId,"fiscal.certificate.removed",{revision:next})
      return certificateStatus(c,deps)
    })
    return reply.header("cache-control","no-store").header("etag",'"'+result.revision+'"').send(result)
  })
}
