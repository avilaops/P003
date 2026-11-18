import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { documentMailConfigured, sendDocumentMail } from "../../platform/document-mail.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, revisionValue } from "../../platform/revision.js"
import { formalizeProposal } from "../proposals/formalize.js"
import { salesMailDocument } from "./mail-document.js"

type Kind = "order" | "proposal"
type IO = { configured: typeof documentMailConfigured; send: typeof sendDocumentMail }
const inputSchema = z.strictObject({
  recipient: z.string().refine(value => !/\p{Cc}/u.test(value)).trim().pipe(z.email().max(254)),
  subject: z.string().refine(value => !/\p{Cc}/u.test(value)).trim().min(1).max(200),
  message: z.string().trim().min(1).max(10000).refine(value => !/\p{Cc}/u.test(value.replace(/[\r\n\t]/g, ""))),
})
const fields = 'id,status,recipient,created_at::text AS "createdAt"'
function notFound() { return new Problem(404, "not_found", "Documento não encontrado nesta empresa") }

async function current(context: AuthorizedContext, kind: Kind, id: string) {
  const query = kind === "order"
    ? `SELECT d.revision, p.email, 0 AS version, d.status <> 'cancelled' AS eligible
         FROM sales_orders d JOIN parties p ON p.tenant_id=d.tenant_id AND p.id=d.customer_id
        WHERE d.tenant_id=$1 AND d.id=$2`
    : `SELECT d.revision, p.email, v.version,
              (d.order_id IS NULL AND v.status IN ('draft','sent') AND v.valid_until >= (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS eligible
         FROM sales_proposals d JOIN sales_proposal_versions v ON v.tenant_id=d.tenant_id AND v.proposal_id=d.id AND v.version=d.current_version
         JOIN parties p ON p.tenant_id=v.tenant_id AND p.id=v.customer_id WHERE d.tenant_id=$1 AND d.id=$2`
  const { rows } = await context.client.query<{ revision: string; email: string | null; version: number; eligible: boolean }>(query, [context.tenantId,id])
  if (!rows[0]) throw notFound()
  return rows[0]
}

async function receipt(context: AuthorizedContext, kind: Kind, id: string, deliveryId: unknown) {
  const { rows } = await context.client.query(`SELECT ${fields},result_revision FROM sales_${kind}_email_deliveries
    WHERE tenant_id=$1 AND ${kind}_id=$2 AND id=$3`, [context.tenantId,id,deliveryId])
  if (!rows[0]) throw notFound()
  const { result_revision, ...delivery } = rows[0]
  return { tenantId: context.tenantId, revision: revisionValue(result_revision), delivery }
}

export function registerSalesMail(app: FastifyInstance, deps: AccessDependencies, io: IO = { configured: documentMailConfigured, send: sendDocumentMail }) {
  for (const kind of ["order", "proposal"] as const) {
    const path = `/api/v1/${kind}s/:id/email`
    const table = `sales_${kind}_email_deliveries`
    const manage = `sales.${kind}s.manage`
    app.get<{ Params: { id: string } }>(path, async (request, reply) => {
      const id = request.params.id
      const value = await authorizeRequest(request, deps, async context => {
        requirePermission(context, `sales.${kind}s.read`)
        if (!z.guid().safeParse(id).success) throw notFound()
        const source = await current(context, kind, id)
        let canSend = source.eligible && context.permissions.includes(manage)
        if (canSend && kind === "proposal") {
          try { await formalizeProposal(context, id, source.version, false) }
          catch (error) {
            if (!(error instanceof Problem) || error.status >= 500) throw error
            canSend = false
          }
        }
        const deliveries = await context.client.query(`SELECT ${fields} FROM ${table}
          WHERE tenant_id=$1 AND ${kind}_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50`, [context.tenantId,id])
        return { tenantId: context.tenantId, canSend, emailReady: io.configured(), recipient: source.email, deliveries: deliveries.rows }
      })
      return reply.header("cache-control", "no-store").send(value)
    })
    app.post<{ Params: { id: string } }>(path, async (request, reply) => {
      const id = request.params.id.toLowerCase()
      const revision = parseRevision(request.headers["if-match"])
      const key = commandKey(request.headers["idempotency-key"])
      const reserved = await authorizeRequest(request, deps, async context => {
        requirePermission(context, `sales.${kind}s.read`)
        requirePermission(context, manage)
        if (!z.guid().safeParse(id).success) throw notFound()
        const parsed = inputSchema.safeParse(request.body)
        if (!parsed.success) throw new Problem(422, "invalid_input", "Confira o endereço de e-mail, o assunto e a mensagem")
        const input = parsed.data
        const command = { id, revision, input }
        const prior = await replay(context, key, `${kind}.email`, command)
        if (prior) return { prior: await receipt(context, kind, id, prior.deliveryId) }
        const source = await current(context, kind, id)
        if (revisionValue(source.revision) !== revision) throw new Problem(412, "stale_revision", "O documento mudou. Recarregue antes de enviar")
        if (!source.eligible) throw new Problem(409, "domain_conflict", kind === "order"
          ? "Pedidos cancelados não podem ser enviados por e-mail" : "Confira a situação e a validade da proposta")
        if (kind === "proposal") await formalizeProposal(context, id, source.version)
        const pending = await context.client.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND ${kind}_id=$2 AND status='uncertain' LIMIT 1`, [context.tenantId,id])
        if (pending.rows.length) throw new Problem(409, "domain_conflict", "Há um envio com confirmação pendente. Consulte o histórico")
        if (!io.configured()) throw new Problem(503, "document_mail_unavailable", "O serviço de envio de documentos está indisponível")
        const { html, attachment } = await salesMailDocument(context, kind, id)
        const deliveryId = randomUUID()
        const values = [deliveryId,context.tenantId,id,revision,context.authSubject,key,input.recipient,html]
        const version = kind === "proposal" ? ",version" : ""
        await context.client.query(`INSERT INTO ${table}
          (id,tenant_id,${kind}_id,${kind}_revision,result_revision,subject_id,command_key,recipient,snapshot_html,status${version})
          VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,'uncertain'${kind === "proposal" ? ",$9" : ""})`,
          kind === "proposal" ? [...values,source.version] : values)
        await record(context, request.headers, `sales_${kind}`, id, `${kind}.email_requested`,
          { deliveryId, revision, recipient: input.recipient, ...(kind === "proposal" ? { version: source.version } : {}) })
        await remember(context, key, `${kind}.email`, command, { deliveryId })
        return { version: source.version, mail: { id: deliveryId, to: input.recipient, subject: input.subject, text: input.message, attachments: [attachment] } }
      })
      reply.header("cache-control", "no-store")
      if (reserved.prior) return reply.header("idempotency-replayed", "true").header("etag", `"${reserved.prior.revision}"`).send(reserved.prior)
      const { mail, version } = reserved
      const outcome = await io.send(mail).catch(() => "unknown" as const)
      const status = outcome === "unknown" ? "uncertain" : outcome
      const result = await authorizeRequest(request, deps, async context => {
        let endRevision = revision
        if (kind === "proposal" && status === "sent") {
          const updated = await context.client.query(`UPDATE sales_proposals SET revision=revision+1,updated_at=now()
            WHERE tenant_id=$1 AND id=$2 AND revision=$3 AND current_version=$4 AND order_id IS NULL AND EXISTS
            (SELECT 1 FROM sales_proposal_versions WHERE tenant_id=$1 AND proposal_id=$2 AND version=$4 AND status IN ('draft','sent')) RETURNING revision`,
            [context.tenantId,id,revision,version])
          if (updated.rows[0]) {
            endRevision = revisionValue(updated.rows[0].revision)
            await context.client.query("UPDATE sales_proposal_versions SET status='sent',sent_at=COALESCE(sent_at,now()) WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3", [context.tenantId,id,version])
          }
        }
        await context.client.query(`UPDATE ${table} SET status=$3,result_revision=$4,sent_at=CASE WHEN $3='sent' THEN now() END,updated_at=now()
          WHERE tenant_id=$1 AND id=$2 AND status='uncertain'`, [context.tenantId,mail.id,status,endRevision])
        await record(context, request.headers, `sales_${kind}`, id, `${kind}.email_${status}`,
          { deliveryId: mail.id, recipient: mail.to, ...(kind === "proposal" ? { version } : {}) })
        return receipt(context, kind, id, mail.id)
      })
      return reply.header("etag", `"${result.revision}"`).send(result)
    })
  }
}
