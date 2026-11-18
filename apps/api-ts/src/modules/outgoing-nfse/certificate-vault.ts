import { createCipheriv,createDecipheriv, createHash,randomBytes } from "node:crypto"
import { z } from "zod"

import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import type { CertificateMaterial } from "./engine-client.js"

const keyringSchema = z.object({
  active: z.string(),
  keys: z.record(z.string(), z.string()),
}).strict()

type Metadata = {
  subject: string
  issuer: string
  taxId: string
  fingerprint: string
  serialNumber: string
  validFrom: number
  validUntil: number
  validatedAt: number
  chainVerified: boolean
  revocationChecked: boolean
}

export const metadataSchema = z.object({
  subject: z.string(), issuer: z.string(), taxId: z.string().regex(/^\d{14}$/), fingerprint: z.string(), serialNumber: z.string(),
  validFrom: z.number().int(), validUntil: z.number().int(), validatedAt: z.number().int(), chainVerified: z.literal(true), revocationChecked: z.boolean(),
}).strict()

export class FiscalCertificateVault {
  private readonly active:string
  private readonly keys: ReadonlyMap<string, Buffer>

  constructor(keyringJson: string) {
    const keyring = keyringSchema.parse(JSON.parse(keyringJson))
    this.active=keyring.active
    this.keys = new Map(Object.entries(keyring.keys).map(([id, encoded]) => {
      const key = Buffer.from(encoded, "base64")
      if (key.length !== 32) throw new Error("Fiscal A1 encryption keys require 32 bytes")
      return [id, key]
    }))
    if (!this.keys.has(keyring.active)) throw new Error("Active fiscal A1 key is missing")
  }

  seal(context:string,plaintext:Buffer) {
    const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",this.keys.get(this.active)!,nonce)
    cipher.setAAD(Buffer.from(context))
    return {keyId:this.active,nonce,ciphertext:Buffer.concat([cipher.update(plaintext),cipher.final(),cipher.getAuthTag()])}
  }

  async nfceSecret(context:AuthorizedContext, environment:string) {
    const row=(await context.client.query<{data:{cscId:string;environment:string;cscConfigured:boolean;state:string};tax_id:string;secret_key_id:string;secret_context:string;secret_nonce:Buffer;secret_ciphertext:Buffer}>(`SELECT p.data,t.tax_id,p.secret_key_id,p.secret_context,p.secret_nonce,p.secret_ciphertext
      FROM fiscal_preferences p JOIN tenants t ON t.id=p.tenant_id WHERE p.tenant_id=$1 AND p.section='nfce'`,[context.tenantId])).rows[0]
    const invalid=()=>new Problem(409,"nfce_csc_unavailable","O CSC da NFC-e está indisponível no ambiente da empresa")
    if (!row || row.data.environment!==environment || row.data.state!=="SP" || row.data.cscConfigured!==true || !row.secret_context?.startsWith(`avila-erp:nfce-csc:v1:${context.tenantId}:${row.tax_id}:${environment}:${row.data.cscId}:`)) throw invalid()
    const key=this.keys.get(row.secret_key_id)
    if (!key || row.secret_nonce?.length!==12 || !row.secret_ciphertext || row.secret_ciphertext.length<=16) throw invalid()
    try {
      const cipher=createDecipheriv("aes-256-gcm",key,row.secret_nonce)
      cipher.setAAD(Buffer.from(row.secret_context))
      cipher.setAuthTag(row.secret_ciphertext.subarray(-16))
      const value=Buffer.concat([cipher.update(row.secret_ciphertext.subarray(0,-16)),cipher.final()])
      try { return {version:"2",csc:{id:row.data.cscId,secret:value.toString("utf8")}} } finally {value.fill(0)}
    } catch {throw invalid()}
  }

  async material(context: AuthorizedContext): Promise<{ issuerTaxId: string; certificate: CertificateMaterial }> {
    const result = await context.client.query<{ tax_id: string; revision: string | number; metadata: unknown; encryption_key_id: string; nonce: Buffer; ciphertext: Buffer }>(
      "SELECT tenant.tax_id,certificate.revision,certificate.metadata,certificate.encryption_key_id,certificate.nonce,certificate.ciphertext FROM tenants tenant JOIN fiscal_a1_certificates certificate ON certificate.tenant_id=tenant.id WHERE tenant.id=$1",
      [context.tenantId],
    )
    const row = result.rows[0]
    if (!row) throw new Problem(409, "fiscal_certificate_missing", "Certificado A1 não configurado")
    const metadata = metadataSchema.parse(row.metadata) as Metadata
    const now = Math.floor(Date.now() / 1000)
    if (metadata.taxId !== row.tax_id || metadata.validFrom > now || metadata.validUntil <= now) {
      throw new Problem(409, "fiscal_certificate_invalid", "Certificado A1 inválido, vencido ou de outra empresa")
    }
    const key = this.keys.get(row.encryption_key_id)
    if (!key || row.nonce.length !== 12 || row.ciphertext.length <= 16) throw new Problem(503, "fiscal_certificate_unavailable", "Cofre de certificados indisponível")
    const orderedMetadata: Metadata = {
      subject: metadata.subject, issuer: metadata.issuer, taxId: metadata.taxId, fingerprint: metadata.fingerprint,
      serialNumber: metadata.serialNumber, validFrom: metadata.validFrom, validUntil: metadata.validUntil,
      validatedAt: metadata.validatedAt, chainVerified: metadata.chainVerified, revocationChecked: metadata.revocationChecked,
    }
    const metadataBytes = Buffer.from(JSON.stringify(orderedMetadata))
    const aad = Buffer.from(`avila-erp:fiscal-a1:v1:${context.tenantId}:${row.revision}:${createHash("sha256").update(metadataBytes).digest("hex")}`)
    const tagOffset = row.ciphertext.length - 16
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, row.nonce)
      decipher.setAAD(aad)
      decipher.setAuthTag(row.ciphertext.subarray(tagOffset))
      const plaintext = Buffer.concat([decipher.update(row.ciphertext.subarray(0, tagOffset)), decipher.final()])
      const material = z.object({ pkcs12: z.array(z.number().int().min(0).max(255)), password: z.string().max(1024) }).strict().parse(JSON.parse(plaintext.toString("utf8")))
      return { issuerTaxId: row.tax_id, certificate: { pkcs12Base64: Buffer.from(material.pkcs12).toString("base64"), password: material.password } }
    } catch {
      throw new Problem(503, "fiscal_certificate_unavailable", "Não foi possível abrir o certificado A1")
    }
  }
}
