import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { sendDocumentMail, documentMailConfigured, documentMailLimit } from "../../platform/document-mail.js"
import { documentMailCompany, renderDocumentEmail } from "../../platform/document-mail-template.js"
import { parseRevision } from "../../platform/revision.js"
import { Problem } from "../../platform/problem.js"
import { financialSnapshot, reportFilters } from "./financial-snapshot.js"
import { validate } from "../finance-insights/portfolio.js"
import { digest, subjectWithCompany } from "./source.js"
import type { DocumentCopyIO } from "./routes.js"

const input = z.strictObject({
  recipient: z.string().refine(v => !/\p{Cc}/u.test(v)).transform(v => v.trim()).pipe(z.email().max(254)),
  subject: z.string().min(1).max(200).refine(v => v.trim().length > 0 && !/\p{Cc}/u.test(v)),
  message: z.string().min(1).max(10000).refine(v => v.trim().length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(v)),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
})
const reportInput = input.extend({ filters: reportFilters.optional() })
const noFilters = z.strictObject({})
type Delivery = { id: string; status: "uncertain" | "failed" | "sent"; recipient: string; createdAt: string }
const fields = 'id,status,recipient,created_at::text AS "createdAt"'
function authorize(context: AuthorizedContext, report: boolean, write: boolean) {
  const scopes = report ? ["finance.receivables", "finance.payables"] : ["finance.receivables"]
  for (const scope of scopes) {
    requirePermission(context, `${scope}.read`)
    if (write) requirePermission(context, `${scope}.manage`)
  }
  return scopes.every(scope => context.permissions.includes(`${scope}.manage`))
}

export function registerFinancialEmails(app: FastifyInstance, deps: AccessDependencies,
  io: DocumentCopyIO = { configured: documentMailConfigured, send: sendDocumentMail }) {
  for (const report of [false, true]) {
    const path = report ? "/api/v1/financial-report/email" : "/api/v1/receivables/:id/email"
    const kind = report ? "report" : "receivable"
    const sourceId = (params: { id?: string }) => {
      if (report) return null
      if (!z.guid().safeParse(params.id).success) throw new Problem(404, "not_found", "Título a receber não encontrado")
      return params.id!.toLowerCase()
    }
    app.get<{ Params: { id?: string } }>(path, async (request, reply) => {
      const id = sourceId(request.params)
      const result = await authorizeRequest(request, deps, async context => {
        const manage = authorize(context, report, false)
        const filters = validate(report ? reportFilters : noFilters, request.query)
        const doc = await financialSnapshot(context, id, filters)
        const history = await context.client.query<Delivery>(`SELECT ${fields} FROM finance_document_email_deliveries
          WHERE tenant_id=$1 AND context=$2 AND receivable_id IS NOT DISTINCT FROM $3 ORDER BY created_at DESC,id DESC LIMIT 50`, [context.tenantId, kind, id])
        return {
          revision: doc.revision, body: {
            tenantId: context.tenantId, canSend: manage && doc.allowed,
            emailReady: io.configured(), recipient: doc.recipient, documentTitle: doc.title, scope: doc.scope,
            suggestedSubject: subjectWithCompany(doc.suggestedSubject, await documentMailCompany(context)), suggestedMessage: doc.suggestedMessage,
            recordCount: doc.count, summary: doc.summary, snapshotHash: doc.hash, deliveries: history.rows,
          }
        }
      })
      return reply.header("etag", `"${result.revision}"`).header("cache-control", "no-store").send(result.body)
    })
    app.post<{ Params: { id?: string } }>(path, async (request, reply) => {
      const id = sourceId(request.params), key = commandKey(request.headers["idempotency-key"]), revision = parseRevision(request.headers["if-match"])
      validate(noFilters, request.query)
      const parsed = (report ? reportInput : input).safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Confira o destinatário, o assunto e a mensagem")
      const command = parsed.data
      const prepared = await authorizeRequest(request, deps, async context => {
        authorize(context, report, true)
        const tenant = context.tenantId
        // Historical command fingerprints trim the envelope fields. Preserve the submitted text in the receipt and message.
        const payload = { context: kind, id, revision, input: { ...command, subject: command.subject.trim(), message: command.message.trim() } }
        const prior = await replay(context, key, "finance.document_email", payload)
        if (prior) {
          const saved = (await context.client.query<Delivery>(`SELECT ${fields} FROM finance_document_email_deliveries WHERE tenant_id=$1 AND id=$2`, [tenant, prior.deliveryId])).rows[0]
          if (!saved) throw new Problem(503, "receipt_unavailable", "Confirmação de envio indisponível")
          return { context, delivery: saved, dispatch: null }
        }
        const filters = "filters" in command ? validate(reportFilters, command.filters ?? {}) : {}
        const doc = await financialSnapshot(context, id, filters)
        const { snapshot, revision: current, hash } = doc
        if (String(current) !== String(revision) || hash !== command.snapshotHash) throw new Problem(412, "stale_revision", "Os dados financeiros mudaram. Confira o documento novamente")
        if (!doc.allowed) throw new Problem(409, "cancelled_title", "O título está cancelado")
        const pending = await context.client.query("SELECT id FROM finance_document_email_deliveries WHERE tenant_id=$1 AND context=$2 AND receivable_id IS NOT DISTINCT FROM $3 AND status='uncertain' LIMIT 1", [tenant, kind, id])
        if (pending.rows.length) throw new Problem(409, "delivery_pending", "Há um envio com confirmação pendente")
        if (!io.configured()) throw new Problem(503, "document_mail_unavailable", "O serviço de envio de documentos está indisponível")
        const pdf = await doc.pdf()
        if (pdf.length > documentMailLimit) throw new Problem(413, "attachment_limit", "O PDF excede o limite de 10 MB do e-mail. Refine os filtros da carteira.")
        const filename = id ? `titulo-${id}.pdf` : "relatorio-financeiro.pdf", deliveryId = randomUUID()
        const attachments = [{ filename, contentType: "application/pdf", content: pdf }]
        const company = await documentMailCompany(context)
        const message = renderDocumentEmail({ company, title: doc.title, message: command.message, details: doc.emailDetails, attachments })
        const delivery = (await context.client.query<Delivery>(`INSERT INTO finance_document_email_deliveries
          (id,tenant_id,context,receivable_id,source_revision,subject_id,command_key,recipient,subject,message,snapshot,snapshot_hash,pdf_content,pdf_sha256,filename,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'uncertain') RETURNING ${fields}`,
          [deliveryId, tenant, kind, id, revision, context.authSubject, key, command.recipient, command.subject, command.message, snapshot, hash, pdf, digest(pdf), filename])).rows[0]!
        await record(context, request.headers, "finance_document", id ?? tenant, "finance.email_requested", { deliveryId, context: kind, snapshotHash: hash })
        await remember(context, key, "finance.document_email", payload, { deliveryId })
        return { context, delivery, dispatch: { id: deliveryId, to: command.recipient, subject: command.subject, ...message, attachments } }
      })
      const tenantId = prepared.context.tenantId, delivery = prepared.delivery
      if (!prepared.dispatch) reply.header("idempotency-replayed", "true")
      else {
        const outcome = await io.send(prepared.dispatch).catch(() => "unknown" as const)
        const status = outcome === "unknown" ? "uncertain" : outcome
        const client = await deps.pool.connect()
        try {
          await client.query("BEGIN")
          await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.auth_subject',$2,true)", [tenantId, prepared.context.authSubject])
          await client.query("UPDATE finance_document_email_deliveries SET status=$3,sent_at=CASE WHEN $3='sent' THEN now() END,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='uncertain'", [tenantId, delivery.id, status])
          await record({ ...prepared.context, client }, request.headers, "finance_document", id ?? tenantId, `finance.email_${status}`, { deliveryId: delivery.id, context: kind })
          await client.query("COMMIT")
          delivery.status = status
        } catch (error) { await client.query("ROLLBACK").catch(() => { }); throw error }
        finally { client.release() }
      }
      return reply.header("etag", `"${revision}"`).header("cache-control", "no-store").send({ tenantId, revision, delivery })
    })
  }
}
