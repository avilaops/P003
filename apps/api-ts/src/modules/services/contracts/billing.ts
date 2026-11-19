import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { record } from "../../../platform/commands.js"
import type { DatabasePool, TenantContext } from "../../../platform/database.js"
import { parameter } from "../parameters.js"
import type { PortResult, ServicePorts } from "../ports.contract.js"
import { brazilToday } from "../shared.js"
import { adjustmentOn, itemAmount, requiredCycles, schedule, type ContractItem, type Periodicity } from "./schedule.js"

export type BillingSummary = { created: number; issued: number; pending: number; blocked: number }
type ContractRow = {
  id: string; number: string; customer_id: string; title: string; periodicity: Periodicity; billing_day: number; due_days: number
  start_on: string; end_on: string; adjustment_index: string; adjustment_base_on: string
}
type BillingRow = {
  id: string; contract_id: string; period_start: string; period_end: string; issue_on: string; due_on: string
  version: number | null; amount_cents: string | null; invoice_ref: string | null; receivable_ref: string | null; attempts: number
}
type VersionRow = { version: number; effective_from: string; items: ContractItem[]; amount_cents: string; adjustment_cycle: number | null }

const indexNames: Record<string, string> = { ipca: "IPCA", igpm: "IGP-M", inpc: "INPC", fixed: "percentual fixo" }
const brDate = (value: string) => value.split("-").reverse().join("/")
const dateColumns = (prefix = "") => ["period_start", "period_end", "issue_on", "due_on"].map(c => `${prefix}${c}::text AS ${c}`).join(",")

/**
 * Gera e conclui o faturamento recorrente de uma empresa até `today`.
 *
 * 1. Para cada contrato ativo, cria (uma única vez) a linha de cada período
 *    com emissão até hoje — `UNIQUE(contrato, período)` impede duplicidade
 *    mesmo com dois jobs simultâneos.
 * 2. Conclui as linhas pendentes ou bloqueadas: escolhe a versão vigente no
 *    início do período, exige o reajuste da data-base, emite a NFS-e e abre o
 *    título pelas portas, cada uma com a chave idempotente do período.
 */
export async function billTenant(ctx: TenantContext, today: string, ports: ServicePorts = {}): Promise<BillingSummary> {
  const summary: BillingSummary = { created: 0, issued: 0, pending: 0, blocked: 0 }
  const contracts = (await ctx.client.query<ContractRow>(`SELECT id,number,customer_id,title,periodicity,billing_day,due_days,start_on::text AS start_on,end_on::text AS end_on,
      adjustment_index,adjustment_base_on::text AS adjustment_base_on
    FROM service_contracts WHERE tenant_id=$1 AND status='active' AND start_on<=$2 ORDER BY number FOR UPDATE`, [ctx.tenantId, today])).rows
  for (const contract of contracts) {
    const periods = schedule({ startOn: contract.start_on, endOn: contract.end_on, periodicity: contract.periodicity, billingDay: contract.billing_day, dueDays: contract.due_days }, today)
    for (const period of periods) {
      const inserted = await ctx.client.query(`INSERT INTO service_contract_billings(id,tenant_id,contract_id,period_start,period_end,issue_on,due_on,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,'pending') ON CONFLICT (tenant_id,contract_id,period_start) DO NOTHING RETURNING id`,
        [randomUUID(), ctx.tenantId, contract.id, period.periodStart, period.periodEnd, period.issueOn, period.dueOn])
      summary.created += inserted.rows.length
    }
  }
  const byId = new Map(contracts.map(contract => [contract.id, contract]))
  const open = (await ctx.client.query<BillingRow>(`SELECT b.id,b.contract_id,${dateColumns("b.")},b.version,b.amount_cents::text AS amount_cents,b.invoice_ref,b.receivable_ref,b.attempts
    FROM service_contract_billings b WHERE b.tenant_id=$1 AND b.status IN ('pending','blocked') AND b.issue_on<=$2
    ORDER BY b.issue_on,b.id FOR UPDATE`, [ctx.tenantId, today])).rows
  for (const row of open) {
    const contract = byId.get(row.contract_id)
    if (!contract) continue // contrato suspenso ou encerrado: a linha espera a reativação
    const outcome = await settle(ctx, contract, row, ports)
    summary[outcome]++
  }
  return summary
}

async function settle(ctx: TenantContext, contract: ContractRow, row: BillingRow, ports: ServicePorts): Promise<"issued" | "pending" | "blocked"> {
  const versions = (await ctx.client.query<VersionRow>(`SELECT version,effective_from::text AS effective_from,items,amount_cents::text AS amount_cents,adjustment_cycle
    FROM service_contract_versions WHERE tenant_id=$1 AND contract_id=$2 ORDER BY version`, [ctx.tenantId, contract.id])).rows
  let version = row.version ?? undefined, amount = row.amount_cents === null ? undefined : Number(row.amount_cents)
  let items: VersionRow["items"] | undefined = versions.find(v => v.version === version)?.items
  if (!row.invoice_ref) {
    // Até a nota sair, a versão acompanha aditivos e reajustes lançados depois.
    if (contract.adjustment_index !== "none") {
      const cycle = requiredCycles(contract.adjustment_base_on, row.period_start)
      if (cycle > 0 && !versions.some(v => v.adjustment_cycle === cycle)) {
        const due = adjustmentOn(contract.adjustment_base_on, cycle)
        return finish(ctx, row, "blocked", `Reajuste (${indexNames[contract.adjustment_index]}) de ${brDate(due)} pendente: registre a taxa do ciclo ${cycle} para faturar este período`)
      }
    }
    const effective = versions.filter(v => v.effective_from <= row.period_start).at(-1) ?? versions[0]!
    version = effective.version; amount = Number(effective.amount_cents); items = effective.items
  }
  const competence = `${brDate(row.period_start)} a ${brDate(row.period_end)}`
  const description = `${contract.number} • ${contract.title} • competência ${competence}`
  const call = async (port: "invoices" | "receivables"): Promise<PortResult | undefined> => {
    if (port === "invoices") {
      if (!ports.invoices) return undefined
      return ports.invoices.issue(ctx, {
        idempotencyKey: row.id, customerId: contract.customer_id, issueOn: row.issue_on, competence: { start: row.period_start, end: row.period_end },
        items: items!.map(item => ({ ...item, amountCents: itemAmount(item) })), amountCents: amount!, description,
        origin: { type: "service_contract_billing", id: row.id, contractId: contract.id },
      })
    }
    if (!ports.receivables) return undefined
    return ports.receivables.open(ctx, { idempotencyKey: row.id, customerId: contract.customer_id, amountCents: amount!, issueOn: row.issue_on, dueOn: row.due_on, description, origin: { type: "service_contract_billing", id: row.id } })
  }
  let invoiceRef = row.invoice_ref, receivableRef = row.receivable_ref
  const save = () => ctx.client.query("UPDATE service_contract_billings SET version=$3,amount_cents=$4,invoice_ref=$5,receivable_ref=$6 WHERE tenant_id=$1 AND id=$2",
    [ctx.tenantId, row.id, version, amount, invoiceRef, receivableRef])
  for (const port of ["invoices", "receivables"] as const) {
    if (port === "invoices" ? invoiceRef : receivableRef) continue
    await ctx.client.query("SAVEPOINT service_billing_port")
    let result: PortResult | undefined
    try { result = await call(port) }
    catch {
      await ctx.client.query("ROLLBACK TO SAVEPOINT service_billing_port")
      await save()
      return finish(ctx, row, "pending", port === "invoices" ? "Falha temporária na emissão da NFS-e; nova tentativa no próximo ciclo" : "Falha temporária ao abrir o título; nova tentativa no próximo ciclo")
    }
    await ctx.client.query("RELEASE SAVEPOINT service_billing_port")
    if (!result) {
      await save()
      return finish(ctx, row, "pending", port === "invoices" ? "Aguardando a emissão de NFS-e de saída (Fiscal F6)" : "Aguardando o título a receber avulso (Financeiro FI1)")
    }
    if (result.status === "blocked") { await save(); return finish(ctx, row, "blocked", result.message.slice(0, 500)) }
    if (port === "invoices") invoiceRef = result.reference
    else receivableRef = result.reference
  }
  await save()
  await record(ctx, {}, "service_contract_billing", row.id, "service.contract.billing.issued", { contractId: contract.id, periodStart: row.period_start, version, amountCents: amount, invoiceRef, receivableRef })
  return finish(ctx, row, "issued", null)
}

async function finish<T extends "issued" | "pending" | "blocked">(ctx: TenantContext, row: BillingRow, status: T, message: string | null) {
  await ctx.client.query("UPDATE service_contract_billings SET status=$3,message=$4,attempts=attempts+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, row.id, status, message])
  return status
}

/** Uma rodada do job para todas as empresas com faturamento devido. Uma empresa com erro não impede as outras. */
export async function runServiceBilling(pool: DatabasePool, ports: ServicePorts = {}, today = brazilToday()) {
  const connection = await pool.connect()
  const totals: BillingSummary = { created: 0, issued: 0, pending: 0, blocked: 0 }, failures: unknown[] = []
  try {
    const tenants = (await connection.query<{ id: string }>("SELECT id FROM erp_service_billing_due_tenants($1::date) AS id ORDER BY id", [today])).rows
    for (const { id } of tenants) {
      try {
        await connection.query("BEGIN")
        await connection.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.auth_subject','',true)", [id])
        // Mesmo bloqueio de empresa das escritas da API, antes de travar contratos.
        const active = (await connection.query("SELECT id FROM tenants WHERE id=$1 AND status='active' FOR UPDATE", [id])).rows[0]
        if (active) {
          const summary = await billTenant({ client: connection, tenantId: id, authSubject: "", permissions: [] }, today, ports)
          for (const key of Object.keys(totals) as (keyof BillingSummary)[]) totals[key] += summary[key]
        }
        await connection.query("COMMIT")
      } catch (error) {
        await connection.query("ROLLBACK")
        failures.push(error)
      }
    }
  } finally { connection.release() }
  if (failures.length) throw new AggregateError(failures, "Falha no faturamento recorrente de contratos")
  return totals
}

export function startServiceBillingWorker(app: FastifyInstance, pool: DatabasePool, ports: ServicePorts = {}) {
  let active: Promise<void> | undefined
  const tick = () => {
    if (!active) active = runServiceBilling(pool, ports).then(() => {})
      .catch(error => { app.log.error({ err: error }, "Falha no faturamento recorrente de contratos") })
      .finally(() => { active = undefined })
  }
  const timer = setInterval(tick, parameter("services.billing.interval_minutes") * 60_000)
  timer.unref()
  app.addHook("onReady", async () => { tick() })
  app.addHook("onClose", async () => { clearInterval(timer); await active })
}
