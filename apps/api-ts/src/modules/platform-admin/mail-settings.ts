import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { authenticateRequest, type AccessDependencies } from "../../platform/access.js"
import type { DatabaseClient } from "../../platform/database.js"
import { invalid, staleRevision } from "../../platform/domain.js"
import { Problem } from "../../platform/problem.js"
import type { SettingsSecretVault } from "./secret-vault.js"

export type MailSettingsData = {
  enabled: boolean; name: string; host: string; port: number; security: "starttls" | "tls"
  username: string; fromName: string; fromAddress: string; passwordSet: boolean
}
export type MailSettingsIO = {
  /** Cofre de criptografia da plataforma; sem ele não é possível ativar o SMTP nem salvar senha. */
  vault?: SettingsSecretVault
  /** Configuração SMTP vinda do ambiente, usada enquanto nada foi salvo na plataforma. */
  environment?: MailSettingsData
}

const defaults: MailSettingsData = { enabled: false, name: "", host: "", port: 587, security: "starttls", username: "", fromName: "", fromAddress: "", passwordSet: false }
const updateSchema = z.strictObject({
  enabled: z.boolean(), name: z.string(), host: z.string(), port: z.number().int().min(0).max(65535),
  security: z.enum(["starttls", "tls"]), username: z.string(), fromName: z.string(), fromAddress: z.string(),
  password: z.string().nullable().optional(),
})
const clean = (value: string, maximum: number) => Buffer.byteLength(value) <= maximum && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
// Endereço simples (sem nome de exibição, sem espaços): equivalente prático do `lettre::Address`.
const address = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/
const ADVISORY_LOCK = "7189423471020331"

type Stored = { data: MailSettingsData; revision: string | number; secret_context: string | null; secret_key_id: string | null; secret_nonce: Buffer | null; secret_ciphertext: Buffer | null }

function validate(input: z.infer<typeof updateSchema>): MailSettingsData {
  const host = input.host.trim(), username = input.username.trim(), from = input.fromAddress.trim()
  if (!clean(input.name, 120) || !clean(input.fromName, 160) || !clean(input.fromAddress, 254) || !clean(input.username, 320) || !clean(input.host, 253) || input.port === 0) throw invalid("Configuração SMTP inválida")
  if (host && (!/^[\x00-\x7f]*$/.test(host) || host.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-") || !/^[A-Za-z0-9-]+$/.test(label)))) throw invalid("Informe somente o nome do servidor SMTP")
  if (from && !address.test(from)) throw invalid("E-mail do remetente inválido")
  if (input.enabled && (!host || !username || !from)) throw invalid("Informe servidor, usuário e e-mail do remetente")
  if (input.password && (input.password.length > 4096 || input.password.includes("\0"))) throw invalid("Senha SMTP inválida")
  return { enabled: input.enabled, name: input.name.trim(), host: host.toLowerCase(), port: input.port, security: input.security, username, fromName: input.fromName.trim(), fromAddress: from, passwordSet: false }
}

const secretContext = (data: MailSettingsData) => JSON.stringify(["platform.smtp.v1", data.host, data.port, data.security, data.username])

/** Revisão do singleton: começa em 0 antes do primeiro salvamento; só ETag forte com dígitos. */
function settingsRevision(value: string | string[] | undefined) {
  if (value === undefined) throw new Problem(428, "revision_required", "Recarregue o cadastro antes de salvar")
  const match = typeof value === "string" ? /^"([0-9]+)"$/.exec(value) : null
  if (!match?.[1] || BigInt(match[1]) > 9223372036854775807n) throw new Problem(400, "invalid_revision", "Revisão inválida")
  return BigInt(match[1])
}

async function load(client: DatabaseClient) {
  const result = await client.query<Stored>("SELECT data,revision,secret_context,secret_key_id,secret_nonce,secret_ciphertext FROM platform_mail_settings WHERE singleton")
  return result.rows[0]
}

/** Operação restrita a administradores da plataforma; não depende de empresa ativa. */
async function platformAdministrator<T>(request: Parameters<typeof authenticateRequest>[0], dependencies: AccessDependencies, write: boolean, operation: (client: DatabaseClient) => Promise<T>) {
  const identity = await authenticateRequest(request, dependencies)
  const client = await dependencies.pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.auth_subject',$1,true)", [identity.subject])
    // Serializa a criação e as atualizações; os direitos são relidos depois do bloqueio.
    if (write) await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [ADVISORY_LOCK])
    const allowed = await client.query<{ ok: boolean }>("SELECT EXISTS(SELECT 1 FROM platform_administrators WHERE auth_subject=$1 AND active) AS ok", [identity.subject])
    if (!allowed.rows[0]?.ok) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
    const result = await operation(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    try { await client.query("ROLLBACK") } catch { /* Preserva a falha original. */ }
    throw error
  } finally { client.release() }
}

function snapshot(io: MailSettingsIO, stored: Stored | undefined) {
  const revision = stored ? BigInt(stored.revision) : 0n
  const source = stored ? "platform" : io.environment ? "environment" : "unconfigured"
  const data = stored ? { ...defaults, ...stored.data, passwordSet: stored.secret_ciphertext !== null } : io.environment ?? defaults
  return { revision: Number(revision), source, canManage: true, encryptionReady: io.vault !== undefined, data }
}

export function registerMailSettingsRoutes(app: FastifyInstance, dependencies: AccessDependencies, io: MailSettingsIO = {}) {
  app.get("/api/v1/platform/mail-settings", async (request, reply) => {
    const view = snapshot(io, await platformAdministrator(request, dependencies, false, load))
    return reply.header("cache-control", "no-store").header("etag", `"${view.revision}"`).send(view)
  })

  app.put("/api/v1/platform/mail-settings", async (request, reply) => {
    const stored = await platformAdministrator(request, dependencies, true, async client => {
      const expected = settingsRevision(request.headers["if-match"])
      const parsed = updateSchema.safeParse(request.body)
      if (!parsed.success) throw invalid("Configuração SMTP inválida ou campos desconhecidos")
      const data = validate(parsed.data)
      if (data.enabled && !io.vault) throw invalid("A criptografia da plataforma precisa estar configurada antes de ativar o SMTP")
      const previous = await load(client)
      const current = previous ? BigInt(previous.revision) : 0n
      if (expected !== current) throw staleRevision()
      const context = secretContext(data)
      const supplied = parsed.data.password ? parsed.data.password : undefined
      const oldSealed = previous?.secret_key_id && previous.secret_nonce && previous.secret_ciphertext
        ? { keyId: previous.secret_key_id, nonce: previous.secret_nonce, ciphertext: previous.secret_ciphertext } : undefined
      if (oldSealed && previous?.secret_context !== context && supplied === undefined) throw invalid("Informe uma nova senha ao alterar servidor, porta, segurança ou usuário")
      let sealed = oldSealed
      if (supplied !== undefined) {
        if (!io.vault) throw invalid("A criptografia da plataforma precisa estar configurada antes de salvar uma senha SMTP")
        sealed = io.vault.seal(context, Buffer.from(supplied))
      }
      if (data.enabled && !sealed) throw invalid("Informe a senha SMTP para ativar o envio")
      data.passwordSet = sealed !== undefined
      await client.query(
        `INSERT INTO platform_mail_settings(singleton,data,revision,secret_context,secret_key_id,secret_nonce,secret_ciphertext) VALUES(true,$1,$2,$3,$4,$5,$6)
         ON CONFLICT(singleton) DO UPDATE SET data=EXCLUDED.data,revision=EXCLUDED.revision,secret_context=EXCLUDED.secret_context,secret_key_id=EXCLUDED.secret_key_id,secret_nonce=EXCLUDED.secret_nonce,secret_ciphertext=EXCLUDED.secret_ciphertext,updated_at=now()`,
        [data, (current + 1n).toString(), sealed ? context : null, sealed?.keyId ?? null, sealed?.nonce ?? null, sealed?.ciphertext ?? null])
      return load(client)
    })
    const view = snapshot(io, stored)
    return reply.header("cache-control", "no-store").header("etag", `"${view.revision}"`).send(view)
  })
}
