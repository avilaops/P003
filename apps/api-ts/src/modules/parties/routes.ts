import { randomUUID } from "node:crypto"

import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { sameJson } from "../../platform/json.js"
import { integer } from "../registrations/query.js"
import { partyInputSchema, type PartyInput } from "./schema.js"

const partyQuerySchema = z.strictObject({
  q: z.string().max(160).default(""), status: z.enum(["active", "archived"]).optional(),
  role: z.enum(["customer", "supplier"]).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

function header(value: string | string[] | undefined) { return Array.isArray(value) ? undefined : value }
function revision(value: string | string[] | undefined) { const match = /^"([1-9]\d*)"$/.exec(header(value) ?? ""); if (!value) throw new Problem(428, "revision_required", "Recarregue o cadastro antes de salvar"); if (!match) throw new Problem(400, "invalid_revision", "Revisão inválida"); return Number(match[1]) }
function command(value: string | string[] | undefined) { if (!value) throw new Problem(428, "idempotency_required", "Informe a chave de idempotência"); const parsed = z.string().uuid().safeParse(header(value)); if (!parsed.success) throw new Problem(422, "invalid_input", "Chave de idempotência inválida"); return parsed.data }

const projection = "id,revision,person_type,legal_name,trade_name,tax_id,email,phone,is_customer,is_supplier,status,addresses,contacts,fiscal"

async function validateSettings(context: AuthorizedContext, input: PartyInput) {
  const settings = await context.client.query<{ data: { requireEmail?: boolean; requirePhone?: boolean } }>("SELECT data FROM registration_settings WHERE tenant_id=$1 AND section='parties'", [context.tenantId])
  const data = settings.rows[0]?.data ?? {}
  if (data.requireEmail && !input.email || data.requirePhone && !input.phone) throw new Problem(422, "invalid_input", "E-mail ou telefone obrigatório conforme a configuração da empresa")
}

function party(row: Record<string, unknown>) {
  return {
    id: row.id, revision: integer(row.revision), personType: row.person_type,
    legalName: row.legal_name, tradeName: row.trade_name, taxId: row.tax_id,
    email: row.email, phone: row.phone, isCustomer: row.is_customer,
    isSupplier: row.is_supplier, status: row.status, fiscal: row.fiscal,
    addresses: row.addresses ?? [], contacts: row.contacts ?? [],
  }
}
export function registerPartyRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/parties", async (request, reply) => {
    const parsed = partyQuerySchema.safeParse(request.query)
    if (!parsed.success) throw new Problem(422, "invalid_input", "Busca, paginação, situação ou papel inválido")
    const query = { ...parsed.data, q: parsed.data.q.trim() }
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.parties.read")
      const canEdit = context.permissions.includes("catalog.parties.manage")
      const rows = await context.client.query(
        "SELECT id,revision,person_type,legal_name,trade_name,tax_id,email,phone,is_customer,is_supplier,status,addresses,contacts,fiscal FROM parties WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND (strpos(lower(legal_name),lower($3))>0 OR strpos(lower(COALESCE(trade_name,'')),lower($3))>0 OR strpos(tax_id,upper($3))>0) AND ($4::text IS NULL OR ($4='customer' AND is_customer) OR ($4='supplier' AND is_supplier)) ORDER BY legal_name,id LIMIT $5 OFFSET $6",
        [context.tenantId, query.status ?? null, query.q, query.role ?? null, query.limit, query.offset],
      )
      const count = await context.client.query<{ total: string }>(
        "SELECT count(*)::text AS total FROM parties WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND (strpos(lower(legal_name),lower($3))>0 OR strpos(lower(COALESCE(trade_name,'')),lower($3))>0 OR strpos(tax_id,upper($3))>0) AND ($4::text IS NULL OR ($4='customer' AND is_customer) OR ($4='supplier' AND is_supplier))",
        [context.tenantId, query.status ?? null, query.q, query.role ?? null],
      )
      return { tenantId: context.tenantId, canEdit, data: rows.rows.map(party), total: integer(count.rows[0]?.total ?? 0), offset: query.offset, limit: query.limit }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.get<{ Params: { id: string } }>("/api/v1/parties/:id", async (request, reply) => {
    if (!z.string().uuid().safeParse(request.params.id).success) throw new Problem(404, "not_found", "Cadastro não encontrado")
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.parties.read")
      const result = await context.client.query(`SELECT ${projection} FROM parties WHERE tenant_id=$1 AND id=$2`, [context.tenantId, request.params.id])
      if (!result.rows[0]) throw new Problem(404, "not_found", "Cadastro não encontrado")
      return { tenantId: context.tenantId, canEdit: context.permissions.includes("catalog.parties.manage"), data: party(result.rows[0]) }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })

  app.post("/api/v1/parties", async (request, reply) => {
    const key = command(request.headers["idempotency-key"])
    const parsed = partyInputSchema.safeParse(request.body)
    if (!parsed.success) throw new Problem(422, "invalid_input", "JSON inválido ou campos desconhecidos")
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.parties.manage")
      requirePermission(context, "catalog.parties.read")
      const replay = await context.client.query<{ scope: string; request: unknown; result: Record<string, unknown> }>("SELECT scope,request,result FROM domain_commands WHERE tenant_id=$1 AND auth_subject=$2 AND command_key=$3", [context.tenantId, context.identity.subject, key])
      if (replay.rows[0]) { if (replay.rows[0].scope !== "party.create" || !sameJson(replay.rows[0].request, parsed.data)) throw new Problem(409, "domain_conflict", "Esta chave de idempotência já foi usada com outros dados"); return replay.rows[0].result }
      const id = randomUUID(), input = parsed.data
      await validateSettings(context, input)
      await context.client.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,trade_name,tax_id,email,phone,is_customer,is_supplier,status,addresses,contacts,fiscal) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [id, context.tenantId, input.personType, input.legalName, input.tradeName, input.taxId, input.email, input.phone, input.isCustomer, input.isSupplier, input.status, JSON.stringify(input.addresses ?? []), JSON.stringify(input.contacts ?? []), input.fiscal ?? null])
      const loaded = await context.client.query(`SELECT ${projection} FROM parties WHERE tenant_id=$1 AND id=$2`, [context.tenantId, id])
      const result = { tenantId: context.tenantId, canEdit: true, data: party(loaded.rows[0]!) }
      await context.client.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,entity_id,request_id,details) SELECT $1,id,'party.created','party',$3,$4,$5 FROM identities WHERE auth_subject=$2", [context.tenantId, context.identity.subject, id, header(request.headers["x-request-id"]) ?? null, { revision: 1, isCustomer: input.isCustomer, isSupplier: input.isSupplier }])
      await context.client.query("INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'party',$2,'party.created',$3)", [context.tenantId, id, { revision: 1, isCustomer: input.isCustomer, isSupplier: input.isSupplier }])
      await context.client.query("INSERT INTO domain_commands(tenant_id,auth_subject,command_key,scope,request,result) VALUES($1,$2,$3,'party.create',$4,$5)", [context.tenantId, context.identity.subject, key, input, result])
      return result
    })
    return reply.code(201).header("cache-control", "no-store").header("etag", `"${(body.data as { revision: number }).revision}"`).send(body)
  })

  app.put<{ Params: { id: string } }>("/api/v1/parties/:id", async (request, reply) => {
    const expected = revision(request.headers["if-match"])
    const parsed = partyInputSchema.safeParse(request.body)
    if (!parsed.success || !z.string().uuid().safeParse(request.params.id).success) throw new Problem(422, "invalid_input", "JSON inválido ou campos desconhecidos")
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.parties.manage")
      requirePermission(context, "catalog.parties.read")
      await validateSettings(context, parsed.data)
      const previous = await context.client.query(`SELECT ${projection} FROM parties WHERE tenant_id=$1 AND id=$2`, [context.tenantId, request.params.id])
      if (!previous.rows[0]) throw new Problem(404, "not_found", "Cadastro não encontrado")
      if (integer(previous.rows[0].revision) !== expected) throw new Problem(412, "revision_conflict", "O cadastro foi alterado por outra pessoa")
      const old = party(previous.rows[0]), input = parsed.data, next = expected + 1
      if (input.taxId !== old.taxId || input.personType !== old.personType) {
        const linked = await context.client.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM sales_orders WHERE tenant_id=$1 AND customer_id=$2 UNION ALL SELECT 1 FROM purchase_orders WHERE tenant_id=$1 AND supplier_id=$2) AS exists", [context.tenantId, request.params.id])
        if (linked.rows[0]?.exists) throw new Problem(409, "domain_conflict", "Documento e tipo de pessoa não podem mudar após vinculação a um pedido")
      }
      const addresses = input.addresses ?? old.addresses, contacts = input.contacts ?? old.contacts, fiscal = Object.hasOwn(input, "fiscal") ? input.fiscal ?? null : old.fiscal
      await context.client.query("UPDATE parties SET person_type=$3,legal_name=$4,trade_name=$5,tax_id=$6,email=$7,phone=$8,is_customer=$9,is_supplier=$10,status=$11,revision=$12,addresses=$13,contacts=$14,fiscal=$15,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND revision=$16", [context.tenantId, request.params.id, input.personType, input.legalName, input.tradeName, input.taxId, input.email, input.phone, input.isCustomer, input.isSupplier, input.status, next, JSON.stringify(addresses), JSON.stringify(contacts), fiscal, expected])
      const loaded = await context.client.query(`SELECT ${projection} FROM parties WHERE tenant_id=$1 AND id=$2`, [context.tenantId, request.params.id])
      await context.client.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,entity_id,request_id,details) SELECT $1,id,'party.updated','party',$3,$4,$5 FROM identities WHERE auth_subject=$2", [context.tenantId, context.identity.subject, request.params.id, header(request.headers["x-request-id"]) ?? null, { previousRevision: expected, revision: next, isCustomer: input.isCustomer, isSupplier: input.isSupplier }])
      await context.client.query("INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,'party',$2,'party.updated',$3)", [context.tenantId, request.params.id, { previousRevision: expected, revision: next, isCustomer: input.isCustomer, isSupplier: input.isSupplier }])
      return { tenantId: context.tenantId, canEdit: true, data: party(loaded.rows[0]!) }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })
}
