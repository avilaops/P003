import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { integer } from "../registrations/query.js"
import { proposalSummary, queryInput } from "../sales/shared.js"

const summary = "SELECT p.id,p.number::text AS number,v.version,p.revision,v.customer_id,v.customer_name,v.customer_tax_id,v.valid_until::text AS valid_until,v.payment_terms,v.delivery_terms,v.notes,(v.amount_cents::numeric/100)::numeric(16,2)::text AS amount,v.status,(v.status='sent' AND v.valid_until < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date) AS expired,p.order_id,(v.version=p.current_version) AS is_current,v.created_at::text AS created_at,to_json(p.updated_at)#>>'{}' AS updated_at,v.sent_at::text AS sent_at,v.decided_at::text AS decided_at,v.decided_by,v.decision_reason FROM sales_proposals p JOIN sales_proposal_versions v ON v.tenant_id=p.tenant_id AND v.proposal_id=p.id"

export function registerProposalRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get<{ Params: { id: string } }>("/api/v1/proposals/:id", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.proposals.read")
      const parsed = z.strictObject({ version: z.coerce.number().int().min(1).max(2_147_483_647).optional() }).safeParse(request.query)
      if (!parsed.success || !z.string().uuid().safeParse(request.params.id).success) throw new Problem(422, "invalid_input", "Versão ou identificador inválido")
      const row = await context.client.query(`${summary} WHERE p.tenant_id=$1 AND p.id=$2 AND v.version=COALESCE($3,p.current_version)`, [context.tenantId, request.params.id, parsed.data.version ?? null])
      if (!row.rows[0]) throw new Problem(404, "not_found", "Proposta não encontrada")
      const data = proposalSummary(row.rows[0])
      const lines = await context.client.query("SELECT product_id,sku,name,unit,(quantity_micros::numeric/1000000)::numeric(19,6)::text AS quantity,(price_cents::numeric/100)::numeric(16,2)::text AS unit_price,(catalog_price_cents::numeric/100)::numeric(16,2)::text AS catalog_price,(amount_cents::numeric/100)::numeric(16,2)::text AS amount,structure_color,upholstery_color,plate_holder_color,plate_holder_type,swing_arm_color FROM sales_proposal_lines WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3 ORDER BY line_number", [context.tenantId, request.params.id, data.version])
      const versions = await context.client.query(`${summary} WHERE p.tenant_id=$1 AND p.id=$2 ORDER BY v.version DESC`, [context.tenantId, request.params.id])
      const items = lines.rows.map(item => ({
        productId: item.product_id, sku: item.sku, name: item.name, unit: item.unit, quantity: item.quantity, unitPrice: item.unit_price, catalogPrice: item.catalog_price, amount: item.amount,
        structureColor: item.structure_color, upholsteryColor: item.upholstery_color,
        ...(item.swing_arm_color == null ? {} : { swingArmColor: item.swing_arm_color }),
        ...(item.plate_holder_color == null ? {} : { plateHolderColor: item.plate_holder_color }),
        ...(item.plate_holder_type == null ? {} : { plateHolderType: item.plate_holder_type }),
      }))
      return { tenantId: context.tenantId, canEdit: context.permissions.includes("sales.proposals.manage"), data, items, versions: versions.rows.map(proposalSummary) }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })
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
