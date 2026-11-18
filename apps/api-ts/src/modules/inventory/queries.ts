import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { listQuerySchema, queryInteger } from "../registrations/query.js"
import { decimal, validateDate } from "../sales/fixed.js"
import { databaseId } from "../../platform/database-id.js"
import { z } from "zod"
import { activeStockLocations } from "./locations.js"

const historyQuery = z.strictObject({
  productId: databaseId,
  warehouseId: databaseId.optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  offset: queryInteger(0, 100_000).default(0),
  limit: queryInteger(1, 100).default(25),
})

const amount = (value: unknown) => decimal(BigInt(String(value)), 6)
export const notFound = () => new Problem(404, "not_found", "Registro não encontrado nesta empresa")

async function verifyLocation(context: AuthorizedContext, id?: string) {
  if (!id) return
  const result = await context.client.query(`SELECT w.id FROM warehouses w JOIN stock_location_settings c ON c.tenant_id=w.tenant_id
    WHERE w.tenant_id=$1 AND w.id=$2 AND c.enabled`, [context.tenantId,id])
  if (!result.rows.length) throw notFound()
}

const balanceQuery = listQuerySchema.extend({ warehouseId: databaseId.optional() })
export async function balances(context: AuthorizedContext, query: unknown) {
  const parsed = balanceQuery.safeParse(query)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Filtros de saldo inválidos")
  const { q, status, category_id, offset, limit, warehouseId } = parsed.data
  await verifyLocation(context, warehouseId)
  const result = await context.client.query(`
    WITH matches AS (
      SELECT id, tenant_id, sku, name, unit, status FROM products
      WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2)
        AND ($6::uuid IS NULL OR category_id=$6)
        AND (strpos(lower(name),lower($3))>0 OR strpos(lower(sku),lower($3))>0)
    ), page AS (SELECT * FROM matches ORDER BY name,id LIMIT $4 OFFSET $5)
    SELECT totals.total, p.id, p.sku, p.name, p.unit, p.status,
      coalesce(CASE WHEN $7::uuid IS NULL THEN b.quantity_micros ELSE local.quantity_micros END,0) AS quantity,
      (SELECT coalesce(sum(l.quantity_micros),0) FROM sales_order_lines l
       JOIN sales_orders o ON o.tenant_id=l.tenant_id AND o.id=l.order_id
       WHERE l.tenant_id=p.tenant_id AND l.product_id=p.id AND o.status='confirmed'
         AND ($7::uuid IS NULL OR coalesce(l.warehouse_id,c.opening_id)=$7)) AS reserved
    FROM (SELECT count(*) AS total FROM matches) totals LEFT JOIN page p ON true
    LEFT JOIN stock_balances b ON b.tenant_id=p.tenant_id AND b.product_id=p.id
    LEFT JOIN stock_location_settings c ON c.tenant_id=p.tenant_id
    LEFT JOIN stock_positions local ON local.tenant_id=p.tenant_id AND local.product_id=p.id AND local.warehouse_id=$7 ORDER BY p.name,p.id
  `, [context.tenantId, status, q, limit, offset, category_id, warehouseId])
  const data = result.rows.filter(row => row.id).map(row => {
    const quantity = BigInt(String(row.quantity)), reserved = BigInt(String(row.reserved))
    if (reserved > quantity) throw new Problem(500, "internal_error", "Reserva superior ao saldo físico")
    return { productId: row.id, name: row.name, sku: row.sku, unit: row.unit, status: row.status,
      quantity: amount(quantity), reserved: amount(reserved), available: amount(quantity - reserved) }
  })
  return { tenantId: context.tenantId, canEdit: context.permissions.includes("inventory.stock.manage"),
    warehouses: await activeStockLocations(context), data, total: Number(result.rows[0]!.total), offset, limit }
}

// Some legacy writers attach the originating document after inserting the immutable movement.
export const movementOriginJoins = `
  LEFT JOIN warranty_quarantines w ON w.tenant_id=m.tenant_id AND m.id IN (w.stock_movement_id,w.release_movement_id)
  LEFT JOIN LATERAL (
    SELECT max(details->>'inventoryCountId') AS inventory_count_id, max(details->>'sourceId') AS return_source_id
    FROM audit_log WHERE tenant_id=m.tenant_id AND entity_id=m.id::text AND entity_type='stock_movement' AND action='stock.moved'
      AND (details ? 'inventoryCountId' OR details ? 'sourceId')
  ) origin ON true
`
export const occurredAtSql = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

export function movement(row: Record<string, unknown>) {
  return { id: row.id, productId: row.product_id, direction: row.direction, quantity: amount(row.quantity_micros),
    balanceAfter: amount(row.balance_after_micros), reason: row.reason, reversesId: row.reverses_id,
    warehouseId: row.warehouse_id ?? null, localBalanceAfter: row.local_balance_after_micros == null ? null : amount(row.local_balance_after_micros),
    transferId: row.transfer_id ?? null, sourceOrderId: row.source_order_id, sourcePurchaseReceiptId: row.source_purchase_receipt_id,
    productionOrderId: row.production_order_id, sourcePosSaleId: row.source_pos_sale_id,
    sourceWarrantyCaseId: row.case_id ?? null, sourceInventoryCountId: row.inventory_count_id ?? null,
    returnSourceId: row.return_source_id ?? null, occurredAt: row.occurred_at,
    canReverse: !row.reverses_id && !row.reversed && !row.transfer_id && !row.source_order_id && !row.source_purchase_receipt_id &&
      !row.production_order_id && !row.source_pos_sale_id && !row.case_id && !row.inventory_count_id && !row.return_source_id }
}

export async function history(context: AuthorizedContext, query: unknown) {
  const parsed = historyQuery.safeParse(query)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Filtros de movimentos inválidos")
  const { productId, startDate, endDate, offset, limit, warehouseId } = parsed.data
  await verifyLocation(context, warehouseId)
  if (startDate !== undefined) validateDate(startDate)
  if (endDate !== undefined) validateDate(endDate)
  if (startDate && endDate && endDate < startDate) throw new Problem(422, "invalid_input", "Período inválido")
  // One statement keeps the page, total and closing position on the same PG snapshot.
  // Subtract later movements from the current position to include pre-ledger opening stock.
  const result = await context.client.query(`
    WITH bounds AS (
      SELECT coalesce($3::date::timestamp AT TIME ZONE 'America/Sao_Paulo','-infinity') AS since,
        coalesce(($4::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo','infinity') AS until
    ), totals AS (
      SELECT count(*) FILTER (WHERE created_at < until) AS total,
        coalesce(sum(quantity_micros) FILTER (WHERE direction='receipt' AND created_at < until AND ($7::uuid IS NOT NULL OR transfer_id IS NULL)),0) AS receipts,
        coalesce(sum(quantity_micros) FILTER (WHERE direction='issue' AND created_at < until AND ($7::uuid IS NOT NULL OR transfer_id IS NULL)),0) AS issues,
        coalesce(sum(CASE direction WHEN 'receipt' THEN quantity_micros ELSE -quantity_micros END)
          FILTER (WHERE created_at >= until),0) AS later
      FROM stock_movements CROSS JOIN bounds
      WHERE tenant_id=$1 AND product_id=$2 AND created_at >= since AND ($7::uuid IS NULL OR warehouse_id=$7)
    ), page AS (
      SELECT m.*, ${occurredAtSql} AS occurred_at FROM stock_movements m CROSS JOIN bounds
      WHERE tenant_id=$1 AND product_id=$2 AND created_at >= since AND created_at < until AND ($7::uuid IS NULL OR warehouse_id=$7)
      ORDER BY created_at DESC,id DESC LIMIT $5 OFFSET $6
    )
    SELECT p.id AS selected_id,p.name,p.sku,p.unit,p.status,totals.*,
      coalesce(CASE WHEN $7::uuid IS NULL THEN b.quantity_micros ELSE local.quantity_micros END,0)-totals.later AS closing,
      m.*,w.case_id,origin.inventory_count_id,origin.return_source_id,
      EXISTS (SELECT 1 FROM stock_movements r WHERE r.tenant_id=m.tenant_id AND r.reverses_id=m.id) AS reversed
    FROM products p CROSS JOIN totals
    LEFT JOIN stock_balances b ON b.tenant_id=p.tenant_id AND b.product_id=p.id
    LEFT JOIN stock_positions local ON local.tenant_id=p.tenant_id AND local.product_id=p.id AND local.warehouse_id=$7
    LEFT JOIN page m ON true
    ${movementOriginJoins}
    WHERE p.tenant_id=$1 AND p.id=$2 ORDER BY m.created_at DESC,m.id DESC
  `, [context.tenantId, productId, startDate, endDate, limit, offset, warehouseId])
  const row = result.rows[0]
  if (!row) throw notFound()
  const closing = BigInt(String(row.closing)), receipts = BigInt(String(row.receipts)), issues = BigInt(String(row.issues))
  const opening = closing - receipts + issues
  if (opening < 0n || closing < 0n) throw new Problem(500, "internal_error", "Saldo histórico inconsistente")
  return { tenantId: context.tenantId, canEdit: context.permissions.includes("inventory.stock.manage"),
    product: { productId: row.selected_id, name: row.name, sku: row.sku, unit: row.unit, status: row.status },
    warehouses: await activeStockLocations(context),
    summary: { opening: amount(opening), receipts: amount(receipts), issues: amount(issues), closing: amount(closing) },
    data: result.rows.filter(item => item.id).map(movement), total: Number(row.total), offset, limit }
}
