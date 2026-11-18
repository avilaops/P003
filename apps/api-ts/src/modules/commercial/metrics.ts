import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { commissionMetrics } from "../finance-management/metrics.js"
import { validateDate } from "../sales/fixed.js"

const queries = {
  orders: { permission: "sales.orders.read", sql: "WITH period AS(SELECT COALESCE($2::date,date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date) AS start), completed AS(SELECT o.* FROM sales_orders o,period p WHERE o.tenant_id=$1 AND o.status='completed' AND EXISTS(SELECT 1 FROM audit_log a WHERE a.tenant_id=o.tenant_id AND a.entity_id=o.id::text AND a.action='order.completed' AND (a.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date>=p.start AND (a.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date<(p.start+interval '1 month')::date)) SELECT jsonb_build_object('month',(SELECT to_char(start,'YYYY-MM') FROM period),'openCents',(SELECT COALESCE(sum(amount_cents),0) FROM sales_orders WHERE tenant_id=$1 AND status IN('draft','accepted','confirmed')),'openCount',(SELECT count(*) FROM sales_orders WHERE tenant_id=$1 AND status IN('draft','accepted','confirmed')),'completedCents',(SELECT COALESCE(sum(amount_cents),0) FROM completed),'completedCount',(SELECT count(*) FROM completed),'pendingApprovalCount',(SELECT count(*) FROM commercial_order_quotes q JOIN sales_orders o ON o.tenant_id=q.tenant_id AND o.id=q.order_id WHERE q.tenant_id=$1 AND o.status='draft' AND q.approval_status='pending'),'averageDiscountBps',(SELECT round(avg((q.public_snapshot->'sale'->>'discountBps')::numeric)) FROM completed c JOIN commercial_order_quotes q ON q.tenant_id=c.tenant_id AND q.order_id=c.id))" },
  commissions: { permission: "finance.commissions.read", sql: commissionMetrics },
}
export function registerCommercialMetrics(app: FastifyInstance, dependencies: AppDependencies) {
  for (const action of ["orders", "commissions"] as const) app.get("/api/v1/commercial/metrics/" + action, async (request, reply) => {
    const parsed = z.strictObject({ month: z.string().optional() }).safeParse(request.query)
    if (!parsed.success) throw new Problem(422, "invalid_input", "Competência inválida")
    if (parsed.data.month !== undefined && parsed.data.month.length !== 7) throw new Problem(422, "invalid_input", "Competência deve usar AAAA-MM")
    const month = parsed.data.month === undefined ? null : validateDate(parsed.data.month + "-01")
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, queries[action].permission)
      const row = (await context.client.query(queries[action].sql + " AS data", [context.tenantId, month])).rows[0]!
      return { tenantId: context.tenantId, data: row.data }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
}
