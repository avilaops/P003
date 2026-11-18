import { z } from "zod"

export type MailOutcome = "sent" | "failed" | "unknown"
export type DocumentMail = {
  id: string
  to: string | string[]
  subject: string
  text: string
  html?: string
  attachments: { filename: string; contentType: string; content: Buffer }[]
}

export const documentMailLimit = 10 * 1024 * 1024
const allowedType = /^(?:application\/(?:pdf|xml)|text\/(?:xml|html))(?:\s*;\s*charset=utf-8)?$/i
const recipient = z.email().max(254)

function configuration(env: NodeJS.ProcessEnv) {
  const token = env.ERP_DOCUMENT_MAIL_N8N_TOKEN
  if (!token || token.length < 32 || /\s/.test(token)) return null
  try {
    const url = new URL(env.ERP_DOCUMENT_MAIL_N8N_URL ?? "")
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null
    return { url, token }
  } catch { return null }
}

export function documentMailConfigured(env = process.env) {
  return configuration(env) !== null
}

export async function sendDocumentMail(mail: DocumentMail, request = fetch, env = process.env): Promise<MailOutcome> {
  const config = configuration(env)
  const recipients = Array.isArray(mail.to) ? mail.to : [mail.to]
  if (!config || !/^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(mail.id) ||
      !recipients.length || recipients.length > 20 || recipients.some(to => !recipient.safeParse(to).success) ||
      !mail.subject.trim() || /[\r\n\0]/.test(mail.subject) || mail.subject.length > 250 ||
      mail.attachments.length > 40 || mail.attachments.some(a => !a.filename.trim() || /[\\/\r\n\0]/.test(a.filename) || !allowedType.test(a.contentType)) ||
      mail.attachments.reduce((size, a) => size + a.content.length, 0) > documentMailLimit) return "failed"
  try {
    const response = await request(config.url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(16_000),
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...mail, attachments: mail.attachments.map(a => ({ ...a, content: a.content.toString("base64") })) }),
    })
    if ([401, 403, 413].includes(response.status)) { await response.body?.cancel(); return "failed" }
    if (response.status !== 200 && response.status !== 422) { await response.body?.cancel(); return "unknown" }
    const result: unknown = await response.json()
    if (!result || typeof result !== "object" || !("id" in result) || result.id !== mail.id || !("status" in result)) return "unknown"
    if (result.status === "failed") return "failed"
    return response.status === 200 && result.status === "sent" ? "sent" : "unknown"
  } catch { return "unknown" }
}
