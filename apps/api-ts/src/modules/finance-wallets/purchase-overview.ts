import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { decimal } from "../sales/fixed.js"

/** Indicadores e pendências da visão geral de Compras (C8). Tudo filtrado pela empresa ativa. */
export function registerPurchaseOverview(app: FastifyInstance, deps: AppDependencies) {
  app.get("/api/v1/purchase-overview", { config: { openapi: { summary: "Indicadores da visão geral de compras" } } }, async (req, reply) => {
    const body = await authorizeRequest(req, deps, async ctx => {
      requirePermission(ctx, "purchasing.orders.read")
      const today = "(statement_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date"
      const orders = (
        await ctx.client.query(
          `SELECT count(*) FILTER (WHERE status IN ('draft','awaiting_approval','confirmed','partially_received'))::int AS open_count,
             coalesce(sum(amount_cents) FILTER (WHERE status IN ('draft','awaiting_approval','confirmed','partially_received')),0) AS open_cents,
             count(*) FILTER (WHERE status='awaiting_approval')::int AS awaiting_approval,
             count(*) FILTER (WHERE status IN ('confirmed','partially_received'))::int AS awaiting_receipt,
             count(*) FILTER (WHERE status IN ('confirmed','partially_received') AND due_date<${today})::int AS late
           FROM purchase_orders WHERE tenant_id=$1`,
          [ctx.tenantId],
        )
      ).rows[0]!
      const payable = (
        await ctx.client.query(
          `SELECT coalesce(sum(amount_cents),0) AS cents,count(*)::int AS n FROM payables
           WHERE tenant_id=$1 AND status='open' AND due_date BETWEEN ${today} AND ${today}+7`,
          [ctx.tenantId],
        )
      ).rows[0]!
      const unlinked = (
        await ctx.client.query(
          `SELECT count(*)::int AS n FROM fiscal_received_nfes n WHERE n.tenant_id=$1 AND n.own_return_document_id IS NULL
           AND NOT EXISTS(SELECT 1 FROM fiscal_received_purchase_links l WHERE l.tenant_id=n.tenant_id AND l.received_nfe_id=n.id)`,
          [ctx.tenantId],
        )
      ).rows[0]!
      const replenish = (
        await ctx.client.query(
          `SELECT count(*)::int AS n FROM stock_replenishment_rules r JOIN stock_balances b ON (b.tenant_id,b.product_id)=(r.tenant_id,r.product_id)
           WHERE r.tenant_id=$1 AND r.reorder_micros>0 AND b.quantity_micros<=r.reorder_micros`,
          [ctx.tenantId],
        )
      ).rows[0]!
      return {
        tenantId: ctx.tenantId,
        data: {
          openOrders: { count: Number(orders.open_count), amount: decimal(BigInt(String(orders.open_cents)), 2) },
          awaitingApproval: Number(orders.awaiting_approval),
          awaitingReceipt: Number(orders.awaiting_receipt),
          lateReceipts: Number(orders.late),
          payableNext7Days: { count: Number(payable.n), amount: decimal(BigInt(String(payable.cents)), 2) },
          notesWithoutOrder: Number(unlinked.n),
          replenishmentSuggestions: Number(replenish.n),
        },
      }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
}
