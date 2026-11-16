import type { FastifyInstance } from "fastify"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { integer } from "../registrations/query.js"
import { proposalSummary, queryInput } from "../sales/shared.js"

const summary = "SELECT p.id,p.number::text AS number,v.version,p.revision,v.customer_id,v.customer_name,v.customer_tax_id,v.valid_until::text AS valid_until,v.payment_terms,v.delivery_terms,v.notes,(v.amount_cents::numeric/100)::numeric(16,2)::text AS amount,v.status,(v.status='sent' AND v.valid_until < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date) AS expired,p.order_id,(v.version=p.current_version) AS is_current,v.created_at::text AS created_at,to_json(p.updated_at)#>>'{}' AS updated_at,v.sent_at::text AS sent_at,v.decided_at::text AS decided_at,v.decided_by,v.decision_reason FROM sales_proposals p JOIN sales_proposal_versions v ON v.tenant_id=p.tenant_id AND v.proposal_id=p.id"

export function registerProposalRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/proposals", async (request, reply) => {
    const query = queryInput(request.query, ["", "draft", "sent", "accepted", "rejected", "cancelled", "expired"])
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.proposals.read")
      const filter = " WHERE p.tenant_id=$1 AND v.version=p.current_version AND ($2='' OR strpos(lower(v.customer_name),lower($2))>0 OR p.number::text=$2) AND ($3='' OR ($3='expired' AND v.status='sent' AND v.valid_until < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date) OR (v.status=$3 AND ($3<>'sent' OR v.valid_until >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date)))"
      const order = query.sort === "updated" ? "p.updated_at DESC,p.id DESC" : "p.created_at DESC,p.id DESC"
      const rows = await context.client.query(`${summary}${filter} ORDER BY ${order} LIMIT $4 OFFSET $5`, [context.tenantId, query.q, query.status, query.limit, query.offset])
      const count = await context.client.query<{ total: string }>(`SELECT count(*)::text AS total FROM (${summary}${filter}) filtered`, [context.tenantId, query.q, query.status])
      return { tenantId: context.tenantId, canEdit: context.permissions.includes("sales.proposals.manage"), data: rows.rows.map(proposalSummary), total: integer(count.rows[0]?.total ?? 0), offset: query.offset, limit: query.limit }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
}
