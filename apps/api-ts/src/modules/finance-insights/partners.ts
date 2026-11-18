import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { parseRevision, revisionValue } from "../../platform/revision.js"
import { Problem } from "../../platform/problem.js"
import { fixed } from "../sales/fixed.js"
import { decimal, sides, today, validate } from "./portfolio.js"

export function registerFinancePartners(app: FastifyInstance, deps: AppDependencies) {
  app.get("/api/v1/finance/partners", async (req, reply) => {
    const { q } = validate(z.object({ q: z.string().trim().max(100).default("") }).strict(), req.query)
    const data = await authorizeRequest(req, deps, async (ctx) => {
      const allowed = sides(ctx)
      const r = await ctx.client.query(
        `SELECT id,legal_name AS name,is_customer AS customer,is_supplier AS supplier FROM parties
        WHERE tenant_id=$1 AND ((is_customer AND $3) OR (is_supplier AND $4))
        AND ($2='' OR strpos(lower(legal_name),lower($2))>0 OR tax_id=$2) ORDER BY legal_name,id LIMIT 50`,
        [ctx.tenantId, q, allowed.includes("receivable"), allowed.includes("payable")],
      )
      return { tenantId: ctx.tenantId, data: r.rows }
    })
    return reply.header("cache-control", "no-store").send(data)
  })
  app.get("/api/v1/finance/partner", async (req, reply) => {
    const { partyId } = validate(z.object({ partyId: z.guid() }).strict(), req.query)
    const data = await authorizeRequest(req, deps, async (ctx) => {
      const allowed = sides(ctx),
        sales = allowed.includes("receivable")
      const party = (
        await ctx.client.query(
          "SELECT id,legal_name AS name,is_customer AS customer,is_supplier AS supplier FROM parties WHERE tenant_id=$1 AND id=$2 AND ((is_customer AND $3) OR (is_supplier AND $4))",
          [ctx.tenantId, partyId, sales, allowed.includes("payable")],
        )
      ).rows[0]
      if (!party) throw new Problem(404, "not_found", "Parceiro não encontrado")
      const position = (
        await ctx.client.query(
          `WITH wallet AS (SELECT * FROM finance_portfolio WHERE tenant_id=$1 AND party_id=$2 AND side=ANY($3::text[])),
        dates AS (
          SELECT p.occurred_on-w.competence_on AS days,p.amount_cents AS amount
            FROM wallet w JOIN receivable_payments p ON (p.tenant_id,p.receivable_id)=(w.tenant_id,w.id) WHERE w.side='receivable' AND p.kind='receipt' AND NOT EXISTS (SELECT FROM receivable_payments rev WHERE rev.tenant_id=p.tenant_id AND rev.reverses_id=p.id)
          UNION ALL SELECT p.occurred_on-w.competence_on,p.amount_cents
            FROM wallet w JOIN payable_payments p ON (p.tenant_id,p.payable_id)=(w.tenant_id,w.id) WHERE w.side='payable' AND p.kind='payment' AND NOT EXISTS (SELECT FROM payable_payments rev WHERE rev.tenant_id=p.tenant_id AND rev.reverses_id=p.id)
        ), orders AS (
          SELECT o.id,o.number::text AS number,o.amount_cents FROM sales_orders o WHERE o.tenant_id=$1 AND o.customer_id=$2 AND o.status IN ('accepted','confirmed') AND $4
          AND NOT EXISTS (SELECT 1 FROM fiscal_nfe_documents d WHERE d.tenant_id=o.tenant_id AND d.source_order_id=o.id AND d.status='authorized' AND d.environment='production')
        ), credit AS (SELECT limit_cents,revision FROM finance_partner_credit WHERE tenant_id=$1 AND party_id=$2 AND $4)
        SELECT ${decimal("coalesce(sum(open_cents) FILTER(WHERE side='receivable'),0)")} AS receivable,
          ${decimal("coalesce(sum(open_cents) FILTER(WHERE side='payable'),0)")} AS payable,
          ${decimal("coalesce(sum(open_cents) FILTER(WHERE due_date<" + today + " AND side='receivable'),0)")} AS "overdueReceivable",
          ${decimal("coalesce(sum(open_cents) FILTER(WHERE due_date<" + today + " AND side='payable'),0)")} AS "overduePayable",
          (SELECT round(sum(days::numeric*amount)/nullif(sum(amount),0),1)::text FROM dates) AS "averageDays",
          (SELECT ${decimal("coalesce(sum(amount_cents),0)")} FROM orders) AS "unbilled",
          (SELECT ${decimal("limit_cents")} FROM credit) AS "creditLimit",
          ${decimal("(SELECT limit_cents FROM credit)-coalesce(sum(open_cents) FILTER(WHERE side='receivable'),0)")} AS "creditAvailable",
          coalesce((SELECT revision::text FROM credit),'1') AS revision,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'number',number,'amount',${decimal("amount_cents")}) ORDER BY id),'[]') FROM orders) AS orders,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'number',left(p.id::text,8),'amount',${decimal("p.amount_cents")}) ORDER BY p.created_at,p.id),'[]')
            FROM purchase_orders p WHERE p.tenant_id=$1 AND p.supplier_id=$2 AND 'payable'=ANY($3::text[])
              AND p.status IN ('draft','confirmed','partially_received')) AS "purchaseOrders"
        FROM wallet`,
          [ctx.tenantId, partyId, allowed, sales],
        )
      ).rows[0]
      const writable = allowed.filter((side) => ctx.permissions.includes("finance." + side + "s.manage"))
      return {
        tenantId: ctx.tenantId,
        allowed,
        writable,
        canEditCredit: sales && writable.includes("receivable"),
        party,
        position,
      }
    })
    return reply
      .header("etag", '"' + String(data.position?.revision) + '"')
      .header("cache-control", "no-store")
      .send(data)
  })
  app.put("/api/v1/finance/partner/credit", async (req, reply) => {
    const f = validate(z.object({ partyId: z.guid(), limit: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/) }).strict(), req.body)
    const expected = parseRevision(req.headers["if-match"])
    const value = await authorizeRequest(req, deps, async (ctx) => {
      requirePermission(ctx, "finance.receivables.read")
      requirePermission(ctx, "finance.receivables.manage")
      const allowed = await ctx.client.query("SELECT id FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer", [
        ctx.tenantId,
        f.partyId,
      ])
      if (!allowed.rows.length) throw new Problem(404, "not_found", "Cliente não encontrado")
      const current = (
        await ctx.client.query("SELECT revision FROM finance_partner_credit WHERE tenant_id=$1 AND party_id=$2", [
          ctx.tenantId,
          f.partyId,
        ])
      ).rows[0]
      if (revisionValue(current?.revision ?? 1) !== expected)
        throw new Problem(412, "revision_conflict", "O limite mudou. Atualize a ficha")
      const updated = await ctx.client.query(
        "INSERT INTO finance_partner_credit(tenant_id,party_id,limit_cents) VALUES($1,$2,$3) ON CONFLICT(tenant_id,party_id) DO UPDATE SET limit_cents=excluded.limit_cents,revision=finance_partner_credit.revision+1 RETURNING revision",
        [
          ctx.tenantId,
          f.partyId,
          fixed(f.limit.includes(".") ? f.limit.padEnd(f.limit.indexOf(".") + 3, "0") : f.limit + ".00", 2),
        ],
      )
      await record(ctx, req.headers, "finance_partner", f.partyId, "finance.credit.updated", { limit: f.limit })
      return { tenantId: ctx.tenantId, revision: revisionValue(updated.rows[0]!.revision) }
    })
    return reply.header("etag", '"' + value.revision + '"').send(value)
  })
}
