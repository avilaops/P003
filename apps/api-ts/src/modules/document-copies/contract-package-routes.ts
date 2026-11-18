import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AuthorizedContext, type AccessDependencies } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { canonicalJson } from "../../platform/json.js"
import { documentMailConfigured, sendDocumentMail } from "../../platform/document-mail.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision } from "../../platform/revision.js"
import { renderDanfe } from "../nfe-email/danfe.js"
import { packageFiles, packageSource } from "./contract-package.js"
import type { DocumentCopyIO } from "./routes.js"
import { digest } from "./source.js"

type Status = "sending" | "sent" | "failed" | "unknown"
type Contract = {
  data: { id: string; status: string; revision: number | bigint; recipients: { email: string }[] }
  files: unknown[]; packageStatus: Status | null; packageUpdatedAt: string | null
}
async function detail(context: AuthorizedContext, id: string) {
  for (const permission of ["sales.orders.read", "sales.orders.manage", "sales.contracts.send", "sales.contracts.package"]) requirePermission(context, permission)
  const row = (await context.client.query<Contract>(`
    SELECT jsonb_build_object('id',c.id,'tenantId',c.tenant_id,'customerId',c.customer_id,'orderId',c.order_id,'templateId',c.template_id,
      'templateName',c.template_name,'snapshot',c.snapshot,'recipients',c.recipients,'fields',c.fields,'externalId',c.external_id,
      'status',c.status,'revision',c.revision,'problem',c.problem,'progress',c.progress,'reviewedBy',c.reviewed_by,
      'reviewedAt',c.reviewed_at::text,'sendRequestedAt',c.send_requested_at::text,'completedAt',c.completed_at::text,'createdAt',c.created_at::text) AS data,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,'kind',f.kind,'position',f.position,'sha256',f.sha256) ORDER BY f.kind,f.position)
        FROM commercial_contract_files f WHERE f.tenant_id=c.tenant_id AND f.contract_id=c.id),'[]'::jsonb) AS files,
      d.status AS "packageStatus",d.updated_at::text AS "packageUpdatedAt"
    FROM commercial_contracts c LEFT JOIN commercial_contract_deliveries d ON d.tenant_id=c.tenant_id AND d.contract_id=c.id
    WHERE c.tenant_id=$1 AND c.id=$2`, [context.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Contrato não encontrado")
  return row
}

const payload = z.strictObject({ recipients: z.array(z.email().max(254)).min(1).max(20).optional() })
const scope = "contract.send_package"
export function registerContractPackage(app: FastifyInstance, deps: AccessDependencies,
  io: DocumentCopyIO = { configured: documentMailConfigured, send: sendDocumentMail }, render: typeof renderDanfe = renderDanfe) {
  app.post<{ Params: { id: string } }>("/api/v1/commercial-contracts/:id/send-package", async (request, reply) => {
    const id = request.params.id.toLowerCase()
    if (!z.guid().safeParse(id).success) throw new Problem(404, "not_found", "Contrato não encontrado")
    const key = commandKey(request.headers["idempotency-key"])
    const revision = request.headers["if-match"] === undefined ? null : parseRevision(request.headers["if-match"])
    const parsed = payload.safeParse(request.body)
    if (!parsed.success) throw new Problem(422, "invalid_input", "Confira os destinatários do pacote")
    const recipients = parsed.data.recipients
    const input = recipients ? { id, recipients, revision } : { id }
    async function review(context: AuthorizedContext) {
      const doc = await detail(context, id)
      const previous = await replay(context, key, scope, input)
      if (previous || (doc.packageStatus && doc.packageStatus !== "failed")) return { doc, ready: false }
      if (revision !== null && String(doc.data.revision) !== String(revision) ||
          recipients && canonicalJson(recipients) !== canonicalJson(doc.data.recipients.map(r => r.email))) {
        throw new Problem(412, "stale_revision", "O contrato ou os destinatários mudaram. Recarregue e confira o pacote")
      }
      if (!io.configured()) throw new Problem(503, "document_mail_unavailable", "O serviço de envio de documentos está indisponível")
      return { doc, ready: true }
    }
    // Render outside the write transaction and confirm all sources again before reserving the delivery.
    const preview = await authorizeRequest(request, deps, async context => {
      const reviewState = await review(context)
      if (!reviewState.ready) return { tenant: context.tenantId, doc: reviewState.doc, content: null }
      const source = await packageSource(context, id)
      return { tenant: context.tenantId, doc: reviewState.doc, content: { source, contracts: await source.source.files() } }
    }, false)
    let doc = preview.doc
    if (preview.content) {
      const { source, contracts } = preview.content
      const mail = await packageFiles(source, contracts, render)
      const hash = digest(mail.subject + "\n" + mail.text + "\n" + canonicalJson(mail.manifest))
      const reserved = await authorizeRequest(request, deps, async context => {
        const current = await review(context)
        if (!current.ready) return null
        if ((await packageSource(context, id)).signature !== source.signature) throw new Problem(412, "stale_revision", "Os documentos do pacote mudaram. Confira novamente")
        const row = (await context.client.query<{ attempts: number }>(`INSERT INTO commercial_contract_deliveries
          (tenant_id,contract_id,status,recipients,attachments,message_sha256) VALUES($1,$2,'unknown',$3::jsonb,$4::jsonb,$5)
          ON CONFLICT(tenant_id,contract_id) DO UPDATE SET status='unknown',attempts=commercial_contract_deliveries.attempts+1,
          recipients=excluded.recipients,attachments=excluded.attachments,message_sha256=excluded.message_sha256,last_error=NULL,updated_at=now()
          WHERE commercial_contract_deliveries.status='failed' RETURNING attempts`,
          [context.tenantId, id, canonicalJson(source.source.recipients), canonicalJson(mail.manifest), hash])).rows[0]
        if (!row) return null
        await remember(context, key, scope, input, { id })
        await record(context, request.headers, "commercial_contract", id, "contract.package_requested", { messageSha256: hash, attempts: row.attempts })
        return { context, attempts: row.attempts }
      })
      if (reserved) {
        const { context, attempts } = reserved
        const outcome = await io.send({ id: digest(canonicalJson([context.tenantId, id, attempts])), to: source.source.recipients,
          subject: mail.subject, text: mail.text, attachments: mail.attachments }).catch(() => "unknown" as const)
        const client = await deps.pool.connect()
        try {
          await client.query("BEGIN")
          await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.auth_subject',$2,true)", [context.tenantId, context.authSubject])
          await client.query(`UPDATE commercial_contract_deliveries SET status=$3,updated_at=now(),sent_at=CASE WHEN $3='sent' THEN now() END,
            last_error=CASE WHEN $3='failed' THEN 'O serviço recusou o envio' WHEN $3='unknown' THEN 'O serviço não confirmou o envio' END
            WHERE tenant_id=$1 AND contract_id=$2 AND status='unknown' AND attempts=$4`, [context.tenantId, id, outcome, attempts])
          await record({ ...context, client }, request.headers, "commercial_contract", id, "contract.package_" + outcome, { messageSha256: hash, attachments: mail.manifest })
          await client.query("COMMIT")
        } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error }
        finally { client.release() }
      } else reply.header("idempotency-replayed", "true")
      doc = await authorizeRequest(request, deps, context => detail(context, id), false)
    } else reply.header("idempotency-replayed", "true")
    return reply.code(doc.packageStatus === "unknown" || doc.packageStatus === "sending" ? 202 : 200)
      .header("etag", `"${doc.data.revision}"`).header("cache-control", "no-store")
      .send({ ...doc, tenantId: preview.tenant, canEdit: true, canSend: true, emailReady: process.env.DOCUSEAL_EMAIL_READY === "true" })
  })
}
