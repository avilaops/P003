import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { commandKey, replay, remember, record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision } from "../../platform/revision.js"
import { conflict, validateAcceptance, validateCustomer, validateProducts } from "./acceptance.js"
import { reconcileCancellation, requireCancellationPermissions } from "./cancellation.js"
import { issueOrder, reserveOrder, validateFiscalCompletion } from "./fulfillment.js"
import { cancelUnpaid, originateOnCompletion, originateSchedule, verifyReceivables } from "./receivables.js"
import { checkOrderCredit } from "../commercial/credit.js"
import { loadOrder } from "./snapshot.js"
import { canReadRealizedMargin } from "./realized-margin.js"
import { allocateOrderAdvances } from "../finance-insights/operations.js"
import { freezeOrderPolicies, onInvoicedOrder } from "../finance-management/accrual.js"
import { orderEffects } from "../fiscal/operation-types/model.js"

const targets = { accept: "accepted", confirm: "confirmed", cancel: "cancelled", complete: "completed" } as const
export function registerOrderTransitions(app: FastifyInstance, dependencies: AppDependencies) {
  for (const action of ["accept", "confirm", "cancel", "complete"] as const) {
    app.post<{ Params: { id: string } }>(`/api/v1/orders/:id/${action}`, async (request, reply) => {
      const key = commandKey(request.headers["idempotency-key"]), expected = parseRevision(request.headers["if-match"])
      const parsed = z.guid().safeParse(request.params.id)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Identificador inválido")
      const id = parsed.data.toLowerCase(), scope = `order.${action}`, target = targets[action]
      const body = await authorizeRequest(request, dependencies, async context => {
        requirePermission(context, "sales.orders.read"); requirePermission(context, "sales.orders.manage")
        const input = { id, revision: expected }
        // Production rights must still be current when returning an old cancellation.
        if (action === "cancel") await requireCancellationPermissions(context, id)
        const previous = await replay(context, key, scope, input)
        if (previous) {
          if (canReadRealizedMargin(context)) return previous
          const { realizedMargin: _margin, ...visible } = previous
          return visible
        }
        const current = await loadOrder(context, id), status = String(current.data.status)
        // F1: o tipo de operação do pedido decide estoque, títulos e comissão (sem tipo, venda padrão).
        const effects = await orderEffects(context, id)
        if (current.data.revision !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
        if ((action === "accept" && status === "draft") || (action === "confirm" && ["draft", "accepted"].includes(status))) {
          const credit = await checkOrderCredit(context, request.headers, id, String(current.data.customerId), expected, status)
          if (credit) return { creditConflict: credit }
        }
        if (action === "accept") {
          if (status !== "draft") conflict("Somente pedidos em rascunho podem ser aceitos")
          if (!current.checkout) conflict("Aceitar encomenda exige condições completas de entrada e parcelas")
          await validateAcceptance(context, current)
          if (effects.generatesFinance) await originateSchedule(context, request.headers, id, true)
        } else {
          const allowed = action === "complete" ? status === "confirmed" : (action === "confirm" ? ["draft", "accepted"] : ["draft", "accepted", "confirmed"]).includes(status)
          if (!allowed) conflict("Transição não permitida para a situação atual do pedido")
          if (action === "complete") await validateFiscalCompletion(context, id)
          if (action === "confirm" || action === "complete") {
            await validateCustomer(context, current)
            if (action === "confirm") {
              if (status === "draft") await validateAcceptance(context, current)
              else await validateProducts(context, current)
              if (effects.movesStock) await reserveOrder(context, current)
            } else if (effects.movesStock) await issueOrder(context, request.headers, current)
          }
          if (action === "confirm" && effects.generatesFinance) {
            if (status === "accepted") await verifyReceivables(context, id)
            else await originateSchedule(context, request.headers, id, false)
          }
          if (action === "complete" && effects.generatesFinance) await originateOnCompletion(context, request.headers, id)
        }
        if ((action === "accept" || action === "confirm") && status === "draft" && effects.generatesCommission) await freezeOrderPolicies(context, id)
        const next = nextRevision(expected)
        if (action === "cancel") {
          await cancelUnpaid(context, request.headers, id)
          await reconcileCancellation(context, request.headers, id, next)
        }
        await context.client.query("UPDATE sales_orders SET status=$3,revision=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, target, next])
        await record(context, request.headers, "sales_order", id, `order.${target}`, { previousRevision: expected, revision: next, previousStatus: status, status: target })
        if (action === "complete" && effects.generatesFinance) {
          await onInvoicedOrder(context, request.headers, id)
          await allocateOrderAdvances(context, request.headers, id)
        }
        const result = await loadOrder(context, id)
        await remember(context, key, scope, input, result)
        return result
      })
      if ("creditConflict" in body && typeof body.creditConflict === "string") throw new Problem(409, "domain_conflict", body.creditConflict)
      return reply.header("cache-control", "no-store").header("etag", `"${(body.data as Record<string, unknown>).revision}"`).send(body)
    })
  }
}
