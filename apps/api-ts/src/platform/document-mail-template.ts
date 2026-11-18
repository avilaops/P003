import type { AuthorizedContext } from "./access.js"
import { Problem } from "./problem.js"

type DocumentEmail = {
  company: string
  title: string
  message: string
  attachments: readonly { filename: string }[]
  details?: readonly { label: string; value: string }[]
  notice?: string
}

export async function documentMailCompany({ client, tenantId }: Pick<AuthorizedContext, "client" | "tenantId">) {
  const { rows } = await client.query<{ name: string }>(
    "SELECT COALESCE(NULLIF(btrim(trade_name), ''), legal_name) AS name FROM tenants WHERE id=$1", [tenantId],
  )
  if (!rows[0]) throw new Problem(404, "company_not_found", "Empresa do documento não encontrada")
  return rows[0].name
}

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
function escape(value: string) {
  return value.replace(/[&<>"']/g, char => entities[char]!)
}

export function renderDocumentEmail({ company, title, message, attachments, details = [], notice }: DocumentEmail) {
  const facts = details.filter(({ value }) => value.trim())
  const files = attachments.map(({ filename }) => filename)
  const fileLabel = files.length === 1 ? "Arquivo anexo" : "Arquivos anexos"
  const text = [
    company, title, notice, message,
    facts.map(({ label, value }) => label + " • " + value).join("\n"),
    files.length ? [fileLabel, ...files].join("\n") : "",
  ].filter(Boolean).join("\n\n")

  const body = escape(message).replace(/\r\n?|\n/g, "<br>")
  const info = facts.map(({ label, value }) => `<tr><th scope="row" align="left" style="padding:6px 12px 6px 0;color:#4b5563;font-weight:normal;vertical-align:top">${escape(label)}</th><td style="padding:6px 0;overflow-wrap:anywhere">${escape(value)}</td></tr>`).join("")
  const list = files.map(name => `<li style="margin:4px 0;overflow-wrap:anywhere;word-break:break-word">${escape(name)}</li>`).join("")
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title></head>
<body style="margin:0;background:#f3f5f7;color:#172331;font:16px/1.5 Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:white;border:1px solid #dce2e7;border-top:4px solid #245776;border-radius:8px">
<tr><td style="padding:25px 26px 0"><div style="color:#30556a;font-weight:bold">${escape(company)}</div>
<h1 style="font: bold 24px/1.25 Arial,Helvetica,sans-serif;margin:10px 0 18px">${escape(title)}</h1></td></tr>
<tr><td style="padding:0 26px 24px">
${notice ? `<p style="margin:0 0 18px;padding:10px 14px;background:#fff3cc;border-left:4px solid #ae6e00;color:#634000"><strong>${escape(notice)}</strong></p>` : ""}
<div style="margin:0;white-space:pre-wrap;overflow-wrap:anywhere">${body}</div>
${info ? `<table cellspacing="0" cellpadding="0" style="width:100%;margin-top:20px;border-top:1px solid #dce2e7;font:14px/1.5 Arial,Helvetica,sans-serif">${info}</table>` : ""}
${list ? `<div style="margin-top:20px;padding:12px 16px;background:#f3f6f8;font-size:14px"><strong>${fileLabel}</strong><ul style="margin:6px 0 0;padding-left:18px">${list}</ul></div>` : ""}
</td></tr></table></td></tr></table></body></html>`
  return { text, html }
}
