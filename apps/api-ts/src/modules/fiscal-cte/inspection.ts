// Conferência offline e auditada de um CT-e preservado; não altera o cursor da distribuição.
import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import type { AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { authorizedDomain, conflict, invalid, notFound } from "../../platform/domain.js"
import { Problem } from "../../platform/problem.js"
import { PROFILE, SUPPORTED_SCHEMA, VERSION, correlate } from "./model.js"
import { INSPECT, READ, companyTaxId, documentId, numericCnpj, prefix } from "./shared.js"

type Source = { id: string; company_tax_id: string; schema_name: string; kind: string; xml: string; xml_sha256: string }
const supported = (s: Source) => s.kind === "full" && s.schema_name === SUPPORTED_SCHEMA
const matchesCompany = (current: string, s: Source) => current === s.company_tax_id && numericCnpj(current)

async function source(c: AuthorizedContext, id: string) {
  const row = (await c.client.query<Source>("SELECT id,company_tax_id,schema_name,kind,xml,xml_sha256 FROM fiscal_cte_distribution_documents WHERE tenant_id=$1 AND id=$2 AND environment=2", [c.tenantId, id])).rows[0]
  return row ?? (() => { throw notFound() })()
}
async function cached(c: AuthorizedContext, s: Source) {
  return (await c.client.query(`SELECT id,document_id AS "documentId",source_xml_sha256 AS "sourceXmlSha256",inspector_version AS "inspectorVersion",metadata AS document,created_at AS "createdAt"
    FROM fiscal_cte_inspections WHERE tenant_id=$1 AND document_id=$2 AND source_xml_sha256=$3 AND inspector_version=$4`, [c.tenantId, s.id, s.xml_sha256, VERSION])).rows[0] ?? null
}
const detail = (c: AuthorizedContext, s: Source, canInspect: boolean, data: unknown) =>
  ({ tenantId: c.tenantId, documentId: s.id, sourceXmlSha256: s.xml_sha256, canInspect, data })
const unconfirmed = () => new Problem(502, "cte_inspection_failed", "A conferência CT-e não foi confirmada; o XML original foi preservado")
const send = (reply: FastifyReply, status: number, body: unknown) => reply.code(status).header("cache-control", "no-store").send(body)

export function registerCteInspection(app: FastifyInstance, deps: AppDependencies) {
  app.get<{ Params: { id: string } }>(prefix + "/documents/:id/inspection", { config: { openapi: { summary: "Conferência CT-e gravada para o XML preservado" } } }, async (req, reply) =>
    authorizedDomain(req, deps, READ, INSPECT, false, async (c, canInspect) => {
      const s = await source(c, documentId(req.params.id)), current = await companyTaxId(c), data = await cached(c, s)
      const capable = canInspect && supported(s) && matchesCompany(current, s) && (!!deps.fiscalOperations || !!data)
      return send(reply, 200, detail(c, s, capable, data))
    }))

  app.post<{ Params: { id: string } }>(prefix + "/documents/:id/inspect", { bodyLimit: 1024, config: { openapi: { summary: "Confere offline o CT-e preservado (Idempotency-Key)", body: z.strictObject({}), successStatus: 201 } } }, async (req, reply) => {
    const id = documentId(req.params.id)
    const first = await authorizedDomain(req, deps, READ, INSPECT, true, async c => {
      if (!z.strictObject({}).safeParse(req.body).success) throw invalid("Envie somente um objeto JSON vazio para conferir o arquivo preservado")
      const key = commandKey(req.headers["idempotency-key"])
      const original = await source(c, id), tax = await companyTaxId(c)
      if (!matchesCompany(tax, original)) throw conflict("O CNPJ atual diverge da coleta; confira a identidade da empresa antes de inspecionar")
      if (!supported(original)) throw new Problem(422, "cte_profile_unsupported", "Formato preservado fora do perfil de conferência disponível")
      const request = { documentId: id, xmlSha256: original.xml_sha256, companyTaxId: tax, inspectorVersion: VERSION, profile: PROFILE }
      const previous = await replay(c, key, INSPECT, request)
      if (previous) return { done: previous }
      const existing = await cached(c, original)
      if (existing) {
        const result = detail(c, original, true, existing)
        await remember(c, key, INSPECT, request, result)
        return { done: result }
      }
      return { key, original, tax, request }
    })
    if ("done" in first) return send(reply, 200, first.done)
    const { key, original, tax, request } = first
    if (!deps.fiscalOperations) throw new Problem(503, "cte_inspector_unavailable", "Motor de conferência CT-e não configurado")
    const result = await deps.fiscalOperations.call("inspect-cte", { xml: original.xml, companyTaxId: tax, environment: "homologation" }).catch(() => { throw unconfirmed() })
    if (result.status === "blocked") {
      const blockers = JSON.stringify(result.blockers)
      const code = blockers === '["invalid_cte_xml"]' ? "invalid_cte_xml" : blockers === '["cte_profile_unsupported"]' ? "cte_profile_unsupported" : null
      if (!code) throw unconfirmed()
      throw new Problem(422, code, "Arquivo preservado, mas não conferido pelo perfil CT-e disponível")
    }
    const metadata = correlate(result, original.xml, tax)
    if (!metadata || metadata.xmlSha256 !== original.xml_sha256) throw unconfirmed()
    const [status, body] = await authorizedDomain(req, deps, READ, INSPECT, true, async c => {
      const current = await companyTaxId(c), s = await source(c, id)
      if (current !== tax || !matchesCompany(current, s) || s.xml_sha256 !== original.xml_sha256 || s.xml !== original.xml)
        throw conflict("Empresa ou arquivo mudou durante a conferência; nenhum resultado foi gravado")
      const previous = await replay(c, key, INSPECT, request)
      if (previous) return [200, previous] as const
      let data = await cached(c, s)
      const created = !data
      if (!data) {
        const inspection = randomUUID()
        data = (await c.client.query(`INSERT INTO fiscal_cte_inspections(tenant_id,id,document_id,source_xml_sha256,inspector_version,schema_release,metadata,inspected_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,document_id AS "documentId",source_xml_sha256 AS "sourceXmlSha256",inspector_version AS "inspectorVersion",metadata AS document,created_at AS "createdAt"`,
          [c.tenantId, inspection, id, s.xml_sha256, VERSION, PROFILE, metadata, c.authSubject])).rows[0]!
        await record(c, req.headers, "fiscal_cte_inspection", inspection, "fiscal.cte.inspected", { documentId: id, xmlSha256: s.xml_sha256, inspectorVersion: VERSION, profile: PROFILE })
      }
      const value = detail(c, s, true, data)
      await remember(c, key, INSPECT, request, value)
      return [created ? 201 : 200, value] as const
    })
    return send(reply, status, body)
  })
}
