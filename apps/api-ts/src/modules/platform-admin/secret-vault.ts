import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { z } from "zod"

const keyringSchema = z.strictObject({ active: z.string(), keys: z.record(z.string(), z.string()) })

export type SealedSecret = { keyId: string; nonce: Buffer; ciphertext: Buffer }

/**
 * Cofre de segredos de configuração (AES-256-GCM, AAD = contexto). Mesmo formato
 * do `seal_settings_secret` do Rust: o texto cifrado carrega a tag de 16 bytes no fim.
 * Usa o mesmo chaveiro `FISCAL_A1_KEYRING`.
 */
export class SettingsSecretVault {
  private readonly keys: ReadonlyMap<string, Buffer>
  private readonly active: string

  constructor(keyringJson: string) {
    const keyring = keyringSchema.parse(JSON.parse(keyringJson))
    this.keys = new Map(Object.entries(keyring.keys).map(([id, encoded]) => {
      const key = Buffer.from(encoded, "base64")
      if (key.length !== 32) throw new Error("As chaves de criptografia exigem 32 bytes")
      return [id, key]
    }))
    if (!this.keys.has(keyring.active)) throw new Error("A chave ativa de criptografia não existe")
    this.active = keyring.active
  }

  seal(context: string, plaintext: Buffer): SealedSecret {
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.active)!, nonce)
    cipher.setAAD(Buffer.from(context))
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return { keyId: this.active, nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) }
  }

  open(context: string, sealed: SealedSecret): Buffer {
    const key = this.keys.get(sealed.keyId)
    if (!key || sealed.nonce.length !== 12 || sealed.ciphertext.length < 16) throw new Error("Segredo indisponível")
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce)
    decipher.setAAD(Buffer.from(context))
    decipher.setAuthTag(sealed.ciphertext.subarray(sealed.ciphertext.length - 16))
    return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16)), decipher.final()])
  }
}
