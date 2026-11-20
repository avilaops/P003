import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"

import type { AccessDependencies, AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { authorizedDomain, conflict, invalid, staleRevision } from "../../platform/domain.js"
import { canonicalJson, sameJson, stringifyJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, revisionValue, type Revision } from "../../platform/revision.js"
import { docusealFromEnv, reconcile, type ContractPortal } from "../company-account/contract-webhook.js"
import { templateIds } from "../contract-templates/publish.js"
import { invitation, preview } from "./email.js"
import {
  defaults, digest, editableFields, forReconcile, generateSchema, load, notFound, publicContract, snapshot, submissionBody, templateDefaults, validate,
} from "./model.js"

const READ = "sales.orders.read"
const MANAGE = "sales.orders.manage"
const SEND = "sales.contracts.send"
const forbidden = () => new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
const notConfigured = () => conflict("Integração de contratos ainda não configurada para esta instalação")
/** Erro do provedor nunca é repetido às cegas: o próximo passo é reconciliar. */
const unavailable = () => conflict("Não foi possível confirmar o resultado no serviço de contratos. Atualize o andamento; não gere outro envio")

const contractId = z.guid()
const filter = z.strictObject({
  orderId: z.guid().optional(), customerId: z.guid().optional(),
  offset: z.string().regex(/^-?[0-9]{1,7}$/).transform(Number).optional(),
})

function send(reply: FastifyReply, value: unknown, revision?: Revision) {
  reply.header("cache-control", "no-store")
  if (revision !== undefined) reply.header("etag", `"${revision}"`)
  return reply.send(value)
}

function idParam(raw: string) {
  const parsed = contractId.safeParse(raw)
  if (!parsed.success) throw notFound()
  return parsed.data.toLowerCase()
}

/** Corpo de detalhe do contrato (ETag = revisão). */
async function detail(context: AuthorizedContext, id: string, canEdit: boolean, canSend: boolean, emailReady: boolean) {
  const contract = await load(context, id)
  const files = (await context.client.query<{ file: unknown }>("SELECT jsonb_build_object('id',id,'kind',kind,'position',position,'sha256',sha256) AS file FROM commercial_contract_files WHERE tenant_id=$1 AND contract_id=$2 ORDER BY kind,position", [context.tenantId, id])).rows.map(row => row.file)
  const delivery = (await context.client.query<{ status: string; updated_at: string }>("SELECT status,updated_at::text FROM commercial_contract_deliveries WHERE tenant_id=$1 AND contract_id=$2", [context.tenantId, id])).rows[0]
  return {
    revision: contract.revision,
    body: {
      tenantId: context.tenantId, canEdit, canSend, emailReady, packageStatus: delivery?.status ?? null, packageUpdatedAt: delivery?.updated_at ?? null,
      data: publicContract(contract), files, email: contract.sendRequestedAt === null ? preview(contract.snapshot, contract.fields) : null,
    },
  }
}

const isDatabaseError = (error: unknown) => !(error instanceof Problem) && typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string"

export function registerCommercialContracts(app: FastifyInstance, deps: AccessDependencies, injected?: ContractPortal | null) {
  const portal = injected === undefined ? docusealFromEnv() : injected ?? undefined
  const emailReady = () => portal?.emailReady() ?? false

  /** Consulta o provedor e devolve o detalhe; falha do provedor vira pendência visível, nunca reenvio. */
  const reconcileResponse = (request: Parameters<typeof authorizedDomain>[0], id: string) =>
    authorizedDomain(request, deps, READ, MANAGE, false, async (context, canEdit) => {
      const contract = await load(context, id)
      if (!portal) throw notConfigured()
      try { await reconcile(context.client, forReconcile(contract), portal) } catch (error) {
        // Erro de banco aborta a transação; não pode virar aviso do provedor.
        if (isDatabaseError(error) || (error instanceof Problem && error.status === 403)) throw error
        const message = error instanceof Problem && error.status === 409 ? error.title : "Não foi possível atualizar o andamento"
        await context.client.query("UPDATE commercial_contracts SET problem=$3 WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, message])
      }
      return detail(context, id, canEdit, context.permissions.includes(SEND), emailReady())
    })

  app.get("/api/v1/commercial-contracts", async (request, reply) => {
    const parsed = filter.safeParse(request.query)
    if (!parsed.success) throw invalid("Filtro inválido")
    const { orderId = null, customerId = null, offset = 0 } = parsed.data
    if (offset < 0 || offset > 100000) throw invalid("Página inválida")
    const body = await authorizedDomain(request, deps, READ, MANAGE, false, async (context, canEdit) => {
      const where = "WHERE tenant_id=$1 AND ($2::uuid IS NULL OR order_id=$2) AND ($3::uuid IS NULL OR customer_id=$3)"
      const total = (await context.client.query<{ total: string }>(`SELECT count(*)::text AS total FROM commercial_contracts ${where}`, [context.tenantId, orderId, customerId])).rows[0]!.total
      const data = (await context.client.query<{ item: unknown }>(`SELECT jsonb_build_object('id',id,'orderId',order_id,'customerId',customer_id,'customerName',snapshot->'customer'->>'name','templateName',template_name,'status',status,'problem',problem,'createdAt',created_at,'revision',revision) AS item FROM commercial_contracts ${where} ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $4`, [context.tenantId, orderId, customerId, offset])).rows.map(row => row.item)
      return { tenantId: context.tenantId, canEdit, data, total: revisionValue(total) }
    })
    return send(reply, body)
  })

  app.get<{ Params: { id: string } }>("/api/v1/commercial-contracts/options/:id", async (request, reply) => {
    const order = idParam(request.params.id)
    const state = await authorizedDomain(request, deps, READ, MANAGE, false, async (context, canEdit) => {
      const current = await snapshot(context, order)
      const published = (await context.client.query<{ external_id: string; draft_revision: string }>("SELECT external_id::text,draft_revision::text FROM commercial_template_versions WHERE tenant_id=$1 AND external_id IS NOT NULL", [context.tenantId])).rows
      const ids = portal ? await templateIds(context, portal) : []
      return { tenantId: context.tenantId, canEdit, current, published, ids }
    })
    // Consultas ao provedor só depois de encerrar a transação.
    const templates = []
    for (const id of portal ? state.ids : []) {
      const template = await portal!.request("GET", `templates/${id}`)
      if (template?.archived_at !== null && template?.archived_at !== undefined) continue
      const baseName = typeof template?.name === "string" ? template.name : "Modelo"
      const version = state.published.find(row => Number(row.external_id) === id)
      let generationDefaults: Record<string, string> | null = null, generationProblem: string | null = null
      try { generationDefaults = templateDefaults(state.current, template) } catch (error) {
        if (!(error instanceof Problem) || ![409, 422].includes(error.status)) throw error
        generationProblem = error.title
      }
      templates.push({ id, name: version ? `${baseName} · revisão ${version.draft_revision} (ERP)` : baseName, updatedAt: template?.updated_at ?? null,
        roles: template?.submitters ?? null, fields: editableFields(template), defaults: generationDefaults, generationProblem })
    }
    return send(reply, { tenantId: state.tenantId, canEdit: state.canEdit, configured: state.ids.length > 0, emailReady: emailReady(),
      defaults: defaults(state.current), snapshot: state.current, templates })
  })

  app.get<{ Params: { id: string } }>("/api/v1/commercial-contracts/:id", async (request, reply) => {
    const id = idParam(request.params.id)
    const result = await authorizedDomain(request, deps, READ, MANAGE, false, (context, canEdit) =>
      detail(context, id, canEdit, context.permissions.includes(SEND), emailReady()))
    return send(reply, result.body, result.revision)
  })

  app.post("/api/v1/commercial-contracts", async (request, reply) => {
    const key = commandKey(request.headers["idempotency-key"])
    const parsed = generateSchema.safeParse(request.body)
    if (!parsed.success) throw invalid("Contrato inválido")
    const original = structuredClone(parsed.data)
    const input = parsed.data
    input.orderId = input.orderId.toLowerCase()
    const claim = await authorizedDomain(request, deps, READ, MANAGE, true, async context => {
      if (!portal) throw notConfigured()
      const previous = await replay(context, key, "contract.generate", original)
      if (previous) return { id: String(previous.id), created: null }
      if (!(await templateIds(context, portal)).includes(input.templateId)) throw forbidden()
      const current = await snapshot(context, input.orderId)
      const template = await portal.request("GET", `templates/${input.templateId}`)
      if (template?.archived_at !== null && template?.archived_at !== undefined) throw conflict("Modelo arquivado")
      validate(input, template, current)
      const fingerprint = digest(canonicalJson({ request: input, snapshot: current }))
      const existing = (await context.client.query<{ id: string }>("SELECT id FROM commercial_contracts WHERE tenant_id=$1 AND fingerprint=$2", [context.tenantId, fingerprint])).rows[0]?.id
      const id = existing ?? randomUUID()
      if (!existing) {
        const customer = current?.customer?.id
        if (typeof customer !== "string") throw notFound()
        await context.client.query(`INSERT INTO commercial_contracts(id,tenant_id,customer_id,order_id,template_id,template_name,template_snapshot,snapshot,recipients,fields,fingerprint,status)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,'creation_requested')`,
          [id, context.tenantId, customer, input.orderId, input.templateId, typeof template?.name === "string" ? template.name : "Contrato",
            stringifyJson(template), stringifyJson(current), stringifyJson(input.recipients), stringifyJson(input.fields), fingerprint])
        await record(context, request.headers, "commercial_contract", id, "contract.generation_requested", { orderId: input.orderId, templateId: input.templateId })
      }
      await remember(context, key, "contract.generate", original, { id })
      // A reserva é gravada ANTES da rede: timeout, queda ou repetição só reconciliam, nunca criam de novo.
      return { id, created: existing ? null : await load(context, id) }
    })
    if (claim.created) await portal!.request("POST", "submissions", submissionBody(claim.created)).catch(() => undefined)
    const result = await reconcileResponse(request, claim.id)
    return send(reply, result.body, result.revision)
  })

  app.post<{ Params: { id: string } }>("/api/v1/commercial-contracts/:id/sync", async (request, reply) => {
    const id = idParam(request.params.id)
    const result = await reconcileResponse(request, id)
    return send(reply, result.body, result.revision)
  })

  app.post<{ Params: { id: string } }>("/api/v1/commercial-contracts/:id/review", async (request, reply) => {
    const id = idParam(request.params.id)
    const key = commandKey(request.headers["idempotency-key"])
    const expected = parseRevision(request.headers["if-match"])
    const result = await authorizedDomain(request, deps, READ, MANAGE, true, async context => {
      if (!context.permissions.includes(SEND)) throw forbidden()
      const command = { id, revision: String(expected) }
      const replayed = await replay(context, key, "contract.review", command)
      const contract = await load(context, id)
      if (!replayed) {
        if (contract.revision !== expected) throw staleRevision()
        if (contract.status !== "created" || contract.problem !== null) throw conflict("A prévia precisa estar disponível e sem pendências antes da revisão")
        const previews = (await context.client.query<{ count: string }>("SELECT count(*)::text AS count FROM commercial_contract_files WHERE tenant_id=$1 AND contract_id=$2 AND kind='preview'", [context.tenantId, id])).rows[0]!.count
        if (previews === "0") throw conflict("Aguarde a prévia do documento")
        await context.client.query("UPDATE commercial_contracts SET status='reviewed',reviewed_by=$3,reviewed_at=now(),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, context.authSubject])
        await record(context, request.headers, "commercial_contract", id, "contract.reviewed", command)
        await remember(context, key, "contract.review", command, { id })
      }
      return detail(context, id, true, true, emailReady())
    })
    return send(reply, result.body, result.revision)
  })

  app.post<{ Params: { id: string } }>("/api/v1/commercial-contracts/:id/send", async (request, reply) => {
    const id = idParam(request.params.id)
    const key = commandKey(request.headers["idempotency-key"])
    const expected = parseRevision(request.headers["if-match"])
    const claim = await authorizedDomain(request, deps, READ, MANAGE, true, async context => {
      if (!context.permissions.includes(SEND)) throw forbidden()
      if (!portal) throw notConfigured()
      const command = { id, revision: String(expected) }
      const previous = await replay(context, key, "contract.send", command)
      let contract = await load(context, id)
      if (previous || contract.sendRequestedAt !== null) {
        await ensureActiveOrder(context, contract.orderId)
        return null
      }
      if (contract.revision !== expected) throw staleRevision()
      if (contract.status !== "reviewed") throw conflict("Revise o documento e os destinatários antes do envio")
      await ensureActiveOrder(context, contract.orderId)
      // Sem SMTP validado o portal usa um carteiro de teste: só configuração confirmada envia convites.
      if (!portal.emailReady()) throw conflict("O envio de e-mail do portal ainda não foi validado. A prévia e a revisão continuam disponíveis")
      // Reconfere o estado no provedor antes de reservar o envio.
      await reconcile(context.client, forReconcile(contract), portal)
      contract = await load(context, id)
      if (contract.status !== "reviewed" || contract.problem !== null) throw conflict("O estado mudou no provedor. Confira o andamento antes do envio")
      await verifyPreview(context, contract.id, contract.externalId, portal)
      const current = await snapshot(context, contract.orderId)
      const frozen = contract.snapshot
      if (!sameJson(current?.customer?.id ?? null, frozen?.customer?.id ?? null) || !sameJson(current?.order?.amount ?? null, frozen?.order?.amount ?? null)
        || !sameJson(current?.order?.dueDate ?? null, frozen?.order?.dueDate ?? null) || !sameJson(current?.items ?? null, frozen?.items ?? null)
        || (frozen !== null && typeof frozen === "object" && "proposal" in frozen && !sameJson(current?.proposal ?? null, frozen.proposal ?? null)))
        throw conflict("O pedido mudou após a geração do contrato. Gere e revise uma nova prévia antes de enviar")
      const message = invitation(contract.snapshot, contract.fields)
      await context.client.query("UPDATE commercial_contracts SET status='send_requested',send_requested_at=now(),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])
      await remember(context, key, "contract.send", command, { id })
      await record(context, request.headers, "commercial_contract", id, "contract.send_requested",
        { externalId: contract.externalId, delivery: "order_and_contract", messageSha256: digest(canonicalJson(message)) })
      return { progress: contract.progress, message }
    })
    if (claim) {
      for (const recipient of claim.progress) {
        if (!Number.isSafeInteger(recipient?.id)) throw unavailable()
        // Uma única tentativa: mesmo resposta não-2xx pode suceder um pedido aceito; o próximo passo é reconciliar.
        await portal!.request("PUT", `submitters/${recipient.id}`, claim.message).catch(() => undefined)
      }
    }
    const result = await reconcileResponse(request, id)
    return send(reply, result.body, result.revision)
  })

  app.get<{ Params: { id: string; file: string } }>("/api/v1/commercial-contracts/:id/files/:file", async (request, reply) => {
    const id = idParam(request.params.id), file = idParam(request.params.file)
    const content = await authorizedDomain(request, deps, READ, MANAGE, false, async context => {
      const row = (await context.client.query<{ content: Buffer }>("SELECT content FROM commercial_contract_files WHERE tenant_id=$1 AND contract_id=$2 AND id=$3", [context.tenantId, id, file])).rows[0]
      if (!row) throw notFound()
      return row.content
    })
    return reply.header("content-type", "application/pdf").header("cache-control", "no-store").header("content-disposition", "inline; filename=contrato.pdf")
      .header("x-content-type-options", "nosniff").send(content)
  })
}

async function ensureActiveOrder(context: AuthorizedContext, order: string) {
  const row = (await context.client.query<{ status: string }>("SELECT status FROM sales_orders WHERE tenant_id=$1 AND id=$2", [context.tenantId, order])).rows[0]
  if (!row) throw notFound()
  if (row.status === "cancelled") throw conflict("O pedido foi cancelado; o contrato não pode ser enviado")
}

/** O documento enviado precisa ser exatamente a prévia revisada. */
async function verifyPreview(context: AuthorizedContext, id: string, external: number | null, portal: ContractPortal) {
  if (external === null) throw unavailable()
  const documents = (await portal.request("GET", `submissions/${external}/documents`))?.documents
  if (!Array.isArray(documents)) throw unavailable()
  const hashes = (await context.client.query<{ sha256: string }>("SELECT sha256 FROM commercial_contract_files WHERE tenant_id=$1 AND contract_id=$2 AND kind='preview' ORDER BY position", [context.tenantId, id])).rows.map(row => row.sha256)
  if (documents.length !== hashes.length || !hashes.length) throw conflict("A prévia mudou no portal. O envio foi bloqueado")
  for (const [index, document] of documents.entries()) {
    if (typeof document?.url !== "string") throw unavailable()
    if (digest(await portal.pdf(document.url)) !== hashes[index]) throw conflict("O documento mudou depois da revisão. O envio foi bloqueado")
  }
}
