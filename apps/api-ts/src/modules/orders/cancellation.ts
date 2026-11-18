import { randomUUID } from "node:crypto"
import { requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { nextRevision, revisionValue, type Revision } from "../../platform/revision.js"
import { decimal } from "../sales/fixed.js"
import { conflict } from "./acceptance.js"
import type { CommandHeaders } from "./receivables.js"

function inventoryPermission(context: AuthorizedContext) {
  requirePermission(context, "inventory.stock.read"); requirePermission(context, "inventory.stock.manage")
}
export async function requireCancellationPermissions(context: AuthorizedContext, order: string) {
  const exists = await context.client.query("SELECT EXISTS(SELECT 1 FROM production_orders WHERE tenant_id=$1 AND order_id=$2) AS present", [context.tenantId, order])
  if (!exists.rows[0]?.present) return
  requirePermission(context, "production.read"); requirePermission(context, "production.manage")
  const consumed = await context.client.query("SELECT EXISTS(SELECT 1 FROM production_consumptions c JOIN production_orders o ON o.tenant_id=c.tenant_id AND o.id=c.production_order_id WHERE o.tenant_id=$1 AND o.order_id=$2) AS present", [context.tenantId, order])
  if (consumed.rows[0]?.present) inventoryPermission(context)
}

async function cancelProduction(context: AuthorizedContext, headers: CommandHeaders, order: string, cancellation: string, reason: string) {
  await requireCancellationPermissions(context, order)
  const { client, tenantId } = context, ids: string[] = [], movements: string[] = []
  const jobs = await client.query("SELECT id,status,revision FROM production_orders WHERE tenant_id=$1 AND order_id=$2 ORDER BY id FOR UPDATE", [tenantId, order])
  for (const job of jobs.rows) {
    if (job.status === "cancelled") continue
    const active = await client.query("SELECT m.id,m.product_id,m.quantity_micros FROM stock_movements m JOIN production_consumptions c ON c.tenant_id=m.tenant_id AND c.stock_movement_id=m.id WHERE m.tenant_id=$1 AND m.production_order_id=$2 AND m.direction='issue' AND m.reverses_id IS NULL AND NOT EXISTS(SELECT 1 FROM stock_movements r WHERE r.tenant_id=m.tenant_id AND r.reverses_id=m.id) ORDER BY m.product_id,m.id", [tenantId, job.id])
    if (active.rows.length) inventoryPermission(context)
    for (const row of active.rows) {
      const balance = (await client.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE", [tenantId, row.product_id])).rows[0]
      const quantity = BigInt(String(row.quantity_micros)), next = BigInt(String(balance?.quantity_micros)) + quantity, id = randomUUID()
      if (next > 999999999999999999n) conflict("Estorno excede limite de estoque")
      await client.query("UPDATE stock_balances SET quantity_micros=$3 WHERE tenant_id=$1 AND product_id=$2", [tenantId, row.product_id, next])
      await client.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,reverses_id,production_order_id) VALUES($1,$2,$3,'receipt',$4,$5,$6,$7,$8)", [id, tenantId, row.product_id, quantity, next, reason, row.id, job.id])
      await record(context, headers, "stock_movement", id, "stock.moved", { productionOrderId: job.id, productId: row.product_id, direction: "receipt", quantity: decimal(quantity, 6), balanceAfter: decimal(next, 6), reversesId: row.id, reason })
      movements.push(id)
    }
    const next = nextRevision(revisionValue(job.revision))
    await client.query("UPDATE production_orders SET status='cancelled',cancelled_at=clock_timestamp(),cancellation_id=$3,revision=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [tenantId, job.id, cancellation, next])
    const details = { orderId: order, cancellationId: cancellation, reason, previousStatus: job.status, revision: next }
    await client.query("INSERT INTO production_history(id,tenant_id,production_order_id,action,stage_id,stage_name,actor_subject,details) SELECT $1,$2,o.id,'production.cancelled',s.id,s.name,$4,$5 FROM production_orders o JOIN production_stages s ON s.tenant_id=o.tenant_id AND s.id=o.stage_id WHERE o.tenant_id=$2 AND o.id=$3", [randomUUID(), tenantId, job.id, context.authSubject, details])
    await record(context, headers, "production_order", String(job.id), "production.cancelled", details)
    ids.push(String(job.id))
  }
  return { status: ids.length ? "applied" : "not_required", applied: ids.length > 0, cancelledCount: ids.length, orderIds: ids, stockMovementIds: movements }
}

export async function reconcileCancellation(context: AuthorizedContext, headers: CommandHeaders, order: string, next: Revision, completed?: {
  reason:string; occurred:string; receivableIds:string[]; paymentReversalIds:string[]; stockMovementIds:string[]
}) {
  const { client, tenantId } = context
  const pending = await client.query("SELECT EXISTS(SELECT 1 FROM fiscal_nfe_documents WHERE tenant_id=$1 AND source_order_id=$2 AND (status IN ('preparing','prepared','unknown') OR lease_until>clock_timestamp())) AS present", [tenantId, order])
  if (pending.rows[0]?.present) conflict("Concilie a emissão fiscal em andamento antes de cancelar a venda")
  const required = Boolean((await client.query("SELECT EXISTS(SELECT 1 FROM fiscal_nfe_documents WHERE tenant_id=$1 AND source_order_id=$2 AND status='authorized') AS present", [tenantId, order])).rows[0]?.present)
  const id = randomUUID(), reason = completed?.reason ?? "Cancelamento do pedido antes da expedição", occurred = completed?.occurred ?? new Date().toISOString().slice(0, 10)
  const production = await cancelProduction(context, headers, order, id, reason)
  const commissions = (await client.query("SELECT count(*) AS count,count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM commission_entries reversed WHERE reversed.tenant_id=e.tenant_id AND reversed.reverses_entry_id=e.id)) AS unreversed FROM commission_entries e WHERE e.tenant_id=$1 AND e.order_id=$2 AND e.kind='receipt'", [tenantId, order])).rows[0]!
  if (BigInt(String(commissions.unreversed)) > 0n) conflict("Há comissões de recebimentos sem estorno; concilie antes de cancelar")
  const count = revisionValue(commissions.count), applied = BigInt(count) > 0n
  const commission = { status: applied ? "applied" : "not_required", applied, reversedEntries: count, paymentsPreserved: true }
  const summary = { id, kind: "sale_cancellation", sourceId: order, orderId: order, cancellationId: id, revision: next, reason, occurredOn: occurred, receivableId: completed?.receivableIds.length===1 ? completed.receivableIds[0] : null, stockMovementIds: completed?.stockMovementIds ?? [], paymentReversalIds: completed?.paymentReversalIds ?? [],
    ...(completed ? {receivableIds:completed.receivableIds} : {beforeShipment:true}), fiscalCancellation: { requested: required, status: required ? "pending" : "not_required" }, reconciliation: { commission, production } }
  await client.query("INSERT INTO sales_order_cancellations(id,tenant_id,order_id,reason,occurred_on,order_revision,summary) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, tenantId, order, reason, occurred, next, summary])
  const contracts = await client.query("SELECT id,status FROM commercial_contracts WHERE tenant_id=$1 AND order_id=$2 ORDER BY id", [tenantId, order])
  for (const contract of contracts.rows) {
    if (!["completed", "declined", "expired"].includes(String(contract.status))) await record(context, headers, "commercial_contract", String(contract.id), "contract.withdrawal_requested", { orderId: order, cancellationId: id, reason, status: "pending", filesPreserved: true })
  }
  await record(context, headers, "sales_order", order, "sales.order.reconciliation_requested", summary)
  return summary
}
