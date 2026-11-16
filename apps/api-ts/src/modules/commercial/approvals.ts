import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { commandKey, replay, remember, record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { loadCheckout } from "../orders/checkout.js"

const policy = "platform.company.manage", director = "sales.approvals.director", manager = "sales.approvals.manage", read = "sales.orders.read"
export const approvalRulesSchema = z.strictObject({ belowTarget: z.boolean(), freight: z.boolean(), directorAutoApproval: z.boolean(), managerLimit: z.enum(["profit", "target"]) })
function idValue(value: string) {
  const id = z.string().uuid().safeParse(value)
  if (!id.success) throw new Problem(422, "invalid_input", "Identificador inválido")
  return id.data.toLowerCase()
}
export function registerCommercialApprovalRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  const settings = "/api/v1/commercial/approval-settings"
  app.get(settings, async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, policy)
      const row = (await context.client.query("SELECT revision,rules FROM commercial_approval_settings WHERE tenant_id=$1", [context.tenantId])).rows[0]
      return { tenantId: context.tenantId, revision: row ? revisionValue(row.revision) : 1, data: row?.rules ?? null }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body)
  })
  app.put(settings, async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, policy)
      const expected = parseRevision(request.headers["if-match"]), parsed = approvalRulesSchema.safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Regras de aprovação inválidas")
      const row = (await context.client.query("SELECT revision FROM commercial_approval_settings WHERE tenant_id=$1", [context.tenantId])).rows[0]
      if ((row ? revisionValue(row.revision) : 1) !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      const next = nextRevision(expected)
      await context.client.query("INSERT INTO commercial_approval_settings(tenant_id,revision,rules) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET revision=$2,rules=$3,updated_at=now()", [context.tenantId, next, parsed.data])
      await record(context, request.headers, "commercial_approval_settings", context.tenantId, "commercial_approval_settings.updated", { revision: next })
      return { tenantId: context.tenantId, revision: next, data: parsed.data }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body)
  })
  app.get<{ Params: { id: string } }>("/api/v1/commercial/orders/:id", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, read)
      const id = idValue(request.params.id)
      const row = (await context.client.query("SELECT q.public_snapshot,q.private_snapshot,q.approval_status,q.requires_director,o.revision FROM commercial_order_quotes q JOIN sales_orders o ON o.tenant_id=q.tenant_id AND o.id=q.order_id WHERE q.tenant_id=$1 AND q.order_id=$2", [context.tenantId, id])).rows[0]
      if (!row) return { tenantId: context.tenantId, data: null }
      const allowed = (permission: string) => context.permissions.includes(permission)
      const canApprove = allowed(director) || !row.requires_director && allowed(manager)
      const details = allowed(policy) && allowed(director) ? (row.private_snapshot as Record<string, unknown>).director ?? null : null
      const decisions = await context.client.query("SELECT jsonb_build_object('decision',d.decision,'reason',d.reason,'createdAt',d.created_at,'decidedBy',i.display_name) AS data FROM commercial_approval_decisions d JOIN identities i ON i.id=d.decided_by WHERE d.tenant_id=$1 AND d.order_id=$2 ORDER BY d.created_at,d.id", [context.tenantId, id])
      return { tenantId: context.tenantId, revision: revisionValue(row.revision), data: row.public_snapshot, director: details, approvalStatus: row.approval_status, canApprove, decisions: decisions.rows.map(row => row.data), checkout: await loadCheckout(context, id) ?? null }
    })
    if (body.revision !== undefined) reply.header("etag", `"${body.revision}"`)
    return reply.header("cache-control", "no-store").send(body)
  })
  app.post<{ Params: { id: string } }>("/api/v1/commercial/orders/:id/decision", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, read)
      const expected = parseRevision(request.headers["if-match"]), key = commandKey(request.headers["idempotency-key"]), id = idValue(request.params.id)
      const parsed = z.strictObject({ approved: z.boolean(), reason: z.string() }).safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Decisão inválida")
      const reason = parsed.data.reason.trim()
      if (!reason || Array.from(reason).length > 1000 || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(reason)) throw new Problem(422, "invalid_input", "Informe o motivo da decisão, até 1000 caracteres")
      const row = (await context.client.query("SELECT q.requires_director,q.approval_status,o.revision,o.status FROM commercial_order_quotes q JOIN sales_orders o ON o.tenant_id=q.tenant_id AND o.id=q.order_id WHERE q.tenant_id=$1 AND q.order_id=$2", [context.tenantId, id])).rows[0]
      if (!row) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
      if (!context.permissions.includes(director) && (row.requires_director || !context.permissions.includes(manager))) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
      const input = { id, revision: expected, approved: parsed.data.approved, reason }
      const repeated = await replay(context, key, "negotiation.decision", input)
      if (repeated) return repeated
      if (revisionValue(row.revision) !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      if (row.approval_status !== "pending" || row.status !== "draft") throw new Problem(409, "domain_conflict", "Somente negociações pendentes em rascunho podem receber decisão")
      const next = nextRevision(expected), status = parsed.data.approved ? "approved" : "rejected"
      await context.client.query("UPDATE commercial_order_quotes SET approval_status=$3 WHERE tenant_id=$1 AND order_id=$2", [context.tenantId, id, status])
      await context.client.query("UPDATE sales_orders SET revision=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, next])
      await context.client.query("INSERT INTO commercial_approval_decisions(id,tenant_id,order_id,order_revision,decision,reason,decided_by) SELECT $1,$2,$3,$4,$5,$6,id FROM identities WHERE auth_subject=$7", [randomUUID(), context.tenantId, id, next, status, reason, context.authSubject])
      await record(context, request.headers, "sales_order", id, "negotiation.decided", { revision: next, decision: status })
      const result = { tenantId: context.tenantId, id, revision: next, approvalStatus: status }
      await remember(context, key, "negotiation.decision", input, result)
      return result
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body)
  })
}
