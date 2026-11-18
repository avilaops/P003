import { randomUUID } from "node:crypto"
import endpoints from "../document-endpoints.json" with { type: "json" }
import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AuthorizedContext, type AccessDependencies } from "../../platform/access.js"
import { commandKey, record } from "../../platform/commands.js"
import type { DatabasePool } from "../../platform/database.js"
import { documentMailConfigured, sendDocumentMail } from "../../platform/document-mail.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, revisionValue } from "../../platform/revision.js"
import { copySource, digest, type Kind } from "./source.js"

const inputSchema = z.strictObject({
  recipient: z.string().min(1).max(8192), snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
  subject: z.string().min(1).max(200).refine(v => v.trim().length > 0 && !/\p{Cc}/u.test(v)),
  message: z.string().min(1).max(10000).refine(v => v.trim().length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(v)),
})
type Delivery = { id: string; status: "sent" | "failed" | "uncertain"; recipient: string; createdAt: Date }
type Saved = Delivery & { source_id: string; source_revision: string; snapshot_hash: string; subject: string; message: string }
const fields = "id,status,array_to_string(recipients,', ') AS recipient,created_at AS \"createdAt\""
const column = (kind: Kind) => kind === "payable" ? "payable_id" : "contract_id"
const readRight = (kind: Kind) => kind === "payable" ? "finance.payables.read" : "sales.orders.read"
const writeRights = (kind: Kind) => kind === "payable" ? ["finance.payables.manage"] : ["sales.orders.manage", "sales.contracts.send", "sales.contracts.package"]
const notFound = () => new Problem(404, "not_found", "Documento não encontrado")

async function state(context: AuthorizedContext, kind: Kind, id: string) {
  const source = await copySource(context, kind, id)
  const rows = await context.client.query<Delivery>(`SELECT ${fields} FROM document_copy_email_deliveries
    WHERE tenant_id=$1 AND ${column(kind)}=$2 ORDER BY created_at DESC,id DESC LIMIT 50`, [context.tenantId, id])
  const latest = rows.rows[0]
  const hash = digest(JSON.stringify([source.hash, latest?.id, latest?.status]))
  return { source, hash, deliveries: rows.rows }
}

function receipt(reply: FastifyReply, tenantId: string, revision: string, delivery: Delivery) {
  return reply.code(delivery.status === "uncertain" ? 202 : 200).header("etag", `"${revision}"`).header("cache-control", "no-store")
    .send({ tenantId, revision: revisionValue(revision), delivery: { id: delivery.id, status: delivery.status, recipient: delivery.recipient, createdAt: delivery.createdAt } })
}

async function finish(pool: DatabasePool, tenant: string, id: string, status: "failed" | "sent") {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant])
    await client.query(`UPDATE document_copy_email_deliveries SET status=$3,sent_at=CASE WHEN $3='sent' THEN clock_timestamp() END
      WHERE tenant_id=$1 AND id=$2 AND status='uncertain'`, [tenant, id, status])
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => { })
    throw error
  } finally { client.release() }
}

export type DocumentCopyIO = { configured: typeof documentMailConfigured; send: typeof sendDocumentMail }
export function registerDocumentCopies(app: FastifyInstance, deps: AccessDependencies,
  io: DocumentCopyIO = { configured: documentMailConfigured, send: sendDocumentMail }) {
  for (const kind of ["payable", "contract"] as const) {
    app.get<{ Params: { id: string } }>(endpoints[kind].GET, async (request, reply) => {
      const { id } = request.params
      const result = await authorizeRequest(request, deps, async context => {
        requirePermission(context, readRight(kind))
        if (!z.guid().safeParse(id).success) throw notFound()
        const { source, hash, deliveries } = await state(context, kind, id)
        return {
          tenantId: context.tenantId, revision: revisionValue(source.revision), emailReady: io.configured(),
          canSend: source.allowed && source.recipients.length > 0 && writeRights(kind).every(code => context.permissions.includes(code)),
          recipient: source.recipients.join(", "), documentTitle: source.title, scope: source.scope, recordCount: source.count, snapshotHash: hash, deliveries
        }
      })
      return reply.header("etag", `"${result.revision}"`).header("cache-control", "no-store").send(result)
    })
    app.post<{ Params: { id: string } }>(endpoints[kind].POST, async (request, reply) => {
      const id = request.params.id.toLowerCase()
      if (!z.guid().safeParse(id).success) throw notFound()
      const key = commandKey(request.headers["idempotency-key"])
      const revision = String(parseRevision(request.headers["if-match"]))
      const parsed = inputSchema.safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Confira os destinatários, o assunto e a mensagem")
      const input = parsed.data
      const result = await authorizeRequest(request, deps, async context => {
        requirePermission(context, readRight(kind))
        for (const code of writeRights(kind)) requirePermission(context, code)
        const tenant = context.tenantId
        const prior = (await context.client.query<Saved>(`SELECT ${fields},${column(kind)} AS source_id,source_revision::text,snapshot_hash,subject,message
          FROM document_copy_email_deliveries WHERE tenant_id=$1 AND subject_id=$2 AND command_key=$3`, [tenant, context.authSubject, key])).rows[0]
        if (prior) {
          if (prior.source_id !== id || prior.source_revision !== revision || prior.snapshot_hash !== input.snapshotHash ||
            prior.recipient !== input.recipient || prior.subject !== input.subject || prior.message !== input.message)
            throw new Problem(409, "idempotency_conflict", "A chave de confirmação já foi usada com outros dados")
          return { tenant, delivery: prior, dispatch: null }
        }
        const { source, hash, deliveries } = await state(context, kind, id)
        if (source.revision !== revision || hash !== input.snapshotHash || source.recipients.join(", ") !== input.recipient)
          throw new Problem(412, "stale_revision", "O documento ou o destinatário mudou. Confira novamente os dados do envio")
        if (!source.allowed || !source.recipients.length) throw new Problem(409, "document_unavailable", "Verifique a situação do documento e o e-mail cadastrado")
        if (deliveries.some(d => d.status === "uncertain")) throw new Problem(409, "delivery_pending", "Há um envio com confirmação pendente")
        if (!io.configured()) throw new Problem(503, "document_mail_unavailable", "O serviço de envio de documentos está indisponível")
        const files = await source.files()
        const deliveryId = randomUUID()
        const manifest = files.map(f => ({ filename: f.filename, sha256: digest(f.content), sourceId: f.sourceId }))
        const delivery = (await context.client.query<Delivery>(`INSERT INTO document_copy_email_deliveries
          (id,tenant_id,${column(kind)},subject_id,command_key,source_revision,snapshot_hash,recipients,subject,message,manifest,payable_pdf)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING ${fields}`,
          [deliveryId, tenant, id, context.authSubject, key, revision, hash, source.recipients, input.subject, input.message, JSON.stringify(manifest), kind === "payable" ? files[0]!.content : null])).rows[0]!
        await record(context, request.headers, kind, id, `${kind}.copy_email_requested`, { deliveryId })
        return {
          tenant, delivery, dispatch: {
            id: deliveryId, to: source.recipients, subject: input.subject, text: input.message,
            attachments: files.map(({ filename, content, contentType }) => ({ filename, content, contentType }))
          }
        }
      })
      if (!result.dispatch) reply.header("idempotency-replayed", "true")
      else {
        const outcome = await io.send(result.dispatch).catch(() => "unknown" as const)
        if (outcome !== "unknown") {
          await finish(deps.pool, result.tenant, result.delivery.id, outcome)
          result.delivery.status = outcome
        }
      }
      return receipt(reply, result.tenant, revision, result.delivery)
    })
  }
}
