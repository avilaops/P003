import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { commandKey, replay, remember, record } from "../../platform/commands.js"
import { nextRevision, parseRevision } from "../../platform/revision.js"
import { Problem } from "../../platform/problem.js"
import { decimal } from "../sales/fixed.js"
import { prepareOrder, storeLines } from "./prepare.js"
import { orderInputSchema } from "./schema.js"
import { loadOrder } from "./snapshot.js"

export function registerOrderCommands(app: FastifyInstance, dependencies: AppDependencies) {
  app.post("/api/v1/orders", async (request, reply) => {
    const key = commandKey(request.headers["idempotency-key"])
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read"); requirePermission(context, "sales.orders.manage")
      const parsed = orderInputSchema.safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "JSON inválido ou campos desconhecidos")
      const previous = await replay(context, key, "order.create", parsed.data)
      if (previous) return previous
      const prepared = await prepareOrder(context, parsed.data), id = randomUUID()
      await context.client.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,$4,$5,$6,$7,'draft')", [id, context.tenantId, parsed.data.customerId, prepared.customerName, prepared.customerTaxId, prepared.due, prepared.total])
      await storeLines(context, id, prepared.lines)
      await record(context, request.headers, "sales_order", id, "order.created", { revision: 1, amount: decimal(prepared.total, 2), items: prepared.lines.length })
      const result = await loadOrder(context, id)
      await remember(context, key, "order.create", parsed.data, result)
      return result
    })
    return reply.code(201).header("cache-control", "no-store").header("etag", `"${(body.data as Record<string, unknown>).revision}"`).send(body)
  })
  app.put<{ Params: { id: string } }>("/api/v1/orders/:id", async (request, reply) => {
    const key = commandKey(request.headers["idempotency-key"]), expected = parseRevision(request.headers["if-match"])
    const id = z.string().uuid().safeParse(request.params.id)
    if (!id.success) throw new Problem(422, "invalid_input", "Identificador inválido")
    const outcome = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read"); requirePermission(context, "sales.orders.manage")
      const parsed = orderInputSchema.safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "JSON inválido ou campos desconhecidos")
      const orderId = id.data.toLowerCase(), input = { id: orderId, revision: expected, input: parsed.data }
      const quoted = await context.client.query<{ quoted: boolean }>("SELECT EXISTS(SELECT 1 FROM commercial_order_quotes WHERE tenant_id=$1 AND order_id=$2) OR EXISTS(SELECT 1 FROM order_pricing_snapshots WHERE tenant_id=$1 AND order_id=$2) AS quoted", [context.tenantId, orderId])
      if (quoted.rows[0]?.quoted) throw new Problem(409, "domain_conflict", "Pedido preserva uma negociação ou simulação calculada. Cancele o rascunho e refaça a simulação para negociar outras condições")
      const previous = await replay(context, key, "order.update", input)
      if (previous) return { body: previous, replayed: true }
      const current = await loadOrder(context, orderId)
      if (current.data.revision !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      if (current.data.status !== "draft") throw new Problem(409, "domain_conflict", "Somente pedidos em rascunho podem ser editados")
      if (current.checkout) throw new Problem(409, "domain_conflict", "Condições comerciais preservadas. Cancele e crie outro pedido para alterar o acordo")
      const prepared = await prepareOrder(context, parsed.data, current), next = nextRevision(expected)
      const changed = await context.client.query("UPDATE sales_orders SET customer_id=$3,customer_name=$4,customer_tax_id=$5,due_date=$6,amount_cents=$7,revision=$8,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='draft' AND revision=$9 RETURNING id", [context.tenantId, orderId, parsed.data.customerId, prepared.customerName, prepared.customerTaxId, prepared.due, prepared.total, next, expected])
      if (!changed.rows[0]) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      await context.client.query("DELETE FROM sales_order_lines WHERE tenant_id=$1 AND order_id=$2", [context.tenantId, orderId])
      await storeLines(context, orderId, prepared.lines)
      await record(context, request.headers, "sales_order", orderId, "order.updated", { previousRevision: expected, revision: next, previousAmount: current.data.amount, amount: decimal(prepared.total, 2), items: prepared.lines.length })
      const body = await loadOrder(context, orderId)
      await remember(context, key, "order.update", input, body)
      return { body, replayed: false }
    })
    if (outcome.replayed) reply.header("idempotency-replayed", "true")
    return reply.header("cache-control", "no-store").header("etag", `"${(outcome.body.data as Record<string, unknown>).revision}"`).send(outcome.body)
  })
}
