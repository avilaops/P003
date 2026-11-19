import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AccessDependencies, AuthorizedContext } from "../../../platform/access.js"
import { nextRevision, type Revision } from "../../../platform/revision.js"
import { queryInteger, searchQuery } from "../../registrations/query.js"
import { parameter } from "../parameters.js"
import type { ServicePorts } from "../ports.contract.js"
import { brazilToday, cents, command, conflict, id, invalid, isoDate, notFound, parse, permissions, quantity, readRoute, send, staleRevision, text } from "../shared.js"
import { billTenant } from "./billing.js"
import { addDays, adjustItems, adjustmentOn, contractAmount, schedule, type ContractItem, type Periodicity } from "./schedule.js"

const { contractsRead: read, contractsManage: manage } = permissions
const base = "/api/v1/service-contracts"
const periodicities = z.enum(["monthly", "quarterly", "semiannual", "annual"])
const indexes = z.enum(["none", "ipca", "igpm", "inpc", "fixed"])
const statuses = z.enum(["draft", "active", "suspended", "closed", "cancelled"])
/** Item da lista de serviços da LC 116/2003 (ex.: 14.01). A tributação fica com o Fiscal. */
const item = z.strictObject({ description: text(2, 300), serviceCode: z.string().regex(/^[0-9]{2}\.[0-9]{2}$/), quantity, unitCents: cents.min(1) })
const items = z.array(item).min(1).max(50)
const reason = text(3, 500)

const createInput = z.strictObject({
  customerId: id, title: text(3, 160), periodicity: periodicities, billingDay: z.number().int().min(1).max(28),
  dueDays: z.number().int().min(0).max(120).optional(), startOn: isoDate, endOn: isoDate,
  adjustmentIndex: indexes, adjustmentBaseOn: isoDate.optional(), items, reason: reason.default("Contrato original"),
}).refine(input => input.endOn > input.startOn, { message: "fim" })
const amendmentInput = z.strictObject({ effectiveFrom: isoDate, endOn: isoDate.optional(), items: items.optional(), reason })
  .refine(input => input.endOn !== undefined || input.items !== undefined)
const adjustmentInput = z.strictObject({ cycle: z.number().int().min(1).max(100), rateBp: z.number().int().min(-9999).max(100000), reason })
const transitionInput = z.strictObject({ status: statuses, reason: reason.optional() })
const listQuery = z.strictObject({ q: searchQuery, status: statuses.optional(), offset: queryInteger(0, 1_000_000).default(0), limit: queryInteger(1, 100).default(25) })

const transitions: Record<string, readonly string[]> = { draft: ["active", "cancelled"], active: ["suspended", "closed"], suspended: ["active", "closed"] }

const projection = `c.id,c.number,c.title,c.customer_id AS "customerId",p.legal_name AS "customerName",c.periodicity,c.billing_day AS "billingDay",
  c.due_days AS "dueDays",c.start_on::text AS "startOn",c.end_on::text AS "endOn",c.adjustment_index AS "adjustmentIndex",
  c.adjustment_base_on::text AS "adjustmentBaseOn",c.status,c.current_version AS "currentVersion",v.amount_cents AS "amountCents",
  c.revision,c.created_at AS "createdAt",c.updated_at AS "updatedAt"
  FROM service_contracts c JOIN parties p ON (p.tenant_id,p.id)=(c.tenant_id,c.customer_id)
  JOIN service_contract_versions v ON (v.tenant_id,v.contract_id,v.version)=(c.tenant_id,c.id,c.current_version)`

async function load(ctx: AuthorizedContext, contractId: string) {
  const row = (await ctx.client.query("SELECT to_jsonb(t) AS data FROM (SELECT " + projection + " WHERE c.tenant_id=$1 AND c.id=$2) t", [ctx.tenantId, contractId])).rows[0]
  if (!row) return notFound("Contrato de serviço não encontrado")
  return row.data as Record<string, unknown> & { revision: Revision }
}
type Locked = { id: string; status: string; revision: Revision; start_on: string; end_on: string; current_version: number; adjustment_index: string; adjustment_base_on: string }
async function lock(ctx: AuthorizedContext, contractId: string, expected: Revision) {
  const row = (await ctx.client.query<Locked>(`SELECT id,status,revision,start_on::text AS start_on,end_on::text AS end_on,current_version,adjustment_index,adjustment_base_on::text AS adjustment_base_on
    FROM service_contracts WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [ctx.tenantId, contractId])).rows[0]
  if (!row) return notFound("Contrato de serviço não encontrado")
  staleRevision(row.revision, expected)
  return row
}
/** Último período com nota emitida: aditivos e reajustes não podem alterar o que já foi faturado. */
async function lastInvoiced(ctx: AuthorizedContext, contractId: string) {
  return (await ctx.client.query<{ start: string | null; end: string | null }>(`SELECT max(period_start)::text AS start,max(period_end)::text AS end
    FROM service_contract_billings WHERE tenant_id=$1 AND contract_id=$2 AND invoice_ref IS NOT NULL`, [ctx.tenantId, contractId])).rows[0]!
}
async function latestItems(ctx: AuthorizedContext, contractId: string, version: number) {
  return (await ctx.client.query<{ items: ContractItem[] }>("SELECT items FROM service_contract_versions WHERE tenant_id=$1 AND contract_id=$2 AND version=$3", [ctx.tenantId, contractId, version])).rows[0]!.items
}
function insertVersion(ctx: AuthorizedContext, contractId: string, version: number, kind: string, effectiveFrom: string, endOn: string, lines: ContractItem[], reasonText: string, cycle: number | null = null, rate: number | null = null) {
  return ctx.client.query(`INSERT INTO service_contract_versions(tenant_id,contract_id,version,kind,effective_from,end_on,items,amount_cents,adjustment_cycle,adjustment_rate_bp,reason,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [ctx.tenantId, contractId, version, kind, effectiveFrom, endOn, JSON.stringify(lines), contractAmount(lines), cycle, rate, reasonText, ctx.authSubject])
}

export type ContractAlert = { contractId: string; number: string; customerName: string; kind: "expiring" | "adjustment" | "billing_blocked"; date: string; overdue: boolean; message: string }
export async function contractAlerts(ctx: Pick<AuthorizedContext, "client" | "tenantId">, today = brazilToday()): Promise<ContractAlert[]> {
  const expiryLimit = addDays(today, parameter("services.contracts.expiry_alert_days")), adjustmentLimit = addDays(today, parameter("services.contracts.adjustment_alert_days"))
  const rows = (await ctx.client.query<{ id: string; number: string; customer: string; end_on: string; adjustment_index: string; adjustment_base_on: string; cycle: number }>(`
    SELECT c.id,c.number,p.legal_name AS customer,c.end_on::text AS end_on,c.adjustment_index,c.adjustment_base_on::text AS adjustment_base_on,
      coalesce((SELECT max(adjustment_cycle) FROM service_contract_versions v WHERE (v.tenant_id,v.contract_id)=(c.tenant_id,c.id)),0) AS cycle
    FROM service_contracts c JOIN parties p ON (p.tenant_id,p.id)=(c.tenant_id,c.customer_id)
    WHERE c.tenant_id=$1 AND c.status IN ('active','suspended') ORDER BY c.number`, [ctx.tenantId])).rows
  const alerts: ContractAlert[] = []
  const br = (value: string) => value.split("-").reverse().join("/")
  for (const row of rows) {
    if (row.end_on <= expiryLimit) alerts.push({ contractId: row.id, number: row.number, customerName: row.customer, kind: "expiring", date: row.end_on, overdue: row.end_on < today, message: row.end_on < today ? `Vigência encerrada em ${br(row.end_on)}` : `Vigência termina em ${br(row.end_on)}` })
    if (row.adjustment_index !== "none") {
      const due = adjustmentOn(row.adjustment_base_on, Number(row.cycle) + 1)
      if (due <= adjustmentLimit && due <= row.end_on) alerts.push({ contractId: row.id, number: row.number, customerName: row.customer, kind: "adjustment", date: due, overdue: due <= today, message: `Reajuste do ciclo ${Number(row.cycle) + 1} ${due <= today ? "vencido desde" : "em"} ${br(due)}` })
    }
  }
  const blocked = await ctx.client.query<{ id: string; number: string; customer: string; issue_on: string; message: string }>(`SELECT c.id,c.number,p.legal_name AS customer,b.issue_on::text AS issue_on,b.message
    FROM service_contract_billings b JOIN service_contracts c ON (c.tenant_id,c.id)=(b.tenant_id,b.contract_id) JOIN parties p ON (p.tenant_id,p.id)=(c.tenant_id,c.customer_id)
    WHERE b.tenant_id=$1 AND b.status='blocked' ORDER BY b.issue_on,c.number`, [ctx.tenantId])
  for (const row of blocked.rows) alerts.push({ contractId: row.id, number: row.number, customerName: row.customer, kind: "billing_blocked", date: row.issue_on, overdue: true, message: row.message })
  return alerts.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
}

export function registerServiceContracts(app: FastifyInstance, deps: AccessDependencies & { services?: ServicePorts }) {
  app.get(base, async (request, reply) => send(reply, await readRoute(request, deps, read, manage, async ctx => {
    const f = parse(listQuery, request.query, "Filtros inválidos")
    const result = await ctx.client.query(`WITH matches AS (SELECT ${projection} WHERE c.tenant_id=$1 AND ($2::text IS NULL OR c.status=$2)
        AND ($3='' OR strpos(lower(concat_ws(' ',c.number,c.title,p.legal_name)),lower($3))>0)),
      page AS (SELECT * FROM matches ORDER BY "number" DESC LIMIT $4 OFFSET $5)
      SELECT (SELECT count(*)::int FROM matches) AS total,coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "number" DESC) FROM page),'[]') AS data`,
      [ctx.tenantId, f.status ?? null, f.q, f.limit, f.offset])
    return { ...result.rows[0], limit: f.limit, offset: f.offset }
  })))

  app.get(base + "/alerts", async (request, reply) => send(reply, await readRoute(request, deps, read, manage, async ctx => {
    parse(z.strictObject({}), request.query ?? {}, "Filtros inválidos")
    return { data: await contractAlerts(ctx) }
  })))

  app.get<{ Params: { id: string } }>(base + "/:id", async (request, reply) => send(reply, await readRoute(request, deps, read, manage, async ctx => {
    const contractId = parse(id, request.params.id, "Identificador inválido")
    const data: Record<string, unknown> = await load(ctx, contractId)
    data.versions = (await ctx.client.query(`SELECT version,kind,effective_from::text AS "effectiveFrom",end_on::text AS "endOn",items,amount_cents AS "amountCents",
      adjustment_cycle AS "adjustmentCycle",adjustment_rate_bp AS "adjustmentRateBp",reason,created_at AS "createdAt"
      FROM service_contract_versions WHERE tenant_id=$1 AND contract_id=$2 ORDER BY version DESC`, [ctx.tenantId, contractId])).rows
    data.billings = (await ctx.client.query(`SELECT id,period_start::text AS "periodStart",period_end::text AS "periodEnd",issue_on::text AS "issueOn",due_on::text AS "dueOn",
      version,amount_cents AS "amountCents",status,invoice_ref AS "invoiceRef",receivable_ref AS "receivableRef",message,attempts,updated_at AS "updatedAt"
      FROM service_contract_billings WHERE tenant_id=$1 AND contract_id=$2 ORDER BY period_start DESC LIMIT 120`, [ctx.tenantId, contractId])).rows
    const contract = data as unknown as { startOn: string; endOn: string; periodicity: Periodicity; billingDay: number; dueDays: number }
    const upcoming = schedule(contract, addDays(brazilToday(), 400)).filter(p => p.issueOn > brazilToday()).slice(0, 3)
    data.upcoming = upcoming
    data.alerts = (await contractAlerts(ctx)).filter(alert => alert.contractId === contractId)
    return { data }
  })))

  command(app, deps, { path: base, schema: createInput, scope: "service.contract.created", entity: "service_contract", read, manage, execute: async (ctx, input) => {
    const customer = (await ctx.client.query("SELECT 1 FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer", [ctx.tenantId, input.customerId])).rows[0]
    if (!customer) invalid("Selecione um cliente desta empresa")
    if (input.adjustmentIndex === "none" && input.adjustmentBaseOn) invalid("Informe a data-base apenas quando houver índice de reajuste")
    const sequence = (await ctx.client.query<{ next: string }>("SELECT coalesce(max(substr(number,5)::bigint),0)+1 AS next FROM service_contracts WHERE tenant_id=$1", [ctx.tenantId])).rows[0]!.next
    const contractId = randomUUID(), number = "CTS-" + String(sequence).padStart(6, "0")
    await ctx.client.query(`INSERT INTO service_contracts(id,tenant_id,number,customer_id,title,periodicity,billing_day,due_days,start_on,end_on,adjustment_index,adjustment_base_on)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [contractId, ctx.tenantId, number, input.customerId, input.title, input.periodicity, input.billingDay,
      input.dueDays ?? parameter("services.contracts.default_due_days"), input.startOn, input.endOn, input.adjustmentIndex, input.adjustmentBaseOn ?? input.startOn])
    await insertVersion(ctx, contractId, 1, "original", input.startOn, input.endOn, input.items, input.reason)
    return { data: await load(ctx, contractId), aggregateId: contractId }
  } })

  command(app, deps, { path: base + "/:id/transition", schema: transitionInput, scope: "service.contract.transitioned", entity: "service_contract", read, manage, execute: async (ctx, input, contractId, expected) => {
    const row = await lock(ctx, contractId, expected)
    if (!transitions[row.status]?.includes(input.status)) conflict("Transição indisponível para a situação atual do contrato")
    if (row.status === "suspended" && input.status === "active") {
      // Retomada: os períodos com emissão durante a suspensão não são cobrados.
      const contract = (await ctx.client.query<{ periodicity: Periodicity; billing_day: number; due_days: number }>(`SELECT periodicity,billing_day,due_days FROM service_contracts WHERE tenant_id=$1 AND id=$2`, [ctx.tenantId, contractId])).rows[0]!
      for (const period of schedule({ startOn: row.start_on, endOn: row.end_on, periodicity: contract.periodicity, billingDay: contract.billing_day, dueDays: contract.due_days }, addDays(brazilToday(), -1))) {
        await ctx.client.query(`INSERT INTO service_contract_billings(id,tenant_id,contract_id,period_start,period_end,issue_on,due_on,status,message)
          VALUES($1,$2,$3,$4,$5,$6,$7,'skipped','Período durante a suspensão do contrato') ON CONFLICT DO NOTHING`, [randomUUID(), ctx.tenantId, contractId, period.periodStart, period.periodEnd, period.issueOn, period.dueOn])
      }
    }
    await ctx.client.query("UPDATE service_contracts SET status=$3,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, contractId, input.status])
    return { data: await load(ctx, contractId), aggregateId: contractId }
  } })

  command(app, deps, { path: base + "/:id/amendments", schema: amendmentInput, scope: "service.contract.amended", entity: "service_contract", read, manage, execute: async (ctx, input, contractId, expected) => {
    const row = await lock(ctx, contractId, expected)
    if (!["draft", "active", "suspended"].includes(row.status)) conflict("Contrato encerrado não aceita aditivo")
    const endOn = input.endOn ?? row.end_on, invoiced = await lastInvoiced(ctx, contractId)
    if (input.effectiveFrom < row.start_on || input.effectiveFrom > endOn) invalid("O aditivo deve vigorar dentro da vigência do contrato")
    if (endOn <= row.start_on) invalid("O fim da vigência deve ser posterior ao início")
    if (invoiced.start && input.effectiveFrom <= invoiced.start) conflict("Já existe nota emitida a partir desta data: o aditivo deve vigorar depois do último período faturado")
    if (invoiced.end && endOn < invoiced.end) conflict("A vigência não pode terminar antes do último período faturado")
    const version = row.current_version + 1
    await insertVersion(ctx, contractId, version, "amendment", input.effectiveFrom, endOn, input.items ?? await latestItems(ctx, contractId, row.current_version), input.reason)
    await ctx.client.query("UPDATE service_contracts SET end_on=$3,current_version=$4,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, contractId, endOn, version])
    return { data: await load(ctx, contractId), aggregateId: contractId }
  } })

  command(app, deps, { path: base + "/:id/adjustments", schema: adjustmentInput, scope: "service.contract.adjusted", entity: "service_contract", read, manage, execute: async (ctx, input, contractId, expected) => {
    const row = await lock(ctx, contractId, expected)
    if (!["active", "suspended"].includes(row.status)) conflict("Somente contrato vigente recebe reajuste")
    if (row.adjustment_index === "none") conflict("Este contrato não tem índice de reajuste")
    const last = Number((await ctx.client.query("SELECT coalesce(max(adjustment_cycle),0) AS cycle FROM service_contract_versions WHERE tenant_id=$1 AND contract_id=$2", [ctx.tenantId, contractId])).rows[0]!.cycle)
    if (input.cycle !== last + 1) conflict(`Registre os reajustes em ordem: o próximo é o ciclo ${last + 1}`)
    const effectiveFrom = adjustmentOn(row.adjustment_base_on, input.cycle)
    if (effectiveFrom > row.end_on) conflict("A data do reajuste fica fora da vigência do contrato")
    const invoiced = await lastInvoiced(ctx, contractId)
    if (invoiced.start && effectiveFrom <= invoiced.start) conflict("Já existe nota emitida após a data-base deste reajuste")
    const version = row.current_version + 1
    await insertVersion(ctx, contractId, version, "adjustment", effectiveFrom, row.end_on, adjustItems(await latestItems(ctx, contractId, row.current_version), input.rateBp), input.reason, input.cycle, input.rateBp)
    await ctx.client.query("UPDATE service_contracts SET current_version=$3,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, contractId, version])
    return { data: { ...await load(ctx, contractId), revision: nextRevision(expected) }, aggregateId: contractId }
  } })

  command(app, deps, { path: base + "/billing-runs", schema: z.strictObject({}), scope: "service.contract.billing.run", entity: "service_contract_billing_run", read, manage, execute: async ctx => {
    const today = brazilToday(), runId = randomUUID()
    return { data: { id: runId, today, ...await billTenant(ctx, today, deps.services) }, aggregateId: runId }
  } })
}
