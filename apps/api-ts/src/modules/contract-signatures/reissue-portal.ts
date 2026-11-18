import { z } from "zod"
import { Problem } from "../../platform/problem.js"

export type PortalRecipient = { role: string; name: string; email: string }
export type FrozenTemplate = { external_id: string; submitters: { uuid: string; name: string }[];
  fields: { name: string; submitter_uuid: string }[] }
export type PublishedVersion = { versionId: string; requestHash: string; templateId: string }

export function reissuePortal(env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch) {
  const origin = env.DOCUSEAL_URL || "https://contrato.avilaops.com"
  const token = env.DOCUSEAL_API_TOKEN
  if (!token || token.length < 16 || !/^https:\/\/contrato\.avilaops\.com\/?$/.test(origin))
    throw new Problem(503, "contract_portal_unavailable", "A integração com o portal de contratos está indisponível")
  async function call(path: string, body?: unknown): Promise<unknown> {
    try {
      const response = await http(new URL("/api/" + path, origin), { method: body ? "POST" : "GET",
        headers: { "X-Auth-Token": token!, "Content-Type": "application/json" }, redirect: "error",
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12_000) })
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error() }
      const reader = response.body.getReader()
      const chunks: Buffer[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 512 * 1024) { await reader.cancel(); throw new Error() }
        chunks.push(Buffer.from(value))
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch { throw new Problem(503, "contract_portal_unavailable", "O portal ainda não confirmou a operação") }
  }
  return {
    async submission(id: string) {
      if (!/^\d+$/.test(id)) throw new Problem(409,"invalid_submission","Identificação da solicitação inválida")
      const result = z.object({ id:z.number().int().positive(), template:z.object({id:z.number().int().positive()}),
        archived_at:z.string().nullable().optional(), completed_at:z.string().nullable(),
        submitters:z.array(z.object({id:z.number().int().positive(),role:z.string(),email:z.string(),external_id:z.string().nullable(),slug:z.string(),
          completed_at:z.string().nullable(),preferences:z.object({require_email_2fa:z.boolean().optional()}).optional()})).max(10)
      }).safeParse(await call("submissions/" + id))
      if (!result.success) throw new Problem(503,"portal_unavailable","O portal não confirmou os dados da solicitação")
      return result.data
    },
    async verify(version: PublishedVersion) {
      const raw = await call("avila/templates/" + version.versionId)
      const check = z.object({ found: z.literal(true), id: z.number().int().positive(), archived: z.literal(false), requestHash: z.string() }).safeParse(raw)
      if (!check.success || String(check.data.id) !== version.templateId || check.data.requestHash !== version.requestHash)
        throw new Problem(409, "contract_template_changed", "O portal não confirmou a versão publicada deste modelo")
    },
    async create(tenant: string, id: string, version: PublishedVersion, template: FrozenTemplate,
      recipients: PortalRecipient[], fields: Record<string, string>) {
      const completedRedirect = new URL(`/icp/${tenant}/${id}`, origin).href
      const submitters = recipients.map((recipient, index) => {
        const role = template.submitters.find(item => item.name === recipient.role)!
        return { ...recipient, external_id: `erp:${tenant}:${id}:${index}`, send_email: false, send_sms: false,
          require_email_2fa: true, completed_redirect_url: completedRedirect,
          fields: template.fields.filter(field => field.submitter_uuid === role.uuid && Object.hasOwn(fields, field.name))
            .map(field => ({ name: field.name, default_value: fields[field.name], readonly: true })) }
      })
      const result = await call("submissions", { template_id: Number(version.templateId), submitters_order: "random", send_email: false, send_sms: false, submitters })
      const receipt = z.array(z.object({ submission_id: z.number().int().positive(), external_id: z.string(), role: z.string(), email: z.string(),
        preferences: z.object({ require_email_2fa: z.literal(true), completed_redirect_url: z.literal(completedRedirect) }) })).max(10).safeParse(result)
      if (!receipt.success || receipt.data.length !== submitters.length || new Set(receipt.data.map(s => s.submission_id)).size !== 1 ||
        !submitters.every(s => receipt.data.some(v => v.external_id === s.external_id && v.email === s.email && v.role === s.role)))
        throw new Problem(503, "contract_portal_unconfirmed", "O portal ainda não confirmou os destinatários deste contrato")
    }
  }
}
