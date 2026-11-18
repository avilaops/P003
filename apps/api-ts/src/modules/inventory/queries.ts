import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { parseListQuery, queryInteger } from "../registrations/query.js"
import { decimal, validateDate } from "../sales/fixed.js"
import { databaseId } from "../../platform/database-id.js"
import { z } from "zod"

const historyQuery = z.strictObject({
  productId: databaseId,
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  offset: queryInteger(0, 100_000).default(0),
  limit: queryInteger(1, 100).default(25),
})

const amount = (value: unknown) => decimal(BigInt(String(value)), 6)
export const notFound = () => new Problem(404, "not_found", "Registro não encontrado nesta empresa")

export async function balances(context: AuthorizedContext, query: unknown) {
  const { q, status, category_id, offset, limit } = parseListQuery(query)
  const result = await context.client.query(`
    WITH matches AS (
      SELECT id, tenant_id, sku, name, unit, status FROM products
      WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2)
        AND ($6::uuid IS NULL OR category_id=$6)
        AND (strpos(lower(name),lower($3))>0 OR strpos(lower(sku),lower($3))>0)
    ), page AS (SELECT * FROM matches ORDER BY name,id LIMIT $4 OFFSET $5)
    SELECT totals.total, p.id, p.sku, p.name, p.unit, p.status, coalesce(b.quantity_micros,0) AS quantity,
      (SELECT coalesce(sum(l.quantity_micros),0) FROM sales_order_lines l
       JOIN sales_orders o ON o.tenant_id=l.tenant_id AND o.id=l.order_id
       WHERE l.tenant_id=p.tenant_id AND l.product_id=p.id AND o.status='confirmed') AS reserved
    FROM (SELECT count(*) AS total FROM matches) totals LEFT JOIN page p ON true
    LEFT JOIN stock_balances b ON b.tenant_id=p.tenant_id AND b.product_id=p.id ORDER BY p.name,p.id
  `, [context.tenantId, status, q, limit, offset, category_id])
  const data = result.rows.filter(row => row.id).map(row => {
    const quantity = BigInt(String(row.quantity)), reserved = BigInt(String(row.reserved))
    if (reserved > quantity) throw new Problem(500, "internal_error", "Reserva superior ao saldo físico")
    return { productId: row.id, name: row.name, sku: row.sku, unit: row.unit, status: row.status,
      quantity: amount(quantity), reserved: amount(reserved), available: amount(quantity - reserved) }
  })
  return { tenantId: context.tenantId, canEdit: context.permissions.includes("inventory.stock.manage"),
    data, total: Number(result.rows[0]!.total), offset, limit }
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
export function movement(row: Record<string, unknown>) {
  return { id: row.id, productId: row.product_id, direction: row.direction, quantity: amount(row.quantity_micros),
    balanceAfter: amount(row.balance_after_micros), reason: row.reason, reversesId: row.reverses_id,
    sourceOrderId: row.source_order_id, sourcePurchaseReceiptId: row.source_purchase_receipt_id,
    productionOrderId: row.production_order_id, sourcePosSaleId: row.source_pos_sale_id,
    sourceWarrantyCaseId: row.case_id ?? null, sourceInventoryCountId: row.inventory_count_id ?? null,
    returnSourceId: row.return_source_id ?? null, occurredAt: (row.occurred_at instanceof Date ? row.occurred_at : new Date(String(row.occurred_at))).toISOString(),
    canReverse: !row.reverses_id && !row.reversed && !row.source_order_id && !row.source_purchase_receipt_id &&
      !row.production_order_id && !row.source_pos_sale_id && !row.case_id && !row.inventory_count_id && !row.return_source_id }
}

export async function history(context: AuthorizedContext, query: unknown) {
  const parsed = historyQuery.safeParse(query)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Filtros de movimentos inválidos")
  const { productId, startDate, endDate, offset, limit } = parsed.data
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
        coalesce(sum(quantity_micros) FILTER (WHERE direction='receipt' AND created_at < until),0) AS receipts,
        coalesce(sum(quantity_micros) FILTER (WHERE direction='issue' AND created_at < until),0) AS issues,
        coalesce(sum(CASE direction WHEN 'receipt' THEN quantity_micros ELSE -quantity_micros END)
          FILTER (WHERE created_at >= until),0) AS later
      FROM stock_movements CROSS JOIN bounds
      WHERE tenant_id=$1 AND product_id=$2 AND created_at >= since
    ), page AS (
      SELECT m.* FROM stock_movements m CROSS JOIN bounds
      WHERE tenant_id=$1 AND product_id=$2 AND created_at >= since AND created_at < until
      ORDER BY created_at DESC,id DESC LIMIT $5 OFFSET $6
    )
    SELECT p.id AS selected_id,p.name,p.sku,p.unit,p.status,totals.*,
      coalesce(b.quantity_micros,0)-totals.later AS closing,
      m.*,m.created_at AS occurred_at,w.case_id,origin.inventory_count_id,origin.return_source_id,
      EXISTS (SELECT 1 FROM stock_movements r WHERE r.tenant_id=m.tenant_id AND r.reverses_id=m.id) AS reversed
    FROM products p CROSS JOIN totals
    LEFT JOIN stock_balances b ON b.tenant_id=p.tenant_id AND b.product_id=p.id
    LEFT JOIN page m ON true
    ${movementOriginJoins}
    WHERE p.tenant_id=$1 AND p.id=$2 ORDER BY m.created_at DESC,m.id DESC
  `, [context.tenantId, productId, startDate, endDate, limit, offset])
  const row = result.rows[0]
  if (!row) throw notFound()
  const closing = BigInt(String(row.closing)), receipts = BigInt(String(row.receipts)), issues = BigInt(String(row.issues))
  const opening = closing - receipts + issues
  if (opening < 0n || closing < 0n) throw new Problem(500, "internal_error", "Saldo histórico inconsistente")
  return { tenantId: context.tenantId, canEdit: context.permissions.includes("inventory.stock.manage"),
    product: { productId: row.selected_id, name: row.name, sku: row.sku, unit: row.unit, status: row.status },
    summary: { opening: amount(opening), receipts: amount(receipts), issues: amount(issues), closing: amount(closing) },
    data: result.rows.filter(item => item.id).map(movement), total: Number(row.total), offset, limit }
}
