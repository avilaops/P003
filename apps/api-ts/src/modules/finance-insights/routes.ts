import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { decimal, today, portfolio, portfolioFilters, validate } from "./portfolio.js"
import { registerCompanyPeriods } from "./company-periods.js"
import { registerStatementRoutes } from "./statements.js"
import { registerFinancePartners } from "./partners.js"
import { registerOperationRoutes } from "./operations.js"

export function registerFinanceInsightRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  registerCompanyPeriods(app, dependencies)
  registerStatementRoutes(app, dependencies)
  registerFinancePartners(app, dependencies)
  registerOperationRoutes(app, dependencies)
  app.get("/api/v1/finance/balances", async (request, reply) => {
    const result = await authorizeRequest(request, dependencies, async (context) => {
      requirePermission(context, "finance.account_entries.read")
      const rows = await context.client.query(
        `SELECT a.id,a.name,${decimal("coalesce(m.net,0)")} AS balance,${decimal("b.closing_cents")} AS "bankBalance",
           b.through_date::text AS "statementThrough",${decimal("CASE WHEN b.through_date IS NOT NULL THEN coalesce(m.matched,0) END")} AS "matchedNet"
        FROM financial_accounts a LEFT JOIN LATERAL (
          SELECT closing_cents,through_date FROM finance_bank_statements WHERE tenant_id=a.tenant_id AND account_id=a.id
          AND through_date<=${today} AND closing_cents IS NOT NULL ORDER BY through_date DESC,imported_at DESC,id DESC LIMIT 1
        ) b ON true LEFT JOIN LATERAL (
          SELECT sum(CASE WHEN e.direction='credit' THEN e.amount_cents ELSE -e.amount_cents END) AS net,
            sum(CASE WHEN e.direction='credit' THEN e.amount_cents ELSE -e.amount_cents END) FILTER(WHERE EXISTS(
              SELECT FROM finance_bank_matches bm JOIN finance_bank_lines l ON (l.tenant_id,l.id)=(bm.tenant_id,bm.line_id)
              WHERE bm.tenant_id=e.tenant_id AND bm.entry_id=e.id AND l.booked_on<=b.through_date)) AS matched
          FROM financial_account_entries e WHERE e.tenant_id=a.tenant_id AND e.account_id=a.id AND e.occurred_on<=${today}
        ) m ON true WHERE a.tenant_id=$1 AND a.status='active' ORDER BY a.name,a.id`,
        [context.tenantId],
      )
      return { tenantId: context.tenantId, data: rows.rows }
    })
    return reply.header("cache-control", "no-store").send(result)
  })
  app.get("/api/v1/finance/portfolio", async (request, reply) => {
    const filters = validate(portfolioFilters, request.query)
    const data = await authorizeRequest(request, dependencies, (context) => portfolio(context, filters))
    return reply.header("cache-control", "no-store").send(data)
  })
  app.get("/api/v1/finance/portfolio/export", async (request, reply) => {
    const filters = validate(portfolioFilters, request.query)
    const data = await authorizeRequest(request, dependencies, (context) => portfolio(context, filters, true))
    return reply.header("cache-control", "no-store").send(data)
  })
}
