import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { z } from "zod"
import { validDocument } from "../parties/schema.js"
import { Problem } from "../../platform/problem.js"
import { readConfigurationFile } from "./validator-config.js"

export function normalizeCpf(input: string) {
  if (!/^(?:\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/.test(input)) return undefined
  const cpf = input.replace(/[.-]/g, "")
  return validDocument(cpf, "fisica") ? cpf : undefined
}

export type FrozenIdentity = { identity_key_id: string; identity_nonce: Buffer; identity_ciphertext: Buffer }
export type IdentityKeyring = { active: string; keys: Map<string, Buffer> }

const schema = z.strictObject({ active: z.string(), keys: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), z.string()) })
const fail = () => new Problem(503, "contract_identity_unavailable", "As chaves de proteção dos participantes estão indisponíveis")

export function identityKeyring(env: NodeJS.ProcessEnv = process.env): IdentityKeyring {
  const path = env.ERP_CONTRACT_IDENTITY_KEYRING_FILE
  if (!path) throw fail()
  try {
    const bytes = readConfigurationFile(path, 16384, true)
    try {
      const text = bytes.toString("utf8")
      const ring = schema.parse(JSON.parse(text))
      const entries = Object.entries(ring.keys)
      const members = text.match(/"(?:\\.|[^"\\])*"|[{}:,]/g)?.filter(token => token === ":").length
      if (members !== entries.length + 2 || entries.length < 1 || entries.length > 10 || !Object.hasOwn(ring.keys, ring.active)) throw fail()
      const keys = new Map<string, Buffer>()
      for (const [id, value] of entries) {
        const key = Buffer.from(value, "base64")
        if (key.length !== 32 || key.toString("base64") !== value) throw fail()
        keys.set(id, key)
      }
      return { active: ring.active, keys }
    } finally { bytes.fill(0) }
  } catch { throw fail() }
}

const aad = (tenant: string, envelope: string, participant: string, keyId: string) =>
  Buffer.from(["AVILA-CONTRACT-IDENTITY/1", tenant, envelope, participant, keyId, ""].join("\n"))

export function sealCpf(ring: IdentityKeyring, tenant: string, envelope: string, participant: string, cpf: string): FrozenIdentity {
  const nonce = randomBytes(12)
  const key = ring.keys.get(ring.active)
  if (!key || normalizeCpf(cpf) !== cpf) throw fail()
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(aad(tenant, envelope, participant, ring.active))
  return { identity_key_id: ring.active, identity_nonce: nonce,
    identity_ciphertext: Buffer.concat([cipher.update(cpf, "ascii"), cipher.final(), cipher.getAuthTag()]) }
}

export function openCpf(ring: IdentityKeyring, tenant: string, envelope: string, participant: string, identity: FrozenIdentity) {
  try {
    const key = ring.keys.get(identity.identity_key_id)
    if (!key || identity.identity_nonce.length !== 12 || identity.identity_ciphertext.length !== 27) throw fail()
    const decipher = createDecipheriv("aes-256-gcm", key, identity.identity_nonce)
    decipher.setAAD(aad(tenant, envelope, participant, identity.identity_key_id))
    decipher.setAuthTag(identity.identity_ciphertext.subarray(11))
    const plain = Buffer.concat([decipher.update(identity.identity_ciphertext.subarray(0, 11)), decipher.final()])
    try {
      const cpf = normalizeCpf(plain.toString("utf8"))
      if (!cpf) throw fail()
      return cpf
    } finally { plain.fill(0) }
  } catch { throw fail() }
}
