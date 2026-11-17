import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, replay, remember, record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, type Revision } from "../../platform/revision.js"
import { validateDate } from "../sales/fixed.js"
import { proposalId, proposalText, proposalTransition } from "./schema.js"
import { loadProposal } from "./snapshot.js"
import type { CommandHeaders } from "../orders/receivables.js"
import { formalizeProposal, transferProposalAgreement } from "./formalize.js"

async function revise(context: AuthorizedContext, id: string, version: number, next: Revision) {
  if (version === 2147483647) throw new Problem(409, "domain_conflict", "Limite de versões atingido")
  const { client, tenantId } = context, nextVersion = version + 1
  await client.query("INSERT INTO sales_proposal_versions(tenant_id,proposal_id,version,customer_id,customer_name,customer_tax_id,valid_until,payment_terms,delivery_terms,notes,amount_cents,created_by) SELECT tenant_id,proposal_id,$4,customer_id,customer_name,customer_tax_id,valid_until,payment_terms,delivery_terms,notes,amount_cents,$5 FROM sales_proposal_versions WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3", [tenantId, id, version, nextVersion, context.authSubject])
  await client.query("INSERT INTO sales_proposal_lines(tenant_id,proposal_id,version,line_number,product_id,sku,name,unit,quantity_micros,catalog_price_cents,price_cents,amount_cents,structure_color,upholstery_color,plate_holder_color,plate_holder_type,swing_arm_color) SELECT tenant_id,proposal_id,$4,line_number,product_id,sku,name,unit,quantity_micros,catalog_price_cents,price_cents,amount_cents,structure_color,upholstery_color,plate_holder_color,plate_holder_type,swing_arm_color FROM sales_proposal_lines WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3", [tenantId, id, version, nextVersion])
  await client.query("UPDATE sales_proposal_versions SET status='superseded' WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3", [tenantId, id, version])
  await client.query("UPDATE sales_proposals SET current_version=$3,revision=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, id, nextVersion, next])
  await client.query("UPDATE sales_proposal_versions target SET commercial_public=source.commercial_public,commercial_private=source.commercial_private,customer_snapshot=source.customer_snapshot,checkout_snapshot=source.checkout_snapshot FROM sales_proposal_versions source WHERE target.tenant_id=$1 AND target.proposal_id=$2 AND target.version=$4 AND source.tenant_id=target.tenant_id AND source.proposal_id=target.proposal_id AND source.version=$3", [tenantId, id, version, nextVersion])
  await client.query("UPDATE sales_proposal_lines target SET technical_snapshot=source.technical_snapshot FROM sales_proposal_lines source WHERE target.tenant_id=$1 AND target.proposal_id=$2 AND target.version=$4 AND source.tenant_id=target.tenant_id AND source.proposal_id=target.proposal_id AND source.version=$3 AND source.line_number=target.line_number", [tenantId, id, version, nextVersion])
  return { version: nextVersion, revision: next, previousVersion: version }
}

async function convert(context: AuthorizedContext, headers: CommandHeaders, current: Awaited<ReturnType<typeof loadProposal>>, due: string, approve: boolean, next: Revision) {
  const { client, tenantId } = context, id = current.data.id, version = current.data.version
  const active = (await client.query("SELECT EXISTS(SELECT 1 FROM parties WHERE tenant_id=$1 AND id=$2 AND status='active' AND is_customer) AS active", [tenantId, current.data.customerId])).rows[0]?.active
  const invalid = (await client.query("SELECT EXISTS(SELECT 1 FROM sales_proposal_lines l JOIN products p ON p.tenant_id=l.tenant_id AND p.id=l.product_id WHERE l.tenant_id=$1 AND l.proposal_id=$2 AND l.version=$3 AND (p.status<>'active' OR p.unit<>l.unit)) AS invalid", [tenantId, id, version])).rows[0]?.invalid
  if (!active || invalid) throw new Problem(409, "domain_conflict", "Cliente ou produtos mudaram; revise os cadastros antes de converter")
  const commercial = await formalizeProposal(context, String(id), version)
  if (approve && current.data.status !== "accepted") {
    await client.query("UPDATE sales_proposal_versions SET status='accepted',sent_at=COALESCE(sent_at,now()),decided_at=now(),decided_by=$4,decision_reason='Aprovação e criação de pedido' WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3", [tenantId, id, version, context.authSubject])
    await record(context, headers, "sales_proposal", String(id), "proposal.accepted", { version, revision: next, from: current.data.status, to: "accepted", approvalAndOrder: true })
  }
  const order = randomUUID()
  await client.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) SELECT $4,tenant_id,customer_id,customer_name,customer_tax_id,$5,amount_cents,'draft' FROM sales_proposal_versions WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3", [tenantId, id, version, order, due])
  await client.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents,structure_color,upholstery_color,plate_holder_color,plate_holder_type,swing_arm_color) SELECT tenant_id,$4,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents,structure_color,upholstery_color,plate_holder_color,plate_holder_type,swing_arm_color FROM sales_proposal_lines WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3", [tenantId, id, version, order])
  await client.query("UPDATE sales_proposals SET order_id=$3,revision=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, id, order, next])
  if (commercial) {
    await transferProposalAgreement(context, order, commercial)
    await client.query("UPDATE sales_order_lines target SET technical_snapshot=source.technical_snapshot FROM sales_proposal_lines source WHERE target.tenant_id=$1 AND target.order_id=$4 AND source.tenant_id=target.tenant_id AND source.proposal_id=$2 AND source.version=$3 AND source.line_number=target.line_number", [tenantId, id, version, order])
  }
  await record(context, headers, "sales_order", order, "order.created", { proposalId: id, proposalVersion: version, revision: 1 })
  return { version, revision: next, orderId: order }
}

export function registerProposalTransitions(app: FastifyInstance, dependencies: AppDependencies) {
  app.post<{ Params: { id: string; action: string } }>("/api/v1/proposals/:id/:action", async (request, reply) => {
    const { action } = request.params
    const events: Record<string, string> = { send: "proposal.sent", accept: "proposal.accepted", reject: "proposal.rejected", cancel: "proposal.cancelled", revise: "proposal.revised", convert: "proposal.converted", "approve-order": "proposal.approved_order" }
    const event = Object.hasOwn(events, action) ? events[action] : undefined
    if (!event) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
    const key = commandKey(request.headers["idempotency-key"]), expected = parseRevision(request.headers["if-match"]), id = proposalId(request.params.id)
    const conversion = action === "convert" || action === "approve-order"
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.proposals.read")
      requirePermission(context, ["accept", "reject"].includes(action) ? "sales.proposals.decide" : "sales.proposals.manage")
      if (conversion) {
        if (action === "approve-order") requirePermission(context, "sales.proposals.decide")
        requirePermission(context, "sales.orders.read"); requirePermission(context, "sales.orders.manage")
      }
      let reason: string | undefined, due: string | undefined
      if (conversion) {
        const parsed = z.strictObject({ dueDate: z.string() }).safeParse(request.body)
        if (!parsed.success) throw new Problem(422, "invalid_input", "JSON inválido ou campos desconhecidos")
        due = validateDate(parsed.data.dueDate)
      } else if (action !== "revise") {
        const parsed = z.strictObject({ reason: z.string().nullable().optional() }).safeParse(request.body)
        if (!parsed.success) throw new Problem(422, "invalid_input", "JSON inválido ou campos desconhecidos")
        reason = proposalText(parsed.data.reason ?? "", 2000, action === "reject" || action === "cancel")
      }
      const input = { id, revision: expected, ...(conversion ? { dueDate: due } : action === "revise" ? {} : { reason }) }
      const repeated = await replay(context, key, event, input)
      if (repeated) return repeated
      const current = await loadProposal(context, id)
      if (current.data.revision !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      const today = String((await context.client.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date::text AS today")).rows[0]!.today)
      const status = proposalTransition(String(current.data.status), action, validateDate(String(current.data.validUntil)), today, current.data.orderId !== null), next = nextRevision(expected)
      if (action === "send" || action === "accept") await formalizeProposal(context, id, current.data.version)
      let details: unknown
      if (conversion) details = await convert(context, request.headers, current, due!, action === "approve-order", next)
      else if (action === "revise") details = await revise(context, id, current.data.version, next)
      else {
        await context.client.query("UPDATE sales_proposal_versions SET status=$4,sent_at=CASE WHEN $4='sent' THEN now() ELSE sent_at END,decided_at=CASE WHEN $4<>'sent' THEN now() ELSE decided_at END,decided_by=CASE WHEN $4<>'sent' THEN $5 ELSE decided_by END,decision_reason=CASE WHEN $4<>'sent' THEN $6 ELSE decision_reason END WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3", [context.tenantId, id, current.data.version, status, context.authSubject, reason])
        await context.client.query("UPDATE sales_proposals SET revision=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, next])
        details = { version: current.data.version, revision: next, from: current.data.status, to: status }
      }
      await record(context, request.headers, "sales_proposal", id, event, details)
      const result = await loadProposal(context, id)
      await remember(context, key, event, input, result)
      return result
    })
    return reply.header("cache-control", "no-store").header("etag", `"${(body.data as Record<string, unknown>).revision}"`).send(body)
  })
}
