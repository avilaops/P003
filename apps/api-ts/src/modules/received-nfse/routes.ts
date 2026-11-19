// Importação manual de XML nacional de NFS-e recebida. Sem emissão nem transporte com a autoridade.
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import type { AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { authorizedDomain, conflict, invalid, notFound } from "../../platform/domain.js"
import { Problem } from "../../platform/problem.js"
import { queryInteger } from "../registrations/query.js"
import { sha256 } from "../nfe-email/danfe.js"
import { documentId, numericCnpj } from "../fiscal-cte/shared.js"
import { MAX_NFSE_XML, correlate } from "./model.js"

const prefix = "/api/v1/fiscal/received-nfses"
const READ = "fiscal.nfse.read", IMPORT = "fiscal.nfse.import", SCOPE = "fiscal.received_nfse.import"
const page = z.strictObject({ offset: queryInteger(0, 1_000_000).default(0), limit: queryInteger(1, 100).default(25) })
const importInput = z.strictObject({ xml: z.string() })
const columns = `id,company_tax_id AS "companyTaxId",metadata AS document,created_at AS "createdAt"`

async function company(c: AuthorizedContext) {
  const tax = String((await c.client.query("SELECT tax_id FROM tenants WHERE id=$1", [c.tenantId])).rows[0]!.tax_id)
  if (!numericCnpj(tax)) throw conflict("Configure um CNPJ numérico válido antes da importação nacional")
  return tax
}
async function load(c: AuthorizedContext, id: string) {
  const row = (await c.client.query(`SELECT ${columns} FROM fiscal_received_nfses WHERE tenant_id=$1 AND id=$2`, [c.tenantId, id])).rows[0]
  if (!row) throw notFound()
  return row
}
const unavailable = () => new Problem(502, "nfse_inspection_failed", "A inspeção da NFS-e não foi confirmada; nenhum documento foi salvo")

export function registerReceivedNfse(app: FastifyInstance, deps: AppDependencies) {
  app.get(prefix, { config: { openapi: { summary: "NFS-e recebidas importadas", query: page } } }, async (req, reply) =>
    authorizedDomain(req, deps, READ, IMPORT, false, async (c, canImport) => {
      const q = page.safeParse(req.query)
      if (!q.success) throw invalid("Limite deve estar entre 1 e 100")
      const data = (await c.client.query(`SELECT ${columns} FROM fiscal_received_nfses WHERE tenant_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3`, [c.tenantId, q.data.limit, q.data.offset])).rows
      const total = (await c.client.query("SELECT count(*)::int AS n FROM fiscal_received_nfses WHERE tenant_id=$1", [c.tenantId])).rows[0]!.n
      return reply.header("cache-control", "no-store").send({ tenantId: c.tenantId, canImport: canImport && !!deps.fiscalOperations, data, total })
    }))

  app.post(prefix + "/import", { bodyLimit: 2 * 1024 * 1024, config: { openapi: { summary: "Importa XML nacional de NFS-e recebida (Idempotency-Key)", body: importInput, successStatus: 201 } } }, async (req, reply) => {
    // Autoriza antes de inspecionar XML não confiável; nenhum bloqueio fica aberto durante a inspeção.
    const first = await authorizedDomain(req, deps, READ, IMPORT, true, async c => {
      const input = importInput.safeParse(req.body)
      if (!input.success) throw invalid("JSON inválido; envie somente xml em corpo de até 2 MiB")
      const xml = input.data.xml
      if (!xml || Buffer.byteLength(xml) > MAX_NFSE_XML || xml.includes("\0")) throw invalid("XML vazio, inválido ou acima de 1 MiB")
      const key = commandKey(req.headers["idempotency-key"]), tax = await company(c), hash = sha256(xml)
      const request = { xmlSha256: hash, companyTaxId: tax }
      const previous = await replay(c, key, SCOPE, request)
      return previous ? { done: previous } : { xml, key, tax, hash, request }
    })
    if ("done" in first) return reply.code(200).header("cache-control", "no-store").send(first.done)
    const { xml, key, tax, hash, request } = first
    if (!deps.fiscalOperations) throw new Problem(503, "nfse_engine_unavailable", "Motor de inspeção nacional não configurado")
    const result = await deps.fiscalOperations.call("inspect-nfse", { xml, recipientTaxId: tax }).catch(() => { throw unavailable() })
    if (result.status === "blocked") {
      if (JSON.stringify(result.blockers) === '["invalid_nfse_xml"]') throw new Problem(422, "invalid_nfse_xml", "XML nacional recusado pela inspeção de leiaute e identidade")
      throw unavailable()
    }
    const data = correlate(result, xml, tax)
    if (!data) throw unavailable()
    const [status, body] = await authorizedDomain(req, deps, READ, IMPORT, true, async c => {
      if (await company(c) !== tax) throw conflict("O CNPJ da empresa mudou durante a inspeção; confira a empresa e tente novamente")
      const previous = await replay(c, key, SCOPE, request)
      if (previous) return [200, previous] as const
      const existing = (await c.client.query("SELECT id,xml_sha256 FROM fiscal_received_nfses WHERE tenant_id=$1 AND source=$2 AND environment=$3 AND access_key=$4",
        [c.tenantId, data.source, data.environment, data.accessKey])).rows[0]
      let id: string, code: number
      if (existing) {
        if (existing.xml_sha256 !== hash) throw conflict("Já existe outro XML para esta chave nacional e ambiente; o arquivo original foi preservado")
        id = String(existing.id); code = 200
      } else {
        id = randomUUID(); code = 201
        await c.client.query(`INSERT INTO fiscal_received_nfses(tenant_id,id,source,environment,access_key,company_tax_id,xml,xml_sha256,metadata,auth_subject)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [c.tenantId, id, data.source, data.environment, data.accessKey, tax, xml, hash, data, c.authSubject])
        await record(c, req.headers, "fiscal_received_nfse", id, "fiscal.received_nfse.imported",
          { id, source: data.source, environment: data.environment, xmlSha256: hash, verification: "signature_and_current_status_pending" })
      }
      const value = { tenantId: c.tenantId, data: await load(c, id) }
      await remember(c, key, SCOPE, request, value)
      return [code, value] as const
    })
    return reply.code(status).header("cache-control", "no-store").send(body)
  })

  app.get<{ Params: { id: string } }>(prefix + "/:id", { config: { openapi: { summary: "NFS-e recebida" } } }, async (req, reply) =>
    authorizedDomain(req, deps, READ, IMPORT, false, async c =>
      reply.header("cache-control", "no-store").send({ tenantId: c.tenantId, data: await load(c, documentId(req.params.id)) })))

  app.get<{ Params: { id: string } }>(prefix + "/:id/xml", { config: { openapi: { summary: "XML original da NFS-e recebida (assinatura e situação não verificadas)" } } }, async (req, reply) =>
    authorizedDomain(req, deps, READ, IMPORT, false, async c => {
      const row = (await c.client.query("SELECT access_key,xml,xml_sha256 FROM fiscal_received_nfses WHERE tenant_id=$1 AND id=$2", [c.tenantId, documentId(req.params.id)])).rows[0]
      if (!row) throw notFound()
      if (sha256(String(row.xml)) !== row.xml_sha256) throw new Problem(409, "document_conflict", "A integridade do XML armazenado não foi confirmada")
      return reply.type("application/xml; charset=utf-8").header("content-disposition", `attachment; filename="NFSE-${row.access_key}.xml"`)
        .header("cache-control", "no-store").header("x-content-type-options", "nosniff").header("x-xml-sha256", row.xml_sha256).send(String(row.xml))
    }))
}
