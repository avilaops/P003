// Associação comercial explícita depois da conferência local; sem efeitos contábeis.
import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import type { AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { authorizedDomain, conflict, invalid, notFound, staleRevision } from "../../platform/domain.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, revisionValue } from "../../platform/revision.js"
import { queryInteger } from "../registrations/query.js"
import { SUPPORTED_SCHEMA, VERSION, commercialFacts } from "./model.js"
import { LINK, READ, documentId, numericCnpj, prefix } from "./shared.js"

type Kind = "purchase" | "sale"
type Rights = { manage: boolean; parties: boolean; purchase: boolean; sale: boolean }
type Source = { id: string; inspection: string; hash: string; company: string; companyName: string; facts: NonNullable<ReturnType<typeof commercialFacts>> }

const forbidden = () => new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
const reason = z.string().transform(value => value.trim()).refine(value => [...value].length >= 3 && [...value].length <= 500 && !/\p{Cc}/u.test(value),
  "Descreva a conferência em 3 a 500 caracteres, sem caracteres de controle")
const freight = z.string().refine(value => /^(0|[1-9]\d{0,14})$/.test(value), "Frete deve ser informado em centavos exatos, sem sinal ou zeros à esquerda")
export const linkInput = z.strictObject({ kind: z.enum(["purchase", "sale"]), orderId: z.guid(), carrierPartyId: z.guid().nullable().optional(), freightCents: freight, reason })
export const unlinkInput = z.strictObject({ reason })
export const optionsQuery = z.strictObject({ kind: z.enum(["purchase", "sale"]), offset: queryInteger(0, 100_000).default(0), limit: queryInteger(1, 50).default(25) })
const orderTables: Record<Kind, { table: string; party: string; status: string }> = {
  purchase: { table: "purchase_orders", party: "supplier", status: "status IN ('confirmed','partially_received','received','closed')" },
  sale: { table: "sales_orders", party: "customer", status: "status IN ('confirmed','completed')" },
}
const reads = (r: Rights, kind: Kind) => kind === "purchase" ? r.purchase : r.sale
const can = (r: Rights, kind: Kind) => r.manage && r.parties && reads(r, kind)
function requireTarget(r: Rights, kind: Kind, write: boolean) { if (!r.parties || !reads(r, kind) || write && !r.manage) throw forbidden() }

async function loadSource(c: AuthorizedContext, id: string): Promise<Source> {
  const row = (await c.client.query(`SELECT d.company_tax_id,d.xml,d.xml_sha256,d.kind,d.schema_name,t.tax_id AS current_tax_id,t.legal_name
    FROM fiscal_cte_distribution_documents d JOIN tenants t ON t.id=d.tenant_id WHERE d.tenant_id=$1 AND d.id=$2 AND d.environment=2`, [c.tenantId, id])).rows[0]
  if (!row) throw notFound()
  if (row.current_tax_id !== row.company_tax_id || !numericCnpj(String(row.current_tax_id))) throw conflict("O CNPJ atual diverge da coleta; confira a empresa antes de vincular")
  if (row.kind !== "full" || row.schema_name !== SUPPORTED_SCHEMA) throw conflict("Conferência CT-e suportada obrigatória antes do vínculo")
  const inspection = (await c.client.query("SELECT id,metadata FROM fiscal_cte_inspections WHERE tenant_id=$1 AND document_id=$2 AND source_xml_sha256=$3 AND inspector_version=$4", [c.tenantId, id, row.xml_sha256, VERSION])).rows[0]
  if (!inspection) throw conflict("Confira o XML CT-e antes de criar vínculos comerciais")
  const facts = commercialFacts(inspection.metadata, String(row.xml), String(row.company_tax_id))
  if (!facts) throw conflict("A conferência não corresponde ao XML preservado; nenhum vínculo foi aplicado")
  return { id, inspection: String(inspection.id), hash: String(row.xml_sha256), company: String(row.company_tax_id), companyName: String(row.legal_name), facts }
}

function begin<T>(req: FastifyRequest<{ Params: { id: string } }>, deps: AppDependencies, write: boolean, work: (c: AuthorizedContext, rights: Rights, source: Source) => Promise<T>) {
  const id = documentId(req.params.id)
  return authorizedDomain(req, deps, READ, LINK, write, async c => {
    if (write) {
      // O BFF repete o usuário que conferiu a tela; outro usuário na mesma sessão não vincula.
      if (req.headers["x-actor-subject"] !== Buffer.from(c.authSubject).toString("base64url")) throw conflict("O usuário que conferiu mudou; atualize os arquivos antes de vincular CT-e")
    } else await c.client.query("SELECT id FROM tenants WHERE id=$1 FOR SHARE", [c.tenantId]) // revisão e linhas descrevem o mesmo estado
    const p = c.permissions
    const rights = { manage: p.includes(LINK), parties: p.includes("catalog.parties.read"), purchase: p.includes("purchasing.orders.read"), sale: p.includes("sales.orders.read") }
    return work(c, rights, await loadSource(c, id))
  })
}

const revisionOf = async (c: AuthorizedContext, doc: string) => revisionValue((await c.client.query(`SELECT 1+(SELECT count(*) FROM fiscal_cte_commercial_links WHERE tenant_id=$1 AND document_id=$2)
  +(SELECT count(*) FROM fiscal_cte_commercial_unlinks WHERE tenant_id=$1 AND document_id=$2) AS revision`, [c.tenantId, doc])).rows[0]!.revision)
const active = async (c: AuthorizedContext, doc: string) => (await c.client.query(`SELECT l.id,l.carrier_party_id,l.carrier_tax_id,l.carrier_name,l.purchase_order_id,l.sales_order_id,
  l.counterparty_name,l.order_amount_cents::text,l.order_revision,l.freight_cents::text,l.reason,l.created_at FROM fiscal_cte_commercial_links l
  WHERE l.tenant_id=$1 AND l.document_id=$2 AND NOT EXISTS(SELECT 1 FROM fiscal_cte_commercial_unlinks u WHERE u.tenant_id=l.tenant_id AND u.link_id=l.id) ORDER BY l.created_at,l.id`, [c.tenantId, doc])).rows

async function carrier(c: AuthorizedContext, s: Source, r: Rights) {
  if (s.company === s.facts.carrierTaxId) return { partyId: null, taxId: s.company, name: s.companyName, ownCompany: true, available: r.parties }
  const found = r.parties ? (await c.client.query("SELECT id,legal_name FROM parties WHERE tenant_id=$1 AND tax_id=$2 AND status='active' AND person_type='juridica'", [c.tenantId, s.facts.carrierTaxId])).rows[0] : undefined
  return { partyId: found ? String(found.id) : null, taxId: s.facts.carrierTaxId, name: found ? String(found.legal_name) : s.facts.carrierName ?? "Transportadora do XML", ownCompany: false, available: !!found }
}

async function view(c: AuthorizedContext, s: Source, r: Rights) {
  const rows = await active(c, s.id)
  const data = rows.map(row => {
    const kind: Kind = row.purchase_order_id ? "purchase" : "sale", restricted = !reads(r, kind)
    return {
      id: row.id, kind, orderId: restricted ? null : row.purchase_order_id ?? row.sales_order_id,
      carrierPartyId: r.parties ? row.carrier_party_id : null, carrierTaxId: row.carrier_tax_id,
      carrierName: r.parties ? row.carrier_name : s.facts.carrierName ?? "Transportadora do XML",
      counterpartyName: restricted ? null : row.counterparty_name, orderAmountCents: restricted ? null : row.order_amount_cents,
      orderRevision: restricted ? null : revisionValue(row.order_revision), freightCents: row.freight_cents, reason: restricted ? null : row.reason,
      createdAt: row.created_at, canUnlink: can(r, kind), restricted,
    }
  })
  const allocated = rows.reduce((sum, row) => sum + BigInt(String(row.freight_cents)), 0n)
  return {
    tenantId: c.tenantId, documentId: s.id, inspectionId: s.inspection, sourceXmlSha256: s.hash, revision: await revisionOf(c, s.id),
    serviceCents: s.facts.serviceCents.toString(), allocatedCents: allocated.toString(), canLinkPurchase: can(r, "purchase"), canLinkSale: can(r, "sale"),
    carrier: await carrier(c, s, r), data,
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown, fallback: string): z.infer<T> {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  throw invalid(parsed.error.issues.find(issue => issue.code === "custom")?.message ?? fallback)
}

export function registerCteLinks(app: FastifyInstance, deps: AppDependencies) {
  const path = prefix + "/documents/:id/commercial-links"
  app.get<{ Params: { id: string } }>(path, { config: { openapi: { summary: "Vínculos comerciais ativos do CT-e" } } }, async (req, reply) =>
    begin(req, deps, false, async (c, r, s) => {
      const result = await view(c, s, r)
      return reply.header("etag", `"${result.revision}"`).header("cache-control", "no-store").send(result)
    }))

  app.get<{ Params: { id: string } }>(prefix + "/documents/:id/commercial-options", { config: { openapi: { summary: "Pedidos elegíveis para vínculo CT-e", query: optionsQuery } } }, async (req, reply) =>
    begin(req, deps, false, async (c, r, s) => {
      const q = parse(optionsQuery, req.query, "Filtros comerciais CT-e inválidos")
      requireTarget(r, q.kind, false)
      const { table, party, status } = orderTables[q.kind]
      const data = (await c.client.query(`SELECT id,${party}_name AS "counterpartyName",${party}_tax_id AS "counterpartyTaxId",due_date::text AS "dueDate",amount_cents::text AS "amountCents",status,revision
        FROM ${table} WHERE tenant_id=$1 AND ${status} ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`, [c.tenantId, q.limit, q.offset])).rows.map(row => ({ ...row, revision: revisionValue(row.revision) }))
      const total = (await c.client.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1 AND ${status}`, [c.tenantId])).rows[0]!.n
      return reply.header("cache-control", "no-store").send({ tenantId: c.tenantId, documentId: s.id, sourceXmlSha256: s.hash, kind: q.kind, data, total, offset: q.offset, limit: q.limit })
    }))

  app.post<{ Params: { id: string } }>(path, { config: { openapi: { summary: "Vincula frete CT-e a pedido (If-Match + Idempotency-Key + X-Actor-Subject)", body: linkInput, successStatus: 201 } } }, async (req, reply) => {
    const [status, result] = await begin(req, deps, true, async (c, r, s) => {
      const input = parse(linkInput, req.body, "Informe pedido, transportadora, frete e motivo da conferência")
      requireTarget(r, input.kind, true)
      const expected = parseRevision(req.headers["if-match"]), key = commandKey(req.headers["idempotency-key"])
      const request = { documentId: s.id, inspectionId: s.inspection, xmlSha256: s.hash, revision: String(expected), input: { ...input, carrierPartyId: input.carrierPartyId ?? null } }
      if (await replay(c, key, LINK, request)) return [200, await view(c, s, r)] as const
      if (await revisionOf(c, s.id) !== expected) throw staleRevision()
      const chosen = await carrier(c, s, r)
      if (!chosen.available || chosen.partyId !== (input.carrierPartyId?.toLowerCase() ?? null)) throw conflict("Selecione a transportadora ativa com o mesmo CNPJ do XML, ou a própria empresa quando emitente")
      const { table, party, status } = orderTables[input.kind]
      const target = (await c.client.query(`SELECT ${party}_name AS name,amount_cents,revision,${status} AS eligible FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [c.tenantId, input.orderId])).rows[0]
      if (!target) throw notFound()
      if (!target.eligible) throw conflict("O pedido precisa estar confirmado e não cancelado para receber vínculo CT-e")
      const rows = await active(c, s.id)
      if (rows.length >= 50) throw conflict("Limite de 50 vínculos ativos neste CT-e")
      const column = input.kind === "purchase" ? "purchase_order_id" : "sales_order_id"
      if (rows.some(row => String(row[column]).toLowerCase() === input.orderId.toLowerCase())) throw conflict("Este pedido já possui vínculo ativo com o CT-e")
      const cents = BigInt(input.freightCents)
      if (rows.reduce((sum, row) => sum + BigInt(String(row.freight_cents)), 0n) + cents > s.facts.serviceCents) throw conflict("O frete associado ultrapassa o valor da prestação CT-e")
      const link = randomUUID()
      await c.client.query(`INSERT INTO fiscal_cte_commercial_links(tenant_id,id,document_id,inspection_id,source_xml_sha256,carrier_party_id,carrier_tax_id,carrier_name,
        purchase_order_id,sales_order_id,counterparty_name,order_amount_cents,order_revision,freight_cents,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [c.tenantId, link, s.id, s.inspection, s.hash, chosen.partyId, chosen.taxId, chosen.name, input.kind === "purchase" ? input.orderId : null, input.kind === "sale" ? input.orderId : null,
          target.name, target.amount_cents, target.revision, input.freightCents, input.reason, c.authSubject])
      await record(c, req.headers, "fiscal_cte_commercial_link", link, "fiscal.cte.linked", { documentId: s.id, inspectionId: s.inspection, xmlSha256: s.hash, kind: input.kind,
        orderId: input.orderId, carrierPartyId: chosen.partyId, freightCents: input.freightCents, reason: input.reason })
      const result = await view(c, s, r)
      await remember(c, key, LINK, request, result)
      return [201, result] as const
    })
    return reply.code(status).header("etag", `"${result.revision}"`).header("cache-control", "no-store").send(result)
  })

  app.post<{ Params: { id: string; linkId: string } }>(path + "/:linkId/unlink", { config: { openapi: { summary: "Desfaz um vínculo CT-e preservando o histórico (If-Match + Idempotency-Key + X-Actor-Subject)", body: unlinkInput } } }, async (req, reply) => {
    const result = await begin(req, deps, true, async (c, r, s) => {
      const input = parse(unlinkInput, req.body, "Informe o motivo para desfazer o vínculo"), linkId = documentId(req.params.linkId)
      const expected = parseRevision(req.headers["if-match"]), key = commandKey(req.headers["idempotency-key"])
      const link = (await c.client.query("SELECT purchase_order_id IS NOT NULL AS purchase FROM fiscal_cte_commercial_links WHERE tenant_id=$1 AND document_id=$2 AND id=$3", [c.tenantId, s.id, linkId])).rows[0]
      if (!link) throw notFound()
      requireTarget(r, link.purchase ? "purchase" : "sale", true)
      const scope = "fiscal.cte.unlink", request = { documentId: s.id, linkId, inspectionId: s.inspection, xmlSha256: s.hash, revision: String(expected), input }
      if (await replay(c, key, scope, request)) return view(c, s, r)
      if (await revisionOf(c, s.id) !== expected) throw staleRevision()
      if ((await c.client.query("SELECT 1 FROM fiscal_cte_commercial_unlinks WHERE tenant_id=$1 AND link_id=$2", [c.tenantId, linkId])).rows.length) throw conflict("Este vínculo já foi desfeito; o histórico foi preservado")
      const removal = randomUUID()
      await c.client.query("INSERT INTO fiscal_cte_commercial_unlinks(tenant_id,id,document_id,link_id,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)", [c.tenantId, removal, s.id, linkId, input.reason, c.authSubject])
      await record(c, req.headers, "fiscal_cte_commercial_link", linkId, "fiscal.cte.unlinked", { documentId: s.id, unlinkId: removal, linkId, xmlSha256: s.hash, reason: input.reason })
      const result = await view(c, s, r)
      await remember(c, key, scope, request, result)
      return result
    })
    return reply.header("etag", `"${result.revision}"`).header("cache-control", "no-store").send(result)
  })
}
