// Distribuição CT-e somente em homologação. Cada chamada explícita reserva um lote durável;
// os bloqueios SQL são liberados antes do mTLS com a SEFAZ (feito pelo motor fiscal).
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record } from "../../platform/commands.js"
import { authorizedDomain, conflict, invalid, notFound, staleRevision } from "../../platform/domain.js"
import { parseRevision, revisionValue } from "../../platform/revision.js"
import { queryInteger } from "../registrations/query.js"
import { sha256 } from "../nfe-email/danfe.js"
import { actorOf, fiscalEngine, settle } from "../fiscal-incoming/transaction.js"
import { MAX_CTE_XML } from "./model.js"
import { CTE_NS, QUERY, READ, ZERO_NSU, companyTaxId, documentId, numericCnpj, parseXml, prefix } from "./shared.js"

const STATES = /^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/
const page = z.strictObject({ offset: queryInteger(0, 1_000_000).default(0), limit: queryInteger(1, 100).default(25) })
const nsu = z.string().regex(/^\d{15}$/)
const batchSchema = z.object({
  code: z.string().regex(/^\d{3}$/), lastNsu: nsu, maxNsu: nsu, nextNsu: nsu.nullable().optional(),
  documents: z.array(z.object({ nsu, schema: z.string(), kind: z.string(), xml: z.string() })).max(50),
})
type Batch = z.infer<typeof batchSchema>
const documentColumns = `id,run_id AS "runId",'homologation' AS environment,company_tax_id AS "companyTaxId",nsu,schema_name AS schema,kind,xml_sha256 AS "xmlSha256",verification`

export async function snapshot(c: AuthorizedContext, canQuery: boolean) {
  const row = (await c.client.query(`SELECT tenant_id AS "tenantId",company_tax_id AS "companyTaxId",last_nsu AS "lastNsu",max_nsu AS "maxNsu",revision,
    next_query_at AS "nextQueryAt",last_code AS "lastCode",coalesce(lease_until>clock_timestamp(),false) AS running
    FROM fiscal_cte_distribution_state WHERE tenant_id=$1 AND environment=2`, [c.tenantId])).rows[0]
  const base = row ?? { tenantId: c.tenantId, companyTaxId: null, lastNsu: ZERO_NSU, maxNsu: ZERO_NSU, revision: 1, nextQueryAt: null, lastCode: null, running: false }
  return { ...base, environment: "homologation", revision: revisionValue(base.revision), canQuery }
}

const schemaVersion = (schema: string, start: string) => new RegExp("^" + start + "\\d+\\.\\d+\\.xsd$").test(schema)
/** Confere ordem, intervalo e forma do lote devolvido pelo motor (mesmas regras da API Rust). */
export function parseBatch(value: unknown, requested: string): Batch | undefined {
  const parsed = batchSchema.safeParse(value)
  if (!parsed.success || !/^\d{15}$/.test(requested)) return undefined
  const b = parsed.data
  if (!["137", "138"].includes(b.code)) return b.nextNsu == null && !b.documents.length ? b : undefined
  if (b.nextNsu !== b.lastNsu || b.lastNsu < requested || b.lastNsu > b.maxNsu || (b.code === "137") !== !b.documents.length || b.code === "138" && b.lastNsu === requested) return undefined
  let previous = requested, bytes = 0
  for (const doc of b.documents) {
    bytes += Buffer.byteLength(doc.xml)
    if (doc.nsu <= previous || doc.nsu > b.lastNsu || !doc.xml || Buffer.byteLength(doc.xml) > MAX_CTE_XML || bytes > 8_388_608 ||
      doc.schema.length > 100 || !/^[A-Za-z0-9_.-]+\.xsd$/.test(doc.schema)) return undefined
    const root = parseXml(doc.xml, MAX_CTE_XML)
    if (!root) return undefined
    const full = schemaVersion(doc.schema, "procCTe_v"), event = schemaVersion(doc.schema, "procEventoCTe_v")
    if (doc.kind !== (full ? "full" : event ? "event" : "unrecognized")) return undefined
    if ((full || event) && (root.namespaceURI !== CTE_NS || root.localName !== (full ? "cteProc" : "procEventoCTe"))) return undefined
    previous = doc.nsu
  }
  return b
}

async function saveDocuments(c: AuthorizedContext, run: string, tax: string, documents: Batch["documents"]) {
  for (const doc of documents) {
    const digest = sha256(doc.xml)
    await c.client.query(`INSERT INTO fiscal_cte_distribution_documents(tenant_id,id,run_id,environment,company_tax_id,nsu,schema_name,kind,xml,xml_sha256)
      VALUES($1,$2,$3,2,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,environment,company_tax_id,nsu) DO NOTHING`, [c.tenantId, randomUUID(), run, tax, doc.nsu, doc.schema, doc.kind, doc.xml, digest])
    const same = (await c.client.query(`SELECT xml_sha256=$4 AND schema_name=$5 AND kind=$6 AND xml=$7 AS same FROM fiscal_cte_distribution_documents
      WHERE tenant_id=$1 AND environment=2 AND company_tax_id=$2 AND nsu=$3`, [c.tenantId, tax, doc.nsu, digest, doc.schema, doc.kind, doc.xml])).rows[0]?.same
    if (!same) throw conflict("NSU CT-e existente com outro conteúdo")
  }
}

export function registerCteDistribution(app: FastifyInstance, deps: AppDependencies) {
  app.get(prefix + "/status", { config: { openapi: { summary: "Cursor da distribuição CT-e (homologação)" } } }, async (req, reply) =>
    authorizedDomain(req, deps, READ, QUERY, false, async (c, canQuery) => {
      const body = await snapshot(c, canQuery && !!deps.fiscalOperations)
      return reply.header("etag", `"${body.revision}"`).header("cache-control", "no-store").send(body)
    }))

  app.get(prefix + "/documents", { config: { openapi: { summary: "Documentos CT-e distribuídos", query: page } } }, async (req, reply) =>
    authorizedDomain(req, deps, READ, QUERY, false, async c => {
      const q = page.safeParse(req.query)
      if (!q.success) throw invalid("Limite deve estar entre 1 e 100")
      const data = (await c.client.query(`SELECT ${documentColumns},created_at AS "createdAt" FROM fiscal_cte_distribution_documents
        WHERE tenant_id=$1 AND environment=2 ORDER BY id DESC LIMIT $2 OFFSET $3`, [c.tenantId, q.data.limit, q.data.offset])).rows
      const total = (await c.client.query("SELECT count(*)::int AS n FROM fiscal_cte_distribution_documents WHERE tenant_id=$1 AND environment=2", [c.tenantId])).rows[0]!.n
      return reply.header("cache-control", "no-store").send({ tenantId: c.tenantId, environment: "homologation", data, total })
    }))

  app.get<{ Params: { id: string } }>(prefix + "/documents/:id", { config: { openapi: { summary: "Documento CT-e com o XML preservado" } } }, async (req, reply) =>
    authorizedDomain(req, deps, READ, QUERY, false, async c => {
      const id = documentId(req.params.id)
      const row = (await c.client.query(`SELECT ${documentColumns},xml FROM fiscal_cte_distribution_documents WHERE tenant_id=$1 AND environment=2 AND id=$2`, [c.tenantId, id])).rows[0]
      if (!row) throw notFound()
      return reply.header("cache-control", "no-store").send(row)
    }))

  app.get<{ Params: { id: string } }>(prefix + "/runs/:id", { config: { openapi: { summary: "Execução da distribuição CT-e" } } }, async (req, reply) =>
    authorizedDomain(req, deps, READ, QUERY, false, async c => {
      const id = documentId(req.params.id)
      const row = (await c.client.query(`SELECT id AS "runId",'homologation' AS environment,company_tax_id AS "companyTaxId",requested_nsu AS "requestedNsu",status,code,
        document_count AS "documentCount",created_at AS "createdAt",completed_at AS "completedAt",result FROM fiscal_cte_distribution_runs
        WHERE tenant_id=$1 AND environment=2 AND id=$2`, [c.tenantId, id])).rows[0]
      if (!row) throw notFound()
      return reply.header("cache-control", "no-store").send(row)
    }))

  app.post(prefix + "/query", { config: { openapi: { summary: "Solicita um lote da distribuição CT-e (If-Match + Idempotency-Key)", body: z.strictObject({}) } } }, async (req, reply) => {
    const start = await authorizedDomain(req, deps, READ, QUERY, true, async c => {
      if (!z.strictObject({}).safeParse(req.body).success) throw invalid("A consulta CT-e não recebe parâmetros")
      const expected = parseRevision(req.headers["if-match"]), key = commandKey(req.headers["idempotency-key"])
      const previous = (await c.client.query("SELECT id,status,result FROM fiscal_cte_distribution_runs WHERE tenant_id=$1 AND auth_subject=$2 AND command_key=$3", [c.tenantId, c.authSubject, key])).rows[0]
      if (previous) return { prior: (previous.result ?? { ...await snapshot(c, true), runId: previous.id, status: previous.status }) as Record<string, unknown> }
      const engine = fiscalEngine(deps)
      const company = (await c.client.query("SELECT t.tax_id,p.details->>'state' AS state FROM tenants t LEFT JOIN company_profiles p ON p.tenant_id=t.id WHERE t.id=$1", [c.tenantId])).rows[0]!
      const tax = String(company.tax_id), authorState = String(company.state ?? "")
      if (!STATES.test(authorState)) throw conflict("Preencha a UF da empresa antes da consulta CT-e")
      if (!numericCnpj(tax)) throw conflict("A distribuição CT-e exige CNPJ válido da empresa")
      await c.client.query("INSERT INTO fiscal_cte_distribution_state(tenant_id,environment,company_tax_id) VALUES($1,2,$2) ON CONFLICT DO NOTHING", [c.tenantId, tax])
      const state = (await c.client.query(`SELECT last_nsu,company_tax_id,revision,coalesce(next_query_at>clock_timestamp(),false) OR coalesce(lease_until>clock_timestamp(),false) AS blocked
        FROM fiscal_cte_distribution_state WHERE tenant_id=$1 AND environment=2 FOR UPDATE`, [c.tenantId])).rows[0]!
      if (state.company_tax_id !== tax) throw conflict("O CNPJ da empresa mudou; o cursor CT-e anterior não pode ser reutilizado")
      if (revisionValue(state.revision) !== expected) throw staleRevision()
      if (state.blocked) throw conflict("Consulta CT-e em andamento ou em intervalo obrigatório")
      const material = await engine.material(c)
      if (material.issuerTaxId !== tax) throw conflict("Certificado e empresa incompatíveis")
      const id = randomUUID(), last = String(state.last_nsu)
      await c.client.query("UPDATE fiscal_cte_distribution_runs SET status='unknown',completed_at=clock_timestamp() WHERE tenant_id=$1 AND status='running'", [c.tenantId])
      // Uma queda depois do envio não pode pular a pausa de consumo na próxima concessão.
      await c.client.query(`UPDATE fiscal_cte_distribution_state SET lease_id=$2,lease_until=clock_timestamp()+interval '120 seconds',
        next_query_at=clock_timestamp()+interval '1 hour',revision=revision+1 WHERE tenant_id=$1 AND environment=2`, [c.tenantId, id])
      await c.client.query(`INSERT INTO fiscal_cte_distribution_runs(tenant_id,id,environment,company_tax_id,author_state,auth_subject,command_key,requested_nsu,status)
        VALUES($1,$2,2,$3,$4,$5,$6,$7,'running')`, [c.tenantId, id, tax, authorState, c.authSubject, key, last])
      await record(c, req.headers, "fiscal_cte_distribution", id, "fiscal.cte.distribution.requested", { environment: "homologation", lastNsu: last })
      return { id, last, tax, authorState, material, actor: actorOf(c) }
    })
    let body: Record<string, unknown>
    if ("prior" in start) body = start.prior
    else {
      const { id, last, tax, authorState, material, actor } = start
      // O certificado vai só ao motor privado; nunca é registrado nem devolvido.
      const raw = await fiscalEngine(deps).call("distribute-cte", { ...material, environment: "homologation", authorState, lastNsu: last }).catch(() => null)
      body = await settle(deps, actor, async c => {
        if (await companyTaxId(c) !== tax) throw conflict("O CNPJ da empresa mudou durante a consulta CT-e")
        const owns = (await c.client.query(`SELECT coalesce(lease_id=$2 AND lease_until>clock_timestamp(),false) AS owns FROM fiscal_cte_distribution_state
          WHERE tenant_id=$1 AND environment=2 FOR UPDATE`, [c.tenantId, id])).rows[0]?.owns
        if (!owns) throw conflict("A concessão da consulta CT-e expirou; confira a execução atual")
        let outcome = "unknown", code = "transport_uncertain", next: string | null = null, maximum: string | null = null, delay = 3600, count = 0
        if (raw) {
          const batch = parseBatch(raw, last)
          if (!batch) { outcome = "failed"; code = "invalid_batch" }
          else if (batch.nextNsu) {
            await c.client.query("SAVEPOINT cte_batch")
            try {
              await saveDocuments(c, id, tax, batch.documents)
              await c.client.query("RELEASE SAVEPOINT cte_batch")
              outcome = "completed"; code = batch.code; count = batch.documents.length
              delay = code === "137" || batch.lastNsu === batch.maxNsu ? 3600 : 2
              next = batch.lastNsu; maximum = batch.maxNsu
            } catch {
              await c.client.query("ROLLBACK TO SAVEPOINT cte_batch")
              outcome = "failed"; code = "persistence_failed"
            }
          } else { outcome = "rejected"; code = batch.code }
        }
        await c.client.query(`UPDATE fiscal_cte_distribution_state SET last_nsu=coalesce($2,last_nsu),max_nsu=greatest(max_nsu,coalesce($3,max_nsu)),last_code=$4,
          lease_id=NULL,lease_until=NULL,next_query_at=clock_timestamp()+make_interval(secs=>$5),revision=revision+1 WHERE tenant_id=$1 AND environment=2`, [c.tenantId, next, maximum, code, delay])
        const result = { ...await snapshot(c, c.permissions.includes(QUERY)), runId: id, status: outcome, documentCount: count }
        await c.client.query(`UPDATE fiscal_cte_distribution_runs SET status=$3,code=$4,document_count=$5,result=$6,completed_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2 AND status='running'`, [c.tenantId, id, outcome, code, count, result])
        await record(c, req.headers, "fiscal_cte_distribution", id, "fiscal.cte.distribution.finished", { status: outcome, code, documentCount: count })
        return result
      })
      // Direitos conferidos de novo depois da espera externa, antes de devolver o resultado.
      await authorizeRequest(req, deps, async c => { requirePermission(c, READ); requirePermission(c, QUERY) }, false)
    }
    return reply.header("etag", `"${body.revision}"`).header("cache-control", "no-store").send(body)
  })
}
