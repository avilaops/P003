import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { today, validate } from "./portfolio.js"

const schema = z
  .object({ action: z.enum(["close", "reopen"]), throughDate: z.iso.date(), reason: z.string().trim().min(3).max(200) })
  .strict()
export function registerCompanyPeriods(app: FastifyInstance, deps: AppDependencies) {
  const endpoint = "/api/v1/finance/company-periods"
  app.get(endpoint, async (req, reply) => {
    const result = await authorizeRequest(req, deps, async (ctx) => {
      requirePermission(ctx, "finance.account_entries.read")
      const history = await ctx.client.query(
        `SELECT action,through_date::text AS "throughDate",reason,recorded_by AS actor
        FROM finance_company_period_events WHERE tenant_id=$1 ORDER BY sequence DESC LIMIT 50`,
        [ctx.tenantId],
      )
      const state = await ctx.client.query(
        "SELECT max(through_date)::text AS cutoff FROM finance_company_closed_dates WHERE tenant_id=$1",
        [ctx.tenantId],
      )
      return {
        tenantId: ctx.tenantId,
        cutoff: state.rows[0]?.cutoff,
        history: history.rows,
        canClose: ctx.permissions.includes("finance.reconciliation.close"),
        canReopen: ctx.permissions.includes("finance.reconciliation.reopen"),
      }
    })
    return reply.header("cache-control", "no-store").send(result)
  })
  app.post(endpoint, async (req, reply) => {
    const input = validate(schema, req.body),
      key = commandKey(req.headers["idempotency-key"])
    const result = await authorizeRequest(req, deps, async (ctx) => {
      requirePermission(ctx, "finance.account_entries.read")
      requirePermission(ctx, "finance.reconciliation." + input.action)
      const prior = await replay(ctx, key, "finance.company-period", input)
      if (prior) return prior
      const { tenantId, client } = ctx
      const state = (
        await client.query(
          `SELECT max(through_date)::text AS cutoff,${today}::text AS today FROM finance_company_closed_dates WHERE tenant_id=$1`,
          [tenantId],
        )
      ).rows[0]!
      if (input.action === "close") {
        if (input.throughDate > String(state.today) || (state.cutoff && input.throughDate <= String(state.cutoff)))
          throw new Problem(409, "domain_conflict", "Escolha uma data posterior ao último fechamento e até hoje")
        const pending = await client.query(
          `SELECT FROM finance_bank_lines WHERE tenant_id=$1 AND booked_on<=$2 AND state='pending'
          UNION ALL SELECT FROM pos_sessions WHERE tenant_id=$1 AND status='open' AND (opened_at AT TIME ZONE 'America/Sao_Paulo')::date<=$2 LIMIT 1`,
          [tenantId, input.throughDate],
        )
        if (pending.rows.length)
          throw new Problem(
            409,
            "domain_conflict",
            "Confira as linhas bancárias pendentes e feche as sessões de caixa do período",
          )
      } else if (state.cutoff !== input.throughDate)
        throw new Problem(409, "domain_conflict", "Reabra o fechamento mais recente da empresa")
      const id = randomUUID()
      await client.query(
        "INSERT INTO finance_company_period_events(tenant_id,id,action,through_date,reason,recorded_by) VALUES($1,$2,$3,$4,$5,$6)",
        [tenantId, id, input.action, input.throughDate, input.reason, ctx.authSubject],
      )
      await record(ctx, req.headers, "finance_company_period", id, "finance.company-period." + input.action, input)
      const value = { tenantId, data: { id, ...input } }
      await remember(ctx, key, "finance.company-period", input, value)
      return value
    })
    return reply.header("cache-control", "no-store").send(result)
  })
}
