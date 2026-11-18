import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { decimal, sides, today, validate } from "./portfolio.js"

const dates = z.object({ from: z.iso.date(), to: z.iso.date(), categoryId: z.guid().optional() }).strict()
function period(from: string, to: string) {
  const days = (Date.parse(to) - Date.parse(from)) / 86400000
  if (days < 0 || days > 731) throw new Problem(422, "invalid_input", "Escolha um período de até dois anos")
}
const flow = dates.extend({
  accountId: z.guid().optional(),
  interval: z.enum(["day", "week", "month"]).default("day"),
  fixed: z.enum(["yes", "no"]).default("no"),
  orders: z.enum(["yes", "no"]).default("no"),
})
export function registerStatementRoutes(app: FastifyInstance, deps: AppDependencies) {
  app.get("/api/v1/finance/cashflow", async (request, reply) => {
    const f = validate(flow, request.query)
    period(f.from, f.to)
    const data = await authorizeRequest(request, deps, async (context) => {
      requirePermission(context, "finance.account_entries.read")
      const allowed = sides(context)
      const rows = await context.client.query(
        `WITH moves AS (
        SELECT occurred_on AS day, amount_cents * CASE WHEN direction='credit' THEN 1 ELSE -1 END AS net,
          CASE WHEN direction='credit' THEN amount_cents ELSE 0 END AS incoming,
          CASE WHEN direction='debit' THEN amount_cents ELSE 0 END AS outgoing
        FROM financial_account_entries WHERE tenant_id=$1 AND ($4::uuid IS NULL OR account_id=$4)
          AND ($5::uuid IS NULL OR category_id=$5) AND occurred_on<=$3::date
          AND (transfer_id IS NULL OR $4::uuid IS NOT NULL)
      ), opening AS (SELECT coalesce(sum(net),0) AS opening FROM moves WHERE day<$2::date),
      events AS (
        SELECT day,incoming,outgoing,0::numeric AS expected_in,0::numeric AS expected_out FROM moves WHERE day>=$2::date
        UNION ALL SELECT greatest(due_date,${today},$2::date),0,0,
          CASE WHEN side='receivable' THEN open_cents ELSE 0 END, CASE WHEN side='payable' THEN open_cents ELSE 0 END
          FROM finance_portfolio WHERE tenant_id=$1 AND side=ANY($7::text[]) AND open_cents>0 AND due_date<=$3::date AND $3::date>=${today}
            AND ($4::uuid IS NULL OR forecast_account_id=$4) AND ($5::uuid IS NULL OR category_id=$5)
        UNION ALL SELECT greatest(o.due_date,${today},$2::date),0,0,greatest(o.amount_cents-coalesce(t.original,0),0),0
          FROM sales_orders o LEFT JOIN LATERAL (SELECT sum(amount_cents) AS original FROM receivables
             WHERE tenant_id=o.tenant_id AND order_id=o.id AND status<>'cancelled') t ON true
          WHERE o.tenant_id=$1 AND o.status IN ('accepted','confirmed') AND $9 AND 'receivable'=ANY($7::text[])
            AND o.due_date<=$3::date AND $3::date>=${today} AND $4::uuid IS NULL AND $5::uuid IS NULL
            AND NOT EXISTS(SELECT FROM fiscal_nfe_documents n WHERE (n.tenant_id,n.source_order_id)=(o.tenant_id,o.id) AND n.environment='production' AND n.status='authorized')
        UNION ALL SELECT generated.day::date,0,0,0,e.amount_cents FROM fixed_expenses e
          CROSS JOIN LATERAL (
            SELECT least(m::date + (extract(day FROM e.starts_on)::int-1), (m+interval '1 month - 1 day')::date) AS day
            FROM generate_series(date_trunc('month',greatest($2::date,${today},e.starts_on)::timestamp),date_trunc('month',$3::date::timestamp),'1 month') AS m
          ) generated WHERE e.tenant_id=$1 AND e.status='active' AND $8 AND 'payable'=ANY($7::text[]) AND $4::uuid IS NULL AND ($5::uuid IS NULL OR e.category_id=$5)
            AND generated.day BETWEEN greatest($2::date,${today},e.starts_on) AND least($3::date,coalesce(e.ends_on,$3::date))
      ), grouped AS (
        SELECT date_trunc($6, day::timestamp)::date AS start,sum(incoming) AS cash_in,sum(outgoing) AS cash_out,sum(expected_in) AS future_in,sum(expected_out) AS future_out
        FROM events GROUP BY 1
      ), calendar AS (
        SELECT generate_series(date_trunc($6,$2::date::timestamp),date_trunc($6,$3::date::timestamp),('1 '||$6)::interval)::date AS start
      ), summary AS (
        SELECT calendar.start,opening.opening,coalesce(cash_in,0) AS cash_in,coalesce(cash_out,0) AS cash_out,
          coalesce(future_in,0) AS future_in,coalesce(future_out,0) AS future_out FROM calendar CROSS JOIN opening LEFT JOIN grouped USING(start)
      )
      SELECT start::text AS date,${decimal("opening")} AS opening,${decimal("cash_in")} AS "cashIn",${decimal("cash_out")} AS "cashOut",
        ${decimal("future_in")} AS "forecastIn",${decimal("future_out")} AS "forecastOut",
        ${decimal("opening+sum(cash_in-cash_out) OVER(ORDER BY start)")} AS realized,
        ${decimal("opening+sum(cash_in-cash_out+future_in-future_out) OVER(ORDER BY start)")} AS projected FROM summary ORDER BY start`,
        [
          context.tenantId,
          f.from,
          f.to,
          f.accountId ?? null,
          f.categoryId ?? null,
          f.interval,
          allowed,
          f.fixed === "yes",
          f.orders === "yes",
        ],
      )
      const company = await context.client.query("SELECT legal_name FROM tenants WHERE id=$1", [context.tenantId])
      return { tenantId: context.tenantId, companyName: String(company.rows[0]!.legal_name), data: rows.rows }
    })
    return reply.header("cache-control", "no-store").send(data)
  })
  app.get("/api/v1/finance/income-statement", async (request, reply) => {
    const f = validate(dates, request.query)
    period(f.from, f.to)
    const data = await authorizeRequest(request, deps, async (context) => {
      requirePermission(context, "finance.receivables.read")
      requirePermission(context, "finance.payables.read")
      const sums = await context.client.query(
        `WITH invoice_dates AS (
          SELECT source_order_id,
            min(left(issued_at,10)::date) FILTER (WHERE status='authorized') AS invoiced_on
          FROM fiscal_nfe_documents
          WHERE tenant_id=$1 AND source_order_id IS NOT NULL AND source_return_id IS NULL
            AND environment='production' AND status IN ('authorized','cancelled')
          GROUP BY source_order_id
        ), completion_dates AS (
          SELECT entity_id,(min(occurred_at) AT TIME ZONE 'America/Sao_Paulo')::date AS completed_on
          FROM audit_log WHERE tenant_id=$1 AND entity_type='sales_order' AND action='order.completed'
          GROUP BY entity_id
        ), recognized AS (
        SELECT p.category_id,p.side AS kind,sum(p.amount_cents)::numeric AS value,NULL::text AS caption FROM finance_portfolio p
        LEFT JOIN sales_orders o ON o.tenant_id=p.tenant_id AND o.id=p.order_id
        LEFT JOIN invoice_dates n ON n.source_order_id=o.id
        LEFT JOIN completion_dates c ON c.entity_id=o.id::text
        WHERE p.tenant_id=$1 AND p.finance_operation_id IS NULL AND p.status<>'cancelled'
          AND CASE WHEN p.side='payable' THEN p.competence_on
            WHEN n.source_order_id IS NOT NULL AND o.status<>'cancelled' THEN n.invoiced_on
            WHEN o.status='completed' THEN coalesce(c.completed_on,(o.updated_at AT TIME ZONE 'America/Sao_Paulo')::date)
          END BETWEEN $2::date AND $3::date
          GROUP BY p.category_id,p.side
        UNION ALL
        SELECT NULL,side, sum(interest_cents),'Juros de renegociação' FROM finance_operations WHERE tenant_id=$1 AND kind='restructure'
          AND occurred_on BETWEEN $2::date AND $3::date AND interest_cents>0 GROUP BY side
        UNION ALL
        SELECT NULL,o.side,-sum(o.interest_cents),'Juros de renegociação' FROM finance_operation_reversals r JOIN finance_operations o
          ON (o.tenant_id,o.id)=(r.tenant_id,r.operation_id) WHERE r.tenant_id=$1 AND o.kind='restructure'
          AND r.occurred_on BETWEEN $2::date AND $3::date AND o.interest_cents>0 GROUP BY o.side
        UNION ALL
        SELECT category_id,'receivable',sum((net_cents-amount_cents)*CASE WHEN kind='receipt' THEN 1 ELSE -1 END),NULL
          FROM receivable_payments WHERE tenant_id=$1 AND occurred_on BETWEEN $2::date AND $3::date AND net_cents<>amount_cents GROUP BY category_id
        UNION ALL
        SELECT category_id,'payable',sum((net_cents-amount_cents)*CASE WHEN kind='payment' THEN 1 ELSE -1 END),NULL
          FROM payable_payments WHERE tenant_id=$1 AND occurred_on BETWEEN $2::date AND $3::date AND net_cents<>amount_cents GROUP BY category_id
        UNION ALL
        SELECT e.category_id,'payable',sum(e.amount_cents),'Tarifas de cobrança'
          FROM finance_collection_charges ch JOIN financial_account_entries e ON (e.tenant_id,e.id)=(ch.tenant_id,ch.fee_entry_id)
          WHERE ch.tenant_id=$1 AND e.occurred_on BETWEEN $2::date AND $3::date GROUP BY e.category_id
      ), categories AS (
        SELECT r.category_id,coalesce(c.name,r.caption) AS name,r.kind,sum(value) AS value FROM recognized r
        LEFT JOIN financial_categories c ON c.tenant_id=$1 AND c.id=r.category_id WHERE $4::uuid IS NULL OR r.category_id=$4
        GROUP BY r.category_id,coalesce(c.name,r.caption),r.kind HAVING sum(value)<>0
      )
      SELECT category_id AS "categoryId",coalesce(name,'Sem classificação') AS category,kind,${decimal("value")} AS amount,
        ${decimal("sum(CASE WHEN kind='receivable' THEN value ELSE -value END) OVER()")} AS result FROM categories ORDER BY kind,category`,
        [context.tenantId, f.from, f.to, f.categoryId ?? null],
      )
      const company = await context.client.query("SELECT legal_name FROM tenants WHERE id=$1", [context.tenantId])
      return {
        tenantId: context.tenantId,
        companyName: String(company.rows[0]!.legal_name),
        data: sums.rows,
        result: sums.rows[0]?.result ?? "0.00",
      }
    })
    return reply.header("cache-control", "no-store").send(data)
  })
}
