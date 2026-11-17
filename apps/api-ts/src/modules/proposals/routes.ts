import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { integer, queryInteger } from "../registrations/query.js"
import { proposalSummary, queryInput } from "../sales/shared.js"

import { loadProposal, summary } from "./snapshot.js"
import { registerProposalCommands } from "./commands.js"
import { formalizeProposal } from "./formalize.js"

export function registerProposalRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  registerProposalCommands(app, dependencies)
  app.post<{ Params: { id: string } }>("/api/v1/proposals/:id/commercial-validation", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.proposals.read")
      requirePermission(context, "sales.proposals.manage")
      if (!z.strictObject({}).safeParse(request.body ?? {}).success || !z.string().uuid().safeParse(request.params.id).success) throw new Problem(422, "invalid_input", "Solicitação de validação inválida")
      const current = await loadProposal(context, request.params.id)
      const checked = await formalizeProposal(context, request.params.id, current.data.version, false)
      return { tenantId: context.tenantId, revision: current.data.revision, approvalCandidate: checked?.approval ?? null }
    }, false)
    return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body)
  })
  app.get<{ Params: { id: string } }>("/api/v1/proposals/:id", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.proposals.read")
      const parsed = z.strictObject({ version: queryInteger(1, 2_147_483_647).optional() }).safeParse(request.query)
      if (!parsed.success || !z.string().uuid().safeParse(request.params.id).success) throw new Problem(422, "invalid_input", "Versão ou identificador inválido")
      return loadProposal(context, request.params.id, parsed.data.version)
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })
  app.get("/api/v1/proposals", async (request, reply) => {
    const query = queryInput(request.query, ["", "draft", "sent", "accepted", "rejected", "cancelled", "expired"], true)
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
