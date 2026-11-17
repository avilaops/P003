import { createDecipheriv, createHash } from "node:crypto"
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

const metadataSchema = z.object({
  subject: z.string(), issuer: z.string(), taxId: z.string().regex(/^\d{14}$/), fingerprint: z.string(), serialNumber: z.string(),
  validFrom: z.number().int(), validUntil: z.number().int(), validatedAt: z.number().int(), chainVerified: z.literal(true), revocationChecked: z.boolean(),
}).strict()

export class FiscalCertificateVault {
  private readonly keys: ReadonlyMap<string, Buffer>

  constructor(keyringJson: string) {
    const keyring = keyringSchema.parse(JSON.parse(keyringJson))
    this.keys = new Map(Object.entries(keyring.keys).map(([id, encoded]) => {
      const key = Buffer.from(encoded, "base64")
      if (key.length !== 32) throw new Error("Fiscal A1 encryption keys require 32 bytes")
      return [id, key]
    }))
    if (!this.keys.has(keyring.active)) throw new Error("Active fiscal A1 key is missing")
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
