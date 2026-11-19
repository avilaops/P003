import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, replay, remember, record } from "../../platform/commands.js"
import { unsigned64 } from "../../platform/numbers.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { validDocument } from "../parties/schema.js"
import { queryInteger } from "../registrations/query.js"

import { activities, conversion, members, pipeline, stageHistory, stageSchema, validateOwner } from "./pipeline.js"
import { registerPipelineWorkspace } from "./workspace.js"
const uuid = z.guid().transform(value => value.toLowerCase())
const inputSchema = z.strictObject({ title: z.string(), estimatedCents: unsigned64, stage: z.string(), customerId: uuid.nullable().default(null), companyName: z.string(), companyTaxId: z.string(), contactName: z.string(), phone: z.string(), email: z.string(), source: z.string(), notes: z.string(), ownerId:uuid.nullable().optional(), lossReason:z.string().trim().max(500).optional() })
const querySchema = z.strictObject({ q: z.string().default(""), stage: z.string().default(""), start: z.iso.date().optional(), end: z.iso.date().optional(), offset: queryInteger(0, 100000).default(0), limit: queryInteger(1, 100).default(100) })
const select = "SELECT o.data || jsonb_build_object('id',o.id,'revision',o.revision,'customerId',o.customer_id,'customerName',p.legal_name,'orderId',o.order_id,'proposalId',o.proposal_id,'createdAt',o.created_at,'updatedAt',o.updated_at) AS data FROM sales_opportunities o LEFT JOIN parties p ON p.tenant_id=o.tenant_id AND p.id=o.customer_id"
function invalid(title: string): never { throw new Problem(422, "invalid_input", title) }
function validate(input: z.infer<typeof inputSchema>) {
  if (!input.title.trim() || Array.from(input.title).length > 200 || BigInt(input.estimatedCents) > 99999999999999n || !stageSchema.shape.code.safeParse(input.stage).success || input.customerId === null && !input.companyName.trim()) invalid("Informe a oportunidade, a empresa ou cliente, valor e etapa válidos")
  for (const [value, max] of [[input.title, 200], [input.companyName, 200], [input.companyTaxId, 18], [input.contactName, 200], [input.phone, 40], [input.email, 254], [input.source, 200], [input.notes, 5000]] as const) {
    if (Array.from(value).length > max || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(value)) invalid("Texto da oportunidade inválido ou muito longo")
  }
  if (input.email !== "" && (!input.email.includes("@") || /\s/u.test(input.email))) invalid("E-mail de contato inválido")
  if (input.companyTaxId !== "" && !validDocument(input.companyTaxId.replace(/[^a-zA-Z0-9]/g, ""), "juridica")) invalid("CNPJ inválido")
}
async function load(context: AuthorizedContext, id: string) {
  const row = (await context.client.query<{ data: Record<string, unknown> }>(`${select} WHERE o.tenant_id=$1 AND o.id=$2`, [context.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
  return row.data
}
export function registerOpportunityRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  registerPipelineWorkspace(app,dependencies)
  const url = "/api/v1/opportunities"
  app.get(url, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query)
    if (!parsed.success) invalid("Filtros do funil inválidos")
    const query = parsed.data
    if (Array.from(query.q).length > 160 || /\p{Cc}/u.test(query.q) || query.stage !== "" && !stageSchema.shape.code.safeParse(query.stage).success || query.start && query.end && query.start>query.end) invalid("Pesquisa, etapa ou paginação inválida")
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read")
      const config=await pipeline(context)
      if(query.stage && !config.stages.some(s=>s.code===query.stage)) invalid("Etapa desconhecida para esta empresa")
      const filter = "WHERE o.tenant_id=$1 AND ($2='' OR strpos(lower(concat(o.data->>'title',' ',o.data->>'companyName',' ',o.data->>'contactName',' ',p.legal_name)),lower($2))>0) AND ($3='' OR o.data->>'stage'=$3) AND ($4::date IS NULL OR o.created_at>=($4::date::timestamp AT TIME ZONE 'America/Sao_Paulo')) AND ($5::date IS NULL OR o.created_at<(($5::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))"
      const rows = await context.client.query(`${select} ${filter} ORDER BY o.created_at DESC,o.id DESC LIMIT $6 OFFSET $7`, [context.tenantId, query.q, query.stage, query.start, query.end, query.limit, query.offset])
      const total = (await context.client.query(`SELECT count(*) AS total FROM sales_opportunities o LEFT JOIN parties p ON p.tenant_id=o.tenant_id AND p.id=o.customer_id ${filter}`, [context.tenantId, query.q, query.stage, query.start, query.end])).rows[0]!.total
      const filteredTotals=(await context.client.query(`SELECT o.data->>'stage' AS stage,count(*)::int AS count,COALESCE(sum((o.data->>'estimatedCents')::numeric),0)::text AS "estimatedCents" FROM sales_opportunities o LEFT JOIN parties p ON p.tenant_id=o.tenant_id AND p.id=o.customer_id ${filter} GROUP BY o.data->>'stage'`,[context.tenantId,query.q,query.stage,query.start,query.end])).rows
      const totals = await context.client.query("SELECT jsonb_build_object('stage',data->>'stage','count',count(*),'estimatedCents',COALESCE(sum((data->>'estimatedCents')::bigint),0)) AS data FROM sales_opportunities WHERE tenant_id=$1 GROUP BY data->>'stage'", [context.tenantId])
      return { tenantId: context.tenantId, canEdit: context.permissions.includes("sales.orders.manage"), stages:config.stages, filteredTotals, members:await members(context), canConfigure:context.permissions.includes("platform.company.manage"), conversion:await conversion(context,query.start??null,query.end??null), data: rows.rows.map(row => row.data), total: revisionValue(total), offset: query.offset, limit: query.limit, totals: totals.rows.map(row => row.data) }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  app.get<{ Params: { id: string } }>(`${url}/:id`, async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read")
      const id = uuid.safeParse(request.params.id)
      if (!id.success) invalid("Identificador inválido")
      return { tenantId: context.tenantId, canEdit: context.permissions.includes("sales.orders.manage"), data: await load(context, id.data), activities:await activities(context,id.data), history:await stageHistory(context,id.data), members:await members(context), stages:(await pipeline(context)).stages, canCreateProposal:context.permissions.includes("sales.proposals.manage") && context.permissions.includes("sales.proposals.read") }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })
  const write = async (request: FastifyRequest, id: string | null) => authorizeRequest(request, dependencies, async context => {
    requirePermission(context, "sales.orders.read"); requirePermission(context, "sales.orders.manage")
    const key = commandKey(request.headers["idempotency-key"]), parsed = inputSchema.safeParse(request.body)
    if (!parsed.success) invalid("Oportunidade inválida ou campos desconhecidos")
    const input = parsed.data
    validate(input)
    const expected = id === null ? null : parseRevision(request.headers["if-match"]), command = { id, revision: expected, input }, scope = id === null ? "opportunity.create" : "opportunity.update"
    const previous = await replay(context, key, scope, command)
    if (previous) return previous
    if (input.customerId !== null) {
      const active = (await context.client.query("SELECT EXISTS(SELECT 1 FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer AND status='active') AS active", [context.tenantId, input.customerId])).rows[0]?.active
      if (!active) throw new Problem(409, "domain_conflict", "Selecione um cliente ativo desta empresa")
    }
    const recordId = id ?? randomUUID()
    const current = id===null ? null : await load(context,id)
    const stage = (await pipeline(context)).stages.find(s=>s.code===input.stage)
    if (!stage || !stage.active && current?.stage!==stage.code) invalid("Selecione uma etapa ativa da empresa")
    const ownerId = input.ownerId === undefined ? current?.ownerId ?? null : input.ownerId
    const lossReason = input.lossReason === undefined ? String(current?.lossReason ?? "") : input.lossReason
    if (ownerId && ownerId!==current?.ownerId) await validateOwner(context,String(ownerId))
    if (input.stage==="lost" && !lossReason.trim()) invalid("Informe o motivo da perda da oportunidade")
    const dataToStore={...input,ownerId,lossReason:input.stage==="lost"?lossReason:""}
    if (expected !== null) {
      if (!current) throw new Problem(404,"not_found","Oportunidade não encontrada")
      if (current.revision !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      if ((current.orderId !== null || current.proposalId !== null) && current.customerId !== input.customerId) throw new Problem(409, "domain_conflict", "O cliente da oportunidade vinculada ao pedido deve ser preservado")
      await context.client.query("UPDATE sales_opportunities SET customer_id=$3,data=$4,revision=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, recordId, input.customerId, dataToStore, nextRevision(expected)])
    } else await context.client.query("INSERT INTO sales_opportunities(id,tenant_id,customer_id,data,created_by) SELECT $1,$2,$3,$4,id FROM identities WHERE auth_subject=$5", [recordId, context.tenantId, input.customerId, dataToStore, context.authSubject])
    const data = await load(context, recordId)
    await record(context, request.headers, "sales_opportunity", recordId, id === null ? "opportunity.created" : "opportunity.updated", { revision: data.revision, stage: input.stage, stageLabel:stage.label, lossReason:dataToStore.lossReason })
    const value = { tenantId: context.tenantId, canEdit: true, data }
    await remember(context, key, scope, command, value)
    return value
  })
  app.post(url, async (request, reply) => {
    const body = await write(request, null)
    return reply.code(201).header("cache-control", "no-store").header("etag", `"${(body.data as Record<string, unknown>).revision}"`).send(body)
  })
  app.put<{ Params: { id: string } }>(`${url}/:id`, async (request, reply) => {
    const id = uuid.safeParse(request.params.id)
    if (!id.success) invalid("Identificador inválido")
    const body = await write(request, id.data)
    return reply.header("cache-control", "no-store").header("etag", `"${(body.data as Record<string, unknown>).revision}"`).send(body)
  })
}
