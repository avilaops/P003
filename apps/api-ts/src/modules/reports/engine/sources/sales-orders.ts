import { defineSource, type ResolvedFilters } from "../source.js"

const statuses = { draft: "Rascunho", accepted: "Aceito", confirmed: "Confirmado", completed: "Concluído", cancelled: "Cancelado" }
const period = (filters: ResolvedFilters) => filters.period as { from: string; to: string }
const like = (value: string | undefined) => value === undefined ? null : "%" + value.replace(/[\\%_]/g, m => "\\" + m) + "%"

/** Vendas por período: pedidos de venda pela data de emissão (dia de São Paulo). */
export const salesOrdersSource = defineSource({
  id: "sales_orders",
  label: "Vendas por período",
  area: "vendas",
  description: "Pedidos de venda emitidos no período, com cliente, situação, vencimento e valor.",
  permissions: ["sales.orders.read"],
  columns: {
    number: { label: "Número", type: "number" },
    issued_on: { label: "Emissão", type: "date", groupable: true },
    issued_month: { label: "Mês de emissão", type: "text", groupable: true },
    customer: { label: "Cliente", type: "text", groupable: true },
    customer_tax_id: { label: "CPF/CNPJ", type: "text" },
    status: { label: "Situação", type: "text", groupable: true },
    due_date: { label: "Vencimento", type: "date" },
    amount: { label: "Valor (R$)", type: "money", aggregatable: true },
  },
  filters: {
    period: { kind: "period", label: "Período de emissão", required: true },
    status: { kind: "choice", label: "Situação", options: statuses },
    customer: { kind: "text", label: "Cliente contém" },
  },
  defaultColumns: ["number", "issued_on", "customer", "status", "amount"],
  async load(ctx, filters, limit) {
    const { from, to } = period(filters)
    const { rows } = await ctx.client.query(`SELECT o.number::float8 AS number,
        (o.created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS issued_on,
        to_char(o.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS issued_month,
        o.customer_name AS customer, o.customer_tax_id, o.status, o.due_date::text AS due_date,
        o.amount_cents::float8 AS amount
      FROM sales_orders o
      WHERE o.tenant_id=$1
        AND o.created_at >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND o.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND ($4::text IS NULL OR o.status=$4)
        AND ($5::text IS NULL OR o.customer_name ILIKE $5)
      ORDER BY o.created_at, o.id LIMIT $6`,
      [ctx.tenantId, from, to, filters.status ?? null, like(filters.customer as string | undefined), limit])
    return rows.map(row => ({ ...row, status: statuses[row.status as keyof typeof statuses] ?? String(row.status) })) as never
  },
})
