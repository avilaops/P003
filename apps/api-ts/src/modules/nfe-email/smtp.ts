import { createDecipheriv } from "node:crypto"
import nodemailer from "nodemailer"
import { documentMailConfigured, sendDocumentMail } from "../../platform/document-mail.js"
import { renderDocumentEmail } from "../../platform/document-mail-template.js"
import { z } from "zod"
import type { DatabaseClient } from "../../platform/database.js"
import { Problem } from "../../platform/problem.js"

const security = z.enum(["starttls", "tls"])
const storedSettings = z.object({
  enabled: z.boolean(), host: z.string().min(1), port: z.number().int().positive().max(65535),
  security, username: z.string().min(1), fromName: z.string(), fromAddress: z.email(),
})
type SettingsRow = {
  data: unknown; secret_context: string; secret_key_id: string; secret_nonce: Buffer; secret_ciphertext: Buffer
}
const unavailable = () => new Problem(503, "smtp_unavailable", "Configure o SMTP em Preferências do sistema • E-mail para enviar a NF-e")
export type Envelope = {
  id: string; recipient: string; number: string; series: number; environment: string; accessKey: string; xml: Buffer; pdf: Buffer | null; kind?: "nfe" | "nfce" | "received-nfses" | "outgoing-nfses"
  company: string; recipientName?: string | null; providerName?: string | null
}
export type Outcome = "sent" | "failed" | "unknown"
export type Sender = (envelope: Envelope) => Promise<Outcome>

function environmentSettings(env: NodeJS.ProcessEnv) {
  const mode = security.safeParse(env.SMTP_SECURITY || "starttls")
  if (!mode.success) return null
  const port = Number(env.SMTP_PORT || (mode.data === "tls" ? 465 : 587))
  if (!env.SMTP_HOST || !env.SMTP_USERNAME || !env.SMTP_PASSWORD || !env.SMTP_FROM ||
      !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: env.SMTP_HOST, port, security: mode.data, username: env.SMTP_USERNAME,
    password: env.SMTP_PASSWORD, from: env.SMTP_FROM }
}

export async function smtpConfigured(client: DatabaseClient, env = process.env) {
  if (documentMailConfigured(env)) return true
  const row = (await client.query<{ enabled: boolean }>(
    "SELECT (data->>'enabled')::boolean AS enabled FROM platform_mail_settings WHERE singleton",
  )).rows[0]
  return row ? row.enabled : environmentSettings(env) !== null
}

function openSettings(row: SettingsRow, keyring: string | undefined) {
  try {
    const data = storedSettings.parse(row.data)
    const aad = JSON.stringify(["platform.smtp.v1", data.host, data.port, data.security, data.username])
    if (!data.enabled || !keyring || aad !== row.secret_context || row.secret_nonce.length !== 12) throw unavailable()
    const keys = z.record(z.string(), z.string()).parse(JSON.parse(keyring).keys)
    const key = Buffer.from(keys[row.secret_key_id]!, "base64")
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, row.secret_nonce)
      decipher.setAAD(Buffer.from(aad))
      decipher.setAuthTag(row.secret_ciphertext.subarray(-16))
      const plaintext = Buffer.concat([decipher.update(row.secret_ciphertext.subarray(0, -16)), decipher.final()])
      try { return { ...data, password: plaintext.toString("utf8"), from: { name: data.fromName, address: data.fromAddress } } }
      finally { plaintext.fill(0) }
    } finally { key.fill(0) }
  } catch { throw unavailable() }
}

// A transport disconnect after DATA can happen after the relay accepted the message.
export function smtpFailure(error: unknown): Outcome {
  const detail = error as { code?: string; responseCode?: number; command?: string } | null
  if (detail?.responseCode && detail.responseCode >= 400 && detail.responseCode < 600) return "failed"
  if (["EAUTH", "EENVELOPE", "EDNS", "ETLS", "ECONNREFUSED", "ENOTFOUND"].includes(detail?.code ?? "") ||
      ["EHLO", "HELO", "STARTTLS", "MAIL FROM", "RCPT TO"].includes(detail?.command ?? "")) return "failed"
  return "unknown"
}

const fiscalMessages = {
  nfe: { label: "NF-e", body: "Encaminhamos o XML autorizado da nota fiscal eletrônica." },
  nfce: { label: "NFC-e", body: "Segue o XML autorizado da nota fiscal de consumidor eletrônica referente à sua compra." },
  "outgoing-nfses": { label: "NFS-e emitida", body: "Segue o XML autorizado da nota fiscal referente ao serviço que prestamos." },
  "received-nfses": { label: "NFS-e recebida", body: "Encaminhamos para seu arquivo o XML original importado da nota fiscal de serviço. Nossa empresa consta como tomadora do serviço." },
}

function fiscalName(value?: string | null) {
  const name = value?.replace(/[\r\n\0]+/g, " ").trim()
  // SEFAZ may replace the recipient's name with a test-environment message.
  return name && !/SEM VALOR FISCAL|EM AMBIENTE DE HOMOLOGA[ÇC][ÃA]O|CONSUMIDOR N[ÃA]O IDENTIFICADO/i.test(name) ? name : ""
}

export function nfeMessage(envelope: Envelope) {
  const kind = envelope.kind ?? "nfe"
  const service = kind === "received-nfses" || kind === "outgoing-nfses"
  const { label, body } = fiscalMessages[kind]
  const title = label + " nº " + envelope.number + (service ? "" : " • Série " + envelope.series)
  const notice = envelope.environment === "homologation" ? "Homologação • sem valor fiscal" : undefined
  const name = fiscalName(envelope.recipientName)
  const provider = kind === "received-nfses" && fiscalName(envelope.providerName)
  const details = [{ label: "Chave de acesso", value: envelope.accessKey }]
  if (provider) details.push({ label: "Prestador do serviço", value: provider })
  const attachments = [
    { filename: service ? `NFSE-${envelope.accessKey}.xml` : `${envelope.accessKey}-procNFe.xml`, content: envelope.xml, contentType: "application/xml" },
    ...(envelope.pdf ? [{ filename: `DANFE-${envelope.accessKey}.pdf`, content: envelope.pdf, contentType: "application/pdf" }] : []),
  ]
  const message = [name ? `Olá, ${name}.` : "Olá.", body + (envelope.pdf ? " O DANFE em PDF também está anexo para consulta." : "")].join("\n\n")
  return {
    to: { name, address: envelope.recipient },
    messageId: `<${envelope.id}@nfe.avilaops.com>`,
    subject: [title, notice, envelope.company].filter(Boolean).join(" • ").replace(/[\r\n\0]+/g, " ").slice(0, 250).trimEnd(),
    ...renderDocumentEmail({ company: envelope.company, title, message, attachments, details, ...(notice && { notice }) }),
    attachments,
  }
}

export async function resolveSender(client: DatabaseClient, env = process.env, request = fetch): Promise<Sender> {
  if (documentMailConfigured(env)) return async envelope => {
    const { subject, text, html, attachments } = nfeMessage(envelope)
    return sendDocumentMail({ id: envelope.id, to: envelope.recipient, subject, text, html, attachments }, request, env)
  }
  const row = (await client.query<SettingsRow>(
    "SELECT data,secret_context,secret_key_id,secret_nonce,secret_ciphertext FROM platform_mail_settings WHERE singleton",
  )).rows[0]
  const settings = row ? openSettings(row, env.FISCAL_A1_KEYRING) : environmentSettings(env)
  if (!settings) throw unavailable()
  const mail = nodemailer.createTransport({
    host: settings.host, port: settings.port, secure: settings.security === "tls", requireTLS: settings.security === "starttls",
    auth: { user: settings.username, pass: settings.password }, disableFileAccess: true, disableUrlAccess: true,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  })
  return async (envelope: Envelope) => {
    try {
      const receipt = await mail.sendMail({ from: settings.from, ...nfeMessage(envelope) })
      const recipient = envelope.recipient.toLowerCase()
      if (receipt.accepted.some(address => address.toLowerCase() === recipient)) return "sent"
      return receipt.rejected.some(address => address.toLowerCase() === recipient) ? "failed" : "unknown"
    } catch (error) { return smtpFailure(error) }
    finally { mail.close() }
  }
}
