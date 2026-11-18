import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { reverseOrderInvoices } from "../finance-management/accrual.js"
import { decimal, validateDate } from "../sales/fixed.js"
import { conflict } from "./acceptance.js"
import { cancelProduction, commissionReconciliation, fiscalCancellation, requestContractWithdrawals, requireCancellationPermissions } from "./cancellation.js"
import { heldQuantity } from "./fulfillment.js"
import type { CommandHeaders } from "./receivables.js"
import { cancelCompletedReceivables } from "./return-payments.js"

const scope = "sales.order.cancelled_completed"
const inputSchema = z.strictObject({ reason: z.string(), occurredOn: z.string() })
function orderId(raw: string) {
  if (!z.guid().safeParse(raw).success) throw new Problem(422, "invalid_input", "Identificador de pedido inválido")
  return raw.toLowerCase()
}

async function reverseShippedGoods(context: AuthorizedContext, headers: CommandHeaders, order: string, reason: string) {
  const { client, tenantId } = context
  const originals = await client.query<{id: string; product_id: string; quantity_micros: string}>(`SELECT m.id,m.product_id,m.quantity_micros FROM stock_movements m
    WHERE m.tenant_id=$1 AND m.source_order_id=$2 AND m.direction='issue' AND m.reverses_id IS NULL AND NOT EXISTS
      (SELECT 1 FROM stock_movements r WHERE r.tenant_id=m.tenant_id AND r.reverses_id=m.id) ORDER BY m.product_id,m.id`, [tenantId, order])
  const expected = await client.query("SELECT product_id,quantity_micros FROM sales_order_lines WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_id", [tenantId, order])
  if (!originals.rows.length || originals.rows.length !== expected.rows.length || originals.rows.some((m, i) =>
    m.product_id !== expected.rows[i]!.product_id || m.quantity_micros !== expected.rows[i]!.quantity_micros)) {
    conflict("Movimentos originais não conciliam com os itens. Confira o histórico antes de devolver")
  }
  const result: string[] = []
  for (const movement of originals.rows) {
    const quantity = BigInt(movement.quantity_micros)
    const balance = (await client.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE", [tenantId, movement.product_id])).rows[0]
    if (!balance) conflict("Saldo físico da entrega não encontrado")
    const next = BigInt(String(balance.quantity_micros)) + quantity
    if (next > 999999999999999999n || next < await heldQuantity(context, movement.product_id)) conflict("Saldo físico incompatível com o estorno da entrega")
    const id = randomUUID()
    await client.query("UPDATE stock_balances SET quantity_micros=$3 WHERE tenant_id=$1 AND product_id=$2", [tenantId, movement.product_id, next])
    await client.query(`INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,reverses_id)
      VALUES($1,$2,$3,'receipt',$4,$5,$6,$7)`, [id, tenantId, movement.product_id, quantity, next, reason, movement.id])
    await record(context, headers, "stock_movement", id, "stock.moved", { sourceId: order, productId: movement.product_id,
      direction: "receipt", quantity: decimal(quantity, 6), balanceAfter: decimal(next, 6), reversesId: movement.id, reason })
    result.push(id)
  }
  return result
}

export function registerCompletedOrderCancellation(app: FastifyInstance, dependencies: AppDependencies) {
  app.get<{ Params: { id: string } }>("/api/v1/orders/:id/cancellations", async (request, reply) => {
    const result = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read")
      const id = orderId(request.params.id)
      const { client, tenantId } = context
      if (!(await client.query("SELECT 1 FROM sales_orders WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows.length) throw new Problem(404, "not_found", "Pedido não encontrado")
      const rows = await client.query("SELECT summary FROM sales_order_cancellations WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at,id", [tenantId, id])
      return { tenantId, data: rows.rows.map(row => row.summary) }
    })
    return reply.header("cache-control", "no-store").send(result)
  })

  app.post<{ Params: { id: string } }>("/api/v1/orders/:id/cancel-completed", async (request, reply) => {
    const key = commandKey(request.headers["idempotency-key"]), expected = parseRevision(request.headers["if-match"])
    const id = orderId(request.params.id)
    const result = await authorizeRequest(request, dependencies, async context => {
      for (const permission of ["sales.orders.read", "sales.orders.manage", "inventory.stock.manage", "finance.receivables.manage"]) requirePermission(context, permission)
      const { client, tenantId } = context
      const parsed = inputSchema.safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Informe motivo e data do cancelamento")
      const input = parsed.data, reason = input.reason.trim(), occurredOn = validateDate(input.occurredOn)
      if ([...reason].length < 15 || [...reason].length > 200 || /\p{Cc}/u.test(input.reason)) throw new Problem(422, "invalid_input", "Motivo exige de 15 a 200 caracteres sem controles")
      if ((await client.query("SELECT 1 FROM order_commission_terms WHERE tenant_id=$1 AND order_id=$2 UNION ALL SELECT 1 FROM commission_entries WHERE tenant_id=$1 AND order_id=$2 LIMIT 1", [tenantId, id])).rows.length) {
        requirePermission(context, "finance.commissions.read")
        requirePermission(context, "finance.commissions.manage")
      }
      await requireCancellationPermissions(context, id)
      const bodySha256 = createHash("sha256").update(JSON.stringify({ reason: input.reason, occurredOn })).digest("hex")
      const fingerprint = { id, revision: expected, bodySha256, input }
      const previous = await replay(context, key, scope, fingerprint)
      if (previous) return previous
      const order = (await client.query("SELECT status,revision FROM sales_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, id])).rows[0]
      if (!order) throw new Problem(404, "not_found", "Pedido não encontrado")
      if (revisionValue(order.revision) !== expected) throw new Problem(412, "revision_conflict", "A revisão do pedido mudou")
      if (order.status !== "completed") conflict("Cancelamento integral exige venda concluída")
      // Fiscal lots and item returns from the sales workspace must be reconciled before reversing the whole sale.
      const lots = await client.query(`SELECT 1 FROM sales_invoice_lots l LEFT JOIN fiscal_nfe_documents d ON d.tenant_id=l.tenant_id AND d.id=l.draft_id
        WHERE l.tenant_id=$1 AND l.order_id=$2 AND l.environment='production' AND (NOT l.legacy_full OR EXISTS(SELECT 1 FROM sales_partial_returns r WHERE r.tenant_id=l.tenant_id AND r.lot_id=l.id))
        AND (l.delivered_at IS NOT NULL OR NOT l.withdrawn AND coalesce(d.status,'draft') NOT IN ('rejected','cancelled')) LIMIT 1`, [tenantId, id])
      if (lots.rows.length) conflict("Concilie os lotes fiscais e as devoluções por item antes de cancelar integralmente")
      const fiscal = await fiscalCancellation(context, id)
      await client.query("SELECT set_config('app.stock_effective_on',$1,true)", [occurredOn])
      const stockMovementIds = await reverseShippedGoods(context, request.headers, id, reason)
      const titles = await cancelCompletedReceivables(context, request.headers, id, reason, occurredOn)
      const cancellationId = randomUUID(), revision = nextRevision(expected)
      await reverseOrderInvoices(context, request.headers, id, cancellationId, occurredOn, reason)
      const commission = await commissionReconciliation(context, id)
      const production = await cancelProduction(context, request.headers, id, cancellationId, reason)
      const summary = { id: cancellationId, kind: "sale_cancellation", sourceId: id, orderId: id, cancellationId, revision, reason, occurredOn,
        ...titles, stockMovementIds, fiscalCancellation: fiscal, reconciliation: { commission, production } }
      await client.query(`INSERT INTO sales_order_cancellations(id,tenant_id,order_id,reason,occurred_on,order_revision,summary)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [cancellationId, tenantId, id, reason, occurredOn, revision, summary])
      await client.query("UPDATE sales_orders SET status='cancelled',revision=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, id, revision])
      await requestContractWithdrawals(context, request.headers, id, cancellationId, reason)
      await record(context, request.headers, "sales_order", id, "sales.order.reconciliation_requested", { orderId: id, cancellationId, commission, production })
      await record(context, request.headers, "sales_order", id, scope, summary)
      const body = { tenantId, data: summary }
      await remember(context, key, scope, fingerprint, body)
      return body
    })
    return reply.header("cache-control", "no-store").header("etag", `"${(result.data as Record<string, unknown>).revision}"`).send(result)
  })
}
