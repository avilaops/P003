import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { commandKey, replay, remember, record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision } from "../../platform/revision.js"
import { decimal } from "../sales/fixed.js"
import { prepareProposal, storeProposalLines } from "./prepare.js"
import { proposalId, proposalInputSchema } from "./schema.js"
import { loadProposal } from "./snapshot.js"
import { registerProposalTransitions } from "./transitions.js"

export function registerProposalCommands(app: FastifyInstance, dependencies: AppDependencies) {
  registerProposalTransitions(app, dependencies)
  const save = async (request: FastifyRequest, existingId?: string) => {
    const key = commandKey(request.headers["idempotency-key"]), expected = existingId ? parseRevision(request.headers["if-match"]) : null
    const scope = existingId ? "proposal.update" : "proposal.create"
    return authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.proposals.read"); requirePermission(context, "sales.proposals.manage")
      const parsed = proposalInputSchema.safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "JSON inválido ou campos desconhecidos")
      const input = { id: existingId ?? null, revision: expected, input: parsed.data }
      const repeated = await replay(context, key, scope, input)
      if (repeated) return repeated
      const previous = existingId ? await loadProposal(context, existingId) : undefined
      if (previous && previous.data.revision !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      if (previous && (previous.data.status !== "draft" || previous.data.orderId !== null)) throw new Problem(409, "domain_conflict", "Somente rascunhos podem ser editados")
      const prepared = await prepareProposal(context, parsed.data, previous), id = existingId ?? randomUUID(), version = previous?.data.version ?? 1, next = expected === null ? 1 : nextRevision(expected)
      const { client, tenantId } = context
      if (!existingId) {
        await client.query("INSERT INTO sales_proposals(id,tenant_id) VALUES($1,$2)", [id, tenantId])
        await client.query("INSERT INTO sales_proposal_versions(tenant_id,proposal_id,version,customer_id,customer_name,customer_tax_id,valid_until,payment_terms,delivery_terms,notes,amount_cents,created_by) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [tenantId, id, parsed.data.customerId, prepared.customerName, prepared.customerTaxId, prepared.validity, prepared.payment, prepared.delivery, prepared.notes, prepared.total, context.authSubject])
      } else {
        await client.query("UPDATE sales_proposal_versions SET customer_id=$4,customer_name=$5,customer_tax_id=$6,valid_until=$7,payment_terms=$8,delivery_terms=$9,notes=$10,amount_cents=$11 WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3", [tenantId, id, version, parsed.data.customerId, prepared.customerName, prepared.customerTaxId, prepared.validity, prepared.payment, prepared.delivery, prepared.notes, prepared.total])
        await client.query("DELETE FROM sales_proposal_lines WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3", [tenantId, id, version])
        await client.query("UPDATE sales_proposals SET revision=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, id, next])
      }
      await storeProposalLines(context, id, version, prepared.lines)
      await record(context, request.headers, "sales_proposal", id, existingId ? "proposal.updated" : "proposal.created", { revision: next, version, amount: decimal(prepared.total, 2), items: prepared.lines.length })
      const body = await loadProposal(context, id)
      await remember(context, key, scope, input, body)
      return body
    })
  }
  app.post("/api/v1/proposals", async (request, reply) => {
    const body = await save(request)
    return reply.code(201).header("cache-control", "no-store").header("etag", `"${(body.data as Record<string, unknown>).revision}"`).send(body)
  })
  app.put<{ Params: { id: string } }>("/api/v1/proposals/:id", async (request, reply) => {
    const body = await save(request, proposalId(request.params.id))
    return reply.header("cache-control", "no-store").header("etag", `"${(body.data as Record<string, unknown>).revision}"`).send(body)
  })
}
