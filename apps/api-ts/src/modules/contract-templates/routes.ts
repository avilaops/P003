import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"

import type { AccessDependencies } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { authorizedDomain, conflict, invalid, staleRevision } from "../../platform/domain.js"
import { canonicalJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, revisionValue, type Revision } from "../../platform/revision.js"
import { docusealFromEnv, type ContractPortal } from "../company-account/contract-webhook.js"
import { digest } from "../commercial-contracts/model.js"
import { definitionSchema, normalized, validateDefinition } from "./definition.js"
import { definitionFromTemplate } from "./import.js"
import { templateIds } from "./publish.js"

const READ = "sales.orders.read"
const MANAGE = "platform.integrations.manage"
const BODY_LIMIT = 8 * 1024 * 1024
const PDF_LIMIT = 5 * 1024 * 1024
const notFound = () => new Problem(404, "not_found", "Registro não encontrado nesta empresa")
const forbidden = () => new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
const notConfigured = () => conflict("Integração de contratos ainda não configurada para esta instalação")
const saveSchema = z.strictObject({ definition: definitionSchema, pdfBase64: z.string().nullable().optional() })
const importSchema = z.strictObject({ templateId: z.number().int() })
const isPdf = (bytes: Buffer) => bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
const archived = (template: any) => template?.archived_at !== null && template?.archived_at !== undefined

function send(reply: FastifyReply, value: unknown, revision?: Revision) {
  reply.header("cache-control", "no-store")
  if (revision !== undefined) reply.header("etag", `"${revision}"`)
  return reply.send(value)
}
function draftId(raw: string) {
  const parsed = z.guid().safeParse(raw)
  if (!parsed.success) throw notFound()
  return parsed.data.toLowerCase()
}
/** Base64 padrão estrito (como o decodificador do Rust): nada de caracteres ignorados em silêncio. */
function decodePdf(value: string) {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid("PDF inválido")
  return Buffer.from(value, "base64")
}

export function registerContractTemplateDrafts(app: FastifyInstance, deps: AccessDependencies, injected?: ContractPortal | null) {
  const portal = injected === undefined ? docusealFromEnv() : injected ?? undefined

  app.get("/api/v1/contract-template-drafts", async (request, reply) => {
    const body = await authorizedDomain(request, deps, READ, MANAGE, false, async (context, canEdit) => {
      const data = (await context.client.query<{ item: unknown }>(`SELECT jsonb_build_object('id',d.id,'name',d.definition->>'name','revision',d.revision,'updatedAt',d.updated_at,
        'publishedRevision',(SELECT max(v.draft_revision) FROM commercial_template_versions v WHERE v.tenant_id=d.tenant_id AND v.draft_id=d.id AND v.external_id IS NOT NULL)) AS item
        FROM commercial_template_drafts d WHERE d.tenant_id=$1 ORDER BY d.updated_at DESC LIMIT 100`, [context.tenantId])).rows.map(row => row.item)
      return { tenantId: context.tenantId, canEdit, data }
    })
    return send(reply, body)
  })

  app.get("/api/v1/contract-template-drafts/catalog", async (request, reply) => {
    const state = await authorizedDomain(request, deps, READ, MANAGE, false, async (context, canEdit) => {
      const imported = (await context.client.query<{ source: string; id: string }>("SELECT source_template_id::text AS source,id FROM commercial_template_drafts WHERE tenant_id=$1 AND source_template_id IS NOT NULL", [context.tenantId])).rows
      return { tenantId: context.tenantId, canEdit, imported }
    })
    // O provedor só é consultado depois de encerrar a transação.
    const data = []
    for (const id of portal?.templateIds(state.tenantId) ?? []) {
      const template = await portal!.request("GET", `templates/${id}`)
      if (archived(template)) continue
      let canImport = true
      try { definitionFromTemplate(template) } catch (error) { if (!(error instanceof Problem)) throw error; canImport = false }
      data.push({ id, name: template?.name ?? null, updatedAt: template?.updated_at ?? null, canImport, draftId: state.imported.find(row => Number(row.source) === id)?.id ?? null })
    }
    return send(reply, { tenantId: state.tenantId, canEdit: state.canEdit, configured: portal !== undefined, data })
  })

  app.get<{ Params: { id: string } }>("/api/v1/contract-template-drafts/:id", async (request, reply) => {
    const id = draftId(request.params.id)
    const body = await authorizedDomain(request, deps, READ, MANAGE, false, async (context, canEdit) => {
      const draft = (await context.client.query<{ definition: unknown; revision: string }>("SELECT definition,revision::text FROM commercial_template_drafts WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])).rows[0]
      if (!draft) throw notFound()
      const versions = (await context.client.query<{ version: unknown }>("SELECT jsonb_build_object('revision',draft_revision,'externalId',external_id,'status',CASE WHEN external_id IS NULL THEN 'pending' ELSE 'published' END) AS version FROM commercial_template_versions WHERE tenant_id=$1 AND draft_id=$2 ORDER BY draft_revision DESC", [context.tenantId, id])).rows.map(row => row.version)
      return { tenantId: context.tenantId, canEdit, id, definition: draft.definition, revision: revisionValue(draft.revision), versions }
    })
    return send(reply, body, body.revision)
  })

  app.post<{ Params: { id: string } }>("/api/v1/contract-template-drafts/:id", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const id = draftId(request.params.id)
    const key = commandKey(request.headers["idempotency-key"])
    const parsed = saveSchema.safeParse(request.body)
    if (!parsed.success) throw invalid("Modelo inválido")
    const value = await authorizedDomain(request, deps, READ, MANAGE, true, async context => {
      validateDefinition(parsed.data.definition)
      const definition = normalized(parsed.data.definition)
      const bytes = typeof parsed.data.pdfBase64 === "string" ? decodePdf(parsed.data.pdfBase64) : undefined
      if (bytes && (bytes.length > PDF_LIMIT || !isPdf(bytes))) throw invalid("Envie um PDF de até 5 MiB")
      // O histórico de comandos guarda só o resumo do PDF, não uma segunda cópia.
      const command = { id, definition, pdfHash: bytes ? digest(bytes) : null }
      // Serializa também a criação: a chave primária sozinha não bloqueia uma linha inexistente.
      await context.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`template:${context.tenantId}:${id}`])
      const previous = await replay(context, key, "template.draft.save", command)
      if (previous) return previous as { revision: Revision }
      const existing = (await context.client.query<{ revision: string }>("SELECT revision::text FROM commercial_template_drafts WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, id])).rows[0]
      let revision: Revision
      if (existing) {
        if (parseRevision(request.headers["if-match"]) !== revisionValue(existing.revision)) throw staleRevision()
        revision = revisionValue((await context.client.query<{ revision: string }>("UPDATE commercial_template_drafts SET definition=$3,pdf=COALESCE($4,pdf),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING revision::text",
          [context.tenantId, id, definition, bytes ?? null])).rows[0]!.revision)
      } else {
        if (request.headers["if-match"] !== undefined) throw staleRevision()
        if (!bytes) throw invalid("Selecione o PDF do novo modelo")
        await context.client.query("INSERT INTO commercial_template_drafts(tenant_id,id,definition,pdf) VALUES($1,$2,$3,$4)", [context.tenantId, id, definition, bytes])
        revision = 1
      }
      const result = { tenantId: context.tenantId, canEdit: true, id, definition, revision }
      await record(context, request.headers, "contract_template_draft", id, "contract_template.draft_saved", { revision, fieldCount: definition.fields.length })
      await remember(context, key, "template.draft.save", command, result)
      return result
    })
    return send(reply, value, revisionValue(value.revision))
  })

  app.get<{ Params: { id: string } }>("/api/v1/contract-template-drafts/:id/pdf", async (request, reply) => {
    const id = draftId(request.params.id)
    const pdf = await authorizedDomain(request, deps, READ, MANAGE, false, async context => {
      const row = (await context.client.query<{ pdf: Buffer }>("SELECT pdf FROM commercial_template_drafts WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])).rows[0]
      if (!row) throw notFound()
      return row.pdf
    })
    return reply.header("content-type", "application/pdf").header("cache-control", "no-store").header("content-disposition", "inline; filename=\"modelo.pdf\"")
      .header("x-content-type-options", "nosniff").send(pdf)
  })

  app.post<{ Params: { id: string } }>("/api/v1/contract-template-drafts/:id/import", async (request, reply) => {
    const id = draftId(request.params.id)
    const key = commandKey(request.headers["idempotency-key"])
    const parsed = importSchema.safeParse(request.body)
    if (!parsed.success) throw invalid("Modelo inválido")
    const { templateId } = parsed.data
    const value = await authorizedDomain(request, deps, READ, MANAGE, true, async context => {
      if (!portal) throw notConfigured()
      if (!portal.templateIds(context.tenantId).includes(templateId)) throw forbidden()
      // Uma cópia editável por origem e empresa, mesmo com cliques simultâneos e chaves diferentes.
      await context.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`template-import:${context.tenantId}:${templateId}`])
      const command = { id, templateId }
      const previous = await replay(context, key, "template.import", command)
      if (previous) return previous as { revision: Revision }
      let target = (await context.client.query<{ id: string }>("SELECT id FROM commercial_template_drafts WHERE tenant_id=$1 AND source_template_id=$2", [context.tenantId, templateId])).rows[0]?.id
      if (!target) {
        const template = await portal.request("GET", `templates/${templateId}`)
        if (archived(template)) throw conflict("Modelo arquivado")
        const definition = definitionFromTemplate(template)
        const url = template?.documents?.[0]?.url
        if (typeof url !== "string") throw invalid("PDF do modelo indisponível")
        const pdf = await portal.pdf(url)
        if (pdf.length > PDF_LIMIT) throw invalid("O modelo excede 5 MiB")
        const inserted = await context.client.query("INSERT INTO commercial_template_drafts(tenant_id,id,definition,pdf,source_template_id,source_snapshot) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,id) DO NOTHING RETURNING id",
          [context.tenantId, id, definition, pdf, templateId, template])
        if (inserted.rows.length !== 1) throw conflict("Este rascunho já existe. Abra o modelo salvo")
        await record(context, request.headers, "contract_template_draft", id, "contract_template.imported", { sourceTemplateId: templateId, sourceUpdatedAt: template?.updated_at ?? null })
        target = id
      }
      const revision = revisionValue((await context.client.query<{ revision: string }>("SELECT revision::text FROM commercial_template_drafts WHERE tenant_id=$1 AND id=$2", [context.tenantId, target])).rows[0]!.revision)
      const result = { id: target, tenantId: context.tenantId, revision }
      await remember(context, key, "template.import", command, result)
      return result
    })
    return send(reply, value, revisionValue(value.revision))
  })

  app.post<{ Params: { id: string } }>("/api/v1/contract-template-drafts/:id/publish", async (request, reply) => {
    const id = draftId(request.params.id)
    const key = commandKey(request.headers["idempotency-key"])
    const expected = parseRevision(request.headers["if-match"])
    const version = await authorizedDomain(request, deps, READ, MANAGE, true, async context => {
      if (!portal) throw notConfigured()
      await context.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`template:${context.tenantId}:${id}`])
      const command = { id, revision: String(expected) }
      const previous = await replay(context, key, "template.publish", command)
      let versionId: string
      if (previous) versionId = String(previous.id)
      else {
        const draft = (await context.client.query<{ definition: unknown; pdf: Buffer; revision: string }>("SELECT definition,pdf,revision::text FROM commercial_template_drafts WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, id])).rows[0]
        if (!draft) throw notFound()
        if (revisionValue(draft.revision) !== expected) throw staleRevision()
        const parsed = definitionSchema.safeParse(draft.definition)
        if (!parsed.success) throw invalid("Modelo inválido")
        validateDefinition(parsed.data)
        if (parsed.data.roles.some(role => !parsed.data.fields.some(field => field.role === role && field.kind === "signature" && field.required)))
          throw invalid("Inclua uma assinatura obrigatória para cada participante")
        const raw = canonicalJson(draft.definition)
        const hash = digest(`${digest(draft.pdf)}:${raw}`)
        versionId = (await context.client.query<{ id: string }>(`INSERT INTO commercial_template_versions(tenant_id,id,draft_id,draft_revision,definition_json,pdf,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(tenant_id,draft_id,draft_revision) DO UPDATE SET draft_id=EXCLUDED.draft_id RETURNING id`, [context.tenantId, randomUUID(), id, String(expected), raw, draft.pdf, hash])).rows[0]!.id
        await remember(context, key, "template.publish", command, { id: versionId })
      }
      const row = (await context.client.query<{ definition_json: string; pdf: Buffer; request_hash: string; external_id: string | null }>(
        "SELECT definition_json,pdf,request_hash,external_id::text FROM commercial_template_versions WHERE tenant_id=$1 AND id=$2", [context.tenantId, versionId])).rows[0]!
      return { versionId, ...row }
    })
    const published = (external: number) => send(reply, { id: version.versionId, externalId: external, revision: expected, status: "published" }, expected)
    if (version.external_id !== null) return published(Number(version.external_id))
    // Toda repetição reconcilia antes de enviar; o portal serializa este identificador de publicação.
    const path = `avila/templates/${version.versionId}`
    let confirmed = await portal!.request("GET", path)
    if (confirmed?.found === false) confirmed = await portal!.request("POST", path, { definitionJson: version.definition_json, pdfBase64: version.pdf.toString("base64") })
    if (confirmed?.found !== true || confirmed?.requestHash !== version.request_hash || confirmed?.archived !== false)
      throw conflict("Publicação divergente ou arquivada no serviço. Confira o modelo antes de continuar")
    const external = confirmed?.id
    if (!Number.isSafeInteger(external) || external <= 0) throw conflict("O serviço não confirmou o modelo")
    await authorizedDomain(request, deps, READ, MANAGE, true, async context => {
      const changed = await context.client.query("UPDATE commercial_template_versions SET external_id=$3,published_at=now() WHERE tenant_id=$1 AND id=$2 AND external_id IS NULL RETURNING id", [context.tenantId, version.versionId, external])
      if (changed.rows.length === 1)
        await record(context, request.headers, "contract_template_version", version.versionId, "contract_template.published", { draftId: id, revision: expected, externalId: external, requestHash: version.request_hash })
    })
    return published(external)
  })
}
