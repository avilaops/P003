import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { reloadTenantPermissions } from "../../platform/database.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"

function idValue(value: string) {
  const parsed = z.guid().safeParse(value)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Identificador inválido")
  return parsed.data.toLowerCase()
}
export function registerOrderPricing(app: FastifyInstance, dependencies: AppDependencies) {
  app.get<{ Params: { id: string } }>("/api/v1/orders/:id/pricing", async (request, reply) => {
    const result = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read")
      const id = idValue(request.params.id)
      const order = (await context.client.query("SELECT revision,status FROM sales_orders WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])).rows[0]
      if (!order) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
      const row = (await context.client.query("SELECT snapshot,needs_approval,approved_by FROM order_pricing_snapshots WHERE tenant_id=$1 AND order_id=$2", [context.tenantId, id])).rows[0]
      await reloadTenantPermissions(context)
      const canApprove = context.permissions.includes("platform.company.manage")
      let data = null
      if (row) {
        let snapshot = row.snapshot
        if (!(canApprove && context.permissions.includes("sales.approvals.director"))) {
          if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) throw Error("Invalid saved pricing snapshot")
          const visible: Record<string, unknown> = { ...snapshot }; delete visible.director
          snapshot = visible
        }
        data = { snapshot, needsApproval: row.needs_approval, approved: row.approved_by !== null }
      }
      return { revision: revisionValue(order.revision), body: { tenantId: context.tenantId, canApprove: canApprove && order.status === "draft", data } }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${result.revision}"`).send(result.body)
  })
  app.post<{ Params: { id: string } }>("/api/v1/orders/:id/pricing/approve", async (request, reply) => {
    const key = commandKey(request.headers["idempotency-key"]), expected = parseRevision(request.headers["if-match"])
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read")
      requirePermission(context, "platform.company.manage")
      const id = idValue(request.params.id), parsed = z.strictObject({ reason: z.string() }).safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Informe o motivo da aprovação")
      const reason = parsed.data.reason.trim(), length = Array.from(reason).length
      if (length < 3 || length > 2000 || /\p{Cc}/u.test(reason)) throw new Problem(422, "invalid_input", "Motivo exige de 3 a 2000 caracteres sem controles")
      const input = { id, revision: expected, reason }, scope = "order.pricing.approved"
      const repeated = await replay(context, key, scope, input)
      if (repeated) return repeated
      const order = (await context.client.query("SELECT revision,status FROM sales_orders WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])).rows[0]
      if (!order) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
      if (revisionValue(order.revision) !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      if (order.status !== "draft") throw new Problem(409, "domain_conflict", "Aprovação exige pedido em rascunho")
      const approved = await context.client.query("UPDATE order_pricing_snapshots SET approved_by=$3,approved_at=now(),approval_reason=$4 WHERE tenant_id=$1 AND order_id=$2 AND needs_approval AND approved_by IS NULL RETURNING order_id", [context.tenantId, id, context.authSubject, reason])
      if (approved.rows.length !== 1) throw new Problem(409, "domain_conflict", "Nenhuma exceção pendente neste pedido")
      const next = nextRevision(expected)
      await context.client.query("UPDATE sales_orders SET revision=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, next])
      await record(context, request.headers, "sales_order", id, scope, { revision: next, reason })
      const result = { tenantId: context.tenantId, id, revision: next, approved: true }
      await remember(context, key, scope, input, result)
      return result
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body)
  })
}
