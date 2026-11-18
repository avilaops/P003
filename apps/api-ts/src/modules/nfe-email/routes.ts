import { randomUUID } from "node:crypto"
import endpoints from "../document-endpoints.json" with { type: "json" }
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record } from "../../platform/commands.js"
import type { DatabasePool } from "../../platform/database.js"
import { documentMailCompany } from "../../platform/document-mail-template.js"
import { Problem } from "../../platform/problem.js"
import { renderDanfe, sha256 } from "./danfe.js"
import { commandDelivery, preview, type DocumentKind, type Delivery } from "./document.js"
import { resolveSender, type Outcome } from "./smtp.js"

export type NfeEmailIO = { render: typeof renderDanfe; sender: typeof resolveSender }
const idParams = z.object({ id: z.guid() })
const confirmation = z.strictObject({ recipientEmail: z.email().max(254) })
const permissions = {
  nfe: "fiscal.nfe.issue", "received-nfses": "fiscal.nfse.import", "outgoing-nfses": "fiscal.outgoing_nfse.issue",
} satisfies Record<DocumentKind,string>
type Snapshot = Awaited<ReturnType<typeof preview>>
type Command = { kind: DocumentKind; id: string; key: string; etag: string; recipient: string }

function documentId(request: FastifyRequest) {
  const params = idParams.safeParse(request.params)
  if (!params.success) throw new Problem(400, "invalid_id", "Identificador de nota fiscal inválido")
  return params.data.id.toLowerCase()
}

async function load(context: AuthorizedContext, id: string, kind: DocumentKind) {
  requirePermission(context, permissions[kind])
  if (kind !== "nfe") requirePermission(context, kind === "received-nfses" ? "fiscal.nfse.read" : "fiscal.outgoing_nfse.read")
  return preview(context, id, kind)
}

async function prepare(context: AuthorizedContext, command: Command) {
  const snapshot = await load(context, command.id, command.kind)
  const saved = await commandDelivery(context, command.key)
  if (saved) {
    if (saved.document_kind !== command.kind || saved.document_id !== command.id || saved.recipient !== command.recipient || saved.confirmed_etag !== command.etag) {
      throw new Problem(409, "idempotency_conflict", "Esta chave já foi usada em outra confirmação de envio")
    }
    return { snapshot, saved }
  }
  if (!snapshot.result.recipientEmail) throw new Problem(409, "recipient_missing", "Cadastre um e-mail para o destinatário da nota")
  if (snapshot.etag !== command.etag || command.recipient !== snapshot.result.recipientEmail) {
    throw new Problem(412, "stale_preview", "Os dados do envio mudaram. Confira novamente o endereço do destinatário")
  }
  if (snapshot.result.status === "unknown" || snapshot.result.status === "sent") {
    throw new Problem(409, "delivery_exists", "Já existe um envio para esta nota. Atualize para consultar o resultado")
  }
  if (!snapshot.result.smtpConfigured) throw new Problem(503, "smtp_unavailable", "Configure o SMTP em Preferências do sistema • E-mail para enviar a nota")
  return { snapshot }
}

function respond(reply: FastifyReply, snapshot: Snapshot, saved?: Delivery) {
  const result = saved ? { ...snapshot.result, recipientEmail: saved.recipient, status: saved.status, sentAt: saved.sent_at } : snapshot.result
  if (saved) reply.header("idempotency-replayed", "true")
  return reply.code(result.status === "unknown" ? 202 : 200)
    .header("cache-control", "no-store").header("etag", snapshot.etag).send(result)
}

// Persist the SMTP receipt even if the operator's session expires during delivery.
async function finish(pool: DatabasePool, tenantId: string, subject: string, id: string, outcome: Outcome) {
  if (outcome === "unknown") return
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.auth_subject',$2,true)", [tenantId, subject])
    await client.query(`UPDATE fiscal_nfe_email_deliveries SET status=$4,sent_at=CASE WHEN $4='sent' THEN clock_timestamp() END
      WHERE tenant_id=$1 AND auth_subject=$2 AND id=$3 AND status='unknown'`, [tenantId, subject, id, outcome])
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally { client.release() }
}

export function registerNfeEmail(app: FastifyInstance, deps: AccessDependencies, io: NfeEmailIO = { render: renderDanfe, sender: resolveSender }) {
  for (const kind of ["nfe", "received-nfses", "outgoing-nfses"] as const) {
    registerDocumentRoutes(app, deps, io, kind)
  }
  app.get(endpoints["outgoing-nfse-list"].GET, async (request, reply) => {
    const query = z.object({ offset: z.coerce.number().int().min(0).max(1000000).default(0) }).safeParse(request.query)
    if (!query.success) throw new Problem(400, "invalid_offset", "Página inválida")
    return reply.header("cache-control","no-store").send(await authorizeRequest(request, deps, async context => {
      requirePermission(context, "fiscal.outgoing_nfse.read")
      const rows = (await context.client.query<{ id: string; number: string; accessKey: string; environment: string }>(
        `SELECT id,nfse_number AS number,access_key AS "accessKey",environment FROM fiscal_outgoing_nfse_issuances
          WHERE tenant_id=$1 AND status='authorized' AND xml IS NOT NULL ORDER BY issued_at DESC,id DESC LIMIT 26 OFFSET $2`,
        [context.tenantId, query.data.offset])).rows
      return { tenantId: context.tenantId, canSend: context.permissions.includes(permissions["outgoing-nfses"]), data: rows.slice(0,25), hasMore: rows.length > 25 }
    }))
  })
}

function registerDocumentRoutes(app: FastifyInstance, deps: AccessDependencies, io: NfeEmailIO, kind: DocumentKind) {
  app.get(endpoints[kind].GET, async (request, reply) => {
    const id = documentId(request)
    return respond(reply, await authorizeRequest(request, deps, context => load(context, id, kind)))
  })
  app.post(endpoints[kind].POST, async (request, reply) => {
    const id = documentId(request)
    const input = confirmation.safeParse(request.body)
    if (!input.success) throw new Problem(422, "invalid_input", "Confirme o e-mail apresentado na nota")
    const key = commandKey(request.headers["idempotency-key"])
    const etag = request.headers["if-match"]
    if (!etag) throw new Problem(428, "revision_required", "Consulte a prévia antes de enviar")
    if (!/^"[a-f0-9]{64}"$/.test(etag)) throw new Problem(400, "invalid_revision", "Revisão do envio inválida")
    const command = { kind, id, key, etag, recipient: input.data.recipientEmail }
    const first = await authorizeRequest(request, deps, context => prepare(context, command), false)
    if (first.saved) return respond(reply, first.snapshot, first.saved)
    const initial = first.snapshot.doc
    const pdf = initial.model === 55 ? await io.render({ issuerTaxId: initial.company_tax_id,
      xml: initial.xml, accessKey: initial.access_key, environment: initial.environment }) : null
    const reserved = await authorizeRequest(request, deps, async context => {
      // Re-read the latest recipient, document, rights and delivery history under the tenant write lock.
      const { snapshot, saved } = await prepare(context, command)
      if (saved) return { snapshot, saved }
      const company = await documentMailCompany(context)
      const sender = await io.sender(context.client)
      const deliveryId = randomUUID()
      const recipient = snapshot.result.recipientEmail!
      await context.client.query(`INSERT INTO fiscal_nfe_email_deliveries
        (id,tenant_id,document_id,auth_subject,command_key,confirmed_etag,recipient,xml_sha256,pdf_sha256,document_kind,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unknown')`,
      [deliveryId, context.tenantId, id, context.authSubject, key, etag, recipient, snapshot.xmlHash, pdf ? sha256(pdf) : null, kind])
      await record(context, request.headers, kind === "nfe" ? "fiscal_nfe_document" : kind === "received-nfses" ? "fiscal_received_nfse" : "outgoing_nfse", id, kind === "nfe" ? "fiscal.nfe.email_requested" : "fiscal.nfse.email_requested", { deliveryId })
      return { snapshot, deliveryId, sender, subject: context.authSubject, recipient, company }
    })
    if (reserved.saved) return respond(reply, reserved.snapshot, reserved.saved)
    const { tenantId } = reserved.snapshot.result
    const doc = reserved.snapshot.doc
    const outcome = await reserved.sender({ id: reserved.deliveryId, recipient: reserved.recipient, recipientName: doc.recipient_name,
      providerName: doc.provider_name, company: reserved.company, number: doc.number,
      series: doc.series, environment: doc.environment, accessKey: doc.access_key, xml: Buffer.from(doc.xml), pdf, kind: kind === "nfe" && doc.model === 65 ? "nfce" : kind })
    await finish(deps.pool, tenantId, reserved.subject, reserved.deliveryId, outcome)
    const completed = await authorizeRequest(request, deps, async context => {
      const snapshot = await load(context, id, kind)
      const delivery = await commandDelivery(context, key)
      if (!delivery) throw new Problem(503, "receipt_unavailable", "Atualize para consultar a confirmação de envio")
      return { ...snapshot, result: { ...snapshot.result, status: delivery.status, recipientEmail: delivery.recipient, sentAt: delivery.sent_at } }
    }, false)
    return respond(reply, completed)
  })
}
