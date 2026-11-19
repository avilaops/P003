import { defineSource, type ResolvedFilters } from "./report-sources.contract.js"
import { permissions } from "./shared.js"

const period = (filters: ResolvedFilters, name: string) => {
  const value = filters[name]
  return typeof value === "object" ? value : { from: null, to: null }
}
const choice = (filters: ResolvedFilters, name: string) => (typeof filters[name] === "string" ? filters[name] : null) as string | null
const months = "CASE c.periodicity WHEN 'monthly' THEN 1 WHEN 'quarterly' THEN 3 WHEN 'semiannual' THEN 6 ELSE 12 END"

/** S3 • Contratos a vencer: vigência que termina no período (ou todos os vigentes). */
export const contractsExpiring = defineSource({
  id: "service_contracts_expiring", label: "Contratos a vencer", area: "servicos", permissions: [permissions.contractsRead],
  description: "Contratos de serviço ativos ou suspensos, com a data de fim da vigência e os dias restantes.",
  columns: {
    number: { label: "Contrato", type: "text" }, customer: { label: "Cliente", type: "text", groupable: true }, status: { label: "Situação", type: "text", groupable: true },
    endOn: { label: "Fim da vigência", type: "date" }, daysLeft: { label: "Dias restantes", type: "number" }, amountCents: { label: "Valor do período", type: "money", aggregatable: true },
  },
  filters: { endOn: { kind: "period", label: "Fim da vigência" }, status: { kind: "choice", label: "Situação", options: { active: "Ativo", suspended: "Suspenso" } } },
  defaultColumns: ["number", "customer", "endOn", "daysLeft", "amountCents"],
  async load(ctx, filters, limit) {
    const range = period(filters, "endOn")
    const { rows } = await ctx.client.query(`SELECT c.number,p.legal_name AS customer,c.status,c.end_on::text AS "endOn",
        (c.end_on-(now() AT TIME ZONE 'America/Sao_Paulo')::date) AS "daysLeft",v.amount_cents::double precision AS "amountCents"
      FROM service_contracts c JOIN parties p ON (p.tenant_id,p.id)=(c.tenant_id,c.customer_id)
      JOIN service_contract_versions v ON (v.tenant_id,v.contract_id,v.version)=(c.tenant_id,c.id,c.current_version)
      WHERE c.tenant_id=$1 AND c.status IN ('active','suspended') AND ($2::text IS NULL OR c.status=$2)
        AND ($3::date IS NULL OR c.end_on>=$3) AND ($4::date IS NULL OR c.end_on<=$4)
      ORDER BY c.end_on,c.number LIMIT $5`, [ctx.tenantId, choice(filters, "status"), range.from, range.to, limit])
    return rows as never
  },
})

/** S3 • Receita recorrente mensal (MRR): valor vigente de cada contrato ativo normalizado para o mês. */
export const recurringRevenue = defineSource({
  id: "service_recurring_revenue", label: "Receita recorrente mensal", area: "servicos", permissions: [permissions.contractsRead],
  description: "Contratos ativos com o valor de cada período convertido para valor mensal.",
  columns: {
    number: { label: "Contrato", type: "text" }, customer: { label: "Cliente", type: "text", groupable: true }, periodicity: { label: "Periodicidade", type: "text", groupable: true },
    amountCents: { label: "Valor do período", type: "money", aggregatable: true }, monthlyCents: { label: "Receita mensal", type: "money", aggregatable: true },
  },
  filters: { periodicity: { kind: "choice", label: "Periodicidade", options: { monthly: "Mensal", quarterly: "Trimestral", semiannual: "Semestral", annual: "Anual" } } },
  defaultColumns: ["number", "customer", "periodicity", "monthlyCents"],
  async load(ctx, filters, limit) {
    const { rows } = await ctx.client.query(`SELECT c.number,p.legal_name AS customer,c.periodicity,v.amount_cents::double precision AS "amountCents",
        round(v.amount_cents::numeric/${months})::double precision AS "monthlyCents"
      FROM service_contracts c JOIN parties p ON (p.tenant_id,p.id)=(c.tenant_id,c.customer_id)
      JOIN service_contract_versions v ON (v.tenant_id,v.contract_id,v.version)=(c.tenant_id,c.id,c.current_version)
      WHERE c.tenant_id=$1 AND c.status='active' AND ($2::text IS NULL OR c.periodicity=$2) ORDER BY c.number LIMIT $3`, [ctx.tenantId, choice(filters, "periodicity"), limit])
    return rows as never
  },
})

const orderStatus = { open: "Aberta", scheduled: "Agendada", in_progress: "Em execução", completed: "Concluída", cancelled: "Cancelada" }
/** S3 • Ordens de serviço por técnico (horas, mão de obra e peças). */
export const ordersByTechnician = defineSource({
  id: "service_orders_by_technician", label: "Ordens de serviço por técnico", area: "servicos", permissions: [permissions.ordersRead],
  description: "Uma linha por ordem de serviço, agrupável por técnico, com horas lançadas, mão de obra e peças.",
  columns: {
    number: { label: "Ordem", type: "text" }, technician: { label: "Técnico", type: "text", groupable: true }, status: { label: "Situação", type: "text", groupable: true },
    openedAt: { label: "Abertura", type: "datetime" }, minutes: { label: "Minutos", type: "number", aggregatable: true },
    laborCents: { label: "Mão de obra", type: "money", aggregatable: true }, partsCents: { label: "Peças", type: "money", aggregatable: true },
  },
  filters: { openedAt: { kind: "period", label: "Abertura" }, status: { kind: "choice", label: "Situação", options: orderStatus } },
  defaultColumns: ["number", "technician", "status", "minutes", "laborCents", "partsCents"],
  async load(ctx, filters, limit) {
    const range = period(filters, "openedAt")
    const { rows } = await ctx.client.query(`SELECT o.number,coalesce(s.name,'Sem técnico') AS technician,o.status,to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "openedAt",
        coalesce((SELECT sum(h.minutes) FROM service_order_hours h WHERE (h.tenant_id,h.order_id)=(o.tenant_id,o.id)),0)::double precision AS minutes,
        o.labor_cents::double precision AS "laborCents",o.parts_cents::double precision AS "partsCents"
      FROM service_orders o LEFT JOIN staff s ON (s.tenant_id,s.id)=(o.tenant_id,o.technician_id)
      WHERE o.tenant_id=$1 AND ($2::text IS NULL OR o.status=$2) AND ($3::date IS NULL OR o.created_at>=$3::date) AND ($4::date IS NULL OR o.created_at<($4::date+1))
      ORDER BY o.created_at DESC,o.id LIMIT $5`, [ctx.tenantId, choice(filters, "status"), range.from, range.to, limit])
    return rows as never
  },
})

/** S3 • Ordens de serviço por SLA: no prazo, atrasada ou em aberto vencida. */
export const ordersBySla = defineSource({
  id: "service_orders_by_sla", label: "Ordens de serviço por SLA", area: "servicos", permissions: [permissions.ordersRead],
  description: "Prazo de SLA de cada ordem e se foi cumprido (concluída no prazo) ou está vencido.",
  columns: {
    number: { label: "Ordem", type: "text" }, technician: { label: "Técnico", type: "text", groupable: true }, sla: { label: "SLA", type: "text", groupable: true },
    slaDueAt: { label: "Prazo do SLA", type: "datetime" }, completedAt: { label: "Conclusão", type: "datetime" },
  },
  filters: { slaDueAt: { kind: "period", label: "Prazo do SLA" }, sla: { kind: "choice", label: "SLA", options: { on_time: "Cumprido", late: "Atrasada", overdue: "Em aberto vencida", running: "Em andamento" } } },
  defaultColumns: ["number", "technician", "sla", "slaDueAt", "completedAt"],
  async load(ctx, filters, limit) {
    const range = period(filters, "slaDueAt")
    const { rows } = await ctx.client.query(`SELECT * FROM (SELECT o.number,coalesce(s.name,'Sem técnico') AS technician,
        CASE WHEN o.status='cancelled' THEN NULL WHEN o.status='completed' THEN CASE WHEN o.completed_at<=o.sla_due_at THEN 'on_time' ELSE 'late' END
          WHEN o.sla_due_at<clock_timestamp() THEN 'overdue' ELSE 'running' END AS sla,
        to_char(o.sla_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "slaDueAt",
        to_char(o.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "completedAt",o.sla_due_at AS due
      FROM service_orders o LEFT JOIN staff s ON (s.tenant_id,s.id)=(o.tenant_id,o.technician_id)
      WHERE o.tenant_id=$1 AND o.sla_due_at IS NOT NULL AND ($3::date IS NULL OR o.sla_due_at>=$3::date) AND ($4::date IS NULL OR o.sla_due_at<($4::date+1))) t
      WHERE sla IS NOT NULL AND ($2::text IS NULL OR sla=$2) ORDER BY due DESC,number LIMIT $5`, [ctx.tenantId, choice(filters, "sla"), range.from, range.to, limit])
    return rows.map(({ due: _due, ...row }) => row) as never
  },
})

/** Lista a registrar em `reports/engine/registry.ts` quando o #301 for mesclado. */
export const serviceReportSources = [contractsExpiring, recurringRevenue, ordersByTechnician, ordersBySla] as const
