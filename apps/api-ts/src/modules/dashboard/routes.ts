import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue } from "../../platform/revision.js"

export function registerDashboardRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/dashboard", async (request, reply) => {
    const parsed = z.strictObject({ period: z.enum(["7D", "30D", "3M", "6M", "12M"]).default("6M") }).safeParse(request.query)
    if (!parsed.success) throw new Problem(422, "invalid_input", "Período inválido")
    const period = parsed.data.period, intervals = { "7D": "6 days", "30D": "29 days", "3M": "3 months", "6M": "6 months", "12M": "12 months" }
    const body = await authorizeRequest(request, dependencies, async context => {
      const { client, tenantId } = context, allowed = (permission: string) => context.permissions.includes(permission)
      const dates = (await client.query("SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - $1::interval)::date::text AS start_date,(CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date::text AS end_date", [intervals[period]])).rows[0]!
      const parameters = [tenantId, dates.start_date, dates.end_date]
      let sales = null, salesSeries = null, receivables = null, purchasePayables = null, products = null, customers = null
      if (allowed("sales.orders.read")) {
        const row = (await client.query("SELECT count(*) FILTER(WHERE status<>'cancelled') AS orders,count(*) FILTER(WHERE status='cancelled') AS cancelled,(COALESCE(sum(amount_cents) FILTER(WHERE status<>'cancelled'),0)/100)::numeric(30,2)::text AS amount,(COALESCE(avg(amount_cents) FILTER(WHERE status<>'cancelled'),0)/100)::numeric(30,2)::text AS average FROM sales_orders WHERE tenant_id=$1 AND created_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND created_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')", parameters)).rows[0]!
        sales = { orders: revisionValue(row.orders), cancelled: revisionValue(row.cancelled), amount: row.amount, average: row.average }
        const series = await client.query("SELECT to_char(created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS month,count(*) AS orders,(sum(amount_cents)/100)::numeric(30,2)::text AS amount,(avg(amount_cents)/100)::numeric(30,2)::text AS average FROM sales_orders WHERE tenant_id=$1 AND status<>'cancelled' AND created_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND created_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo') GROUP BY month ORDER BY month", parameters)
        salesSeries = series.rows.map(row => ({ month: row.month, orders: revisionValue(row.orders), amount: row.amount, average: row.average }))
      }
      if (allowed("finance.receivables.read")) receivables = (await client.query("SELECT (COALESCE(sum(r.amount_cents-COALESCE(p.paid,0)),0)/100)::numeric(30,2)::text AS amount FROM receivables r LEFT JOIN LATERAL (SELECT sum(CASE WHEN kind='receipt' THEN amount_cents ELSE -amount_cents END) AS paid FROM receivable_payments WHERE tenant_id=r.tenant_id AND receivable_id=r.id) p ON true WHERE r.tenant_id=$1 AND r.status<>'cancelled'", [tenantId])).rows[0]!.amount
      if (allowed("finance.payables.read")) purchasePayables = (await client.query("SELECT (COALESCE(sum(r.amount_cents-COALESCE(p.paid,0)),0)/100)::numeric(30,2)::text AS amount FROM payables r LEFT JOIN LATERAL (SELECT sum(CASE WHEN kind='payment' THEN amount_cents ELSE -amount_cents END) AS paid FROM payable_payments WHERE tenant_id=r.tenant_id AND payable_id=r.id) p ON true WHERE r.tenant_id=$1 AND r.status<>'cancelled'", [tenantId])).rows[0]!.amount
      if (allowed("catalog.products.read")) products = revisionValue((await client.query("SELECT count(*) AS count FROM products WHERE tenant_id=$1 AND status='active'", [tenantId])).rows[0]!.count)
      if (allowed("catalog.parties.read")) customers = revisionValue((await client.query("SELECT count(*) AS count FROM parties WHERE tenant_id=$1 AND status='active' AND is_customer", [tenantId])).rows[0]!.count)
      return { tenantId, period, startDate: dates.start_date, endDate: dates.end_date, sales, salesSeries, receivables, purchasePayables, products, customers }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
}
