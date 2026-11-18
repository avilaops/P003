import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { listQuerySchema, queryInteger } from "../registrations/query.js"
import { decimal, validateDate } from "../sales/fixed.js"
import { databaseId } from "../../platform/database-id.js"
import { z } from "zod"
import { activeStockLocations } from "./locations.js"
import { moneyFromMicros, productValue, projectedCosts, unitFromMicros } from "./valuation.js"

const historyQuery = z.strictObject({
  productId: databaseId,
  warehouseId: databaseId.optional(),
  direction: z.enum(["receipt","issue"]).optional(),
  orderOffset: queryInteger(0,100_000).default(0),
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

const balanceQuery = listQuerySchema.extend({ warehouseId: databaseId.optional(), inStock: z.literal("1").optional() })
export async function balances(context: AuthorizedContext, query: unknown) {
  const parsed = balanceQuery.safeParse(query)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Filtros de saldo inválidos")
  const { q, status, category_id, offset, limit, warehouseId } = parsed.data
  await verifyLocation(context, warehouseId)
  const result = await context.client.query(`
    WITH matches AS (
      SELECT p.id,p.tenant_id,p.sku,p.name,p.unit,p.status,coalesce(CASE WHEN $7::uuid IS NULL THEN b.quantity_micros ELSE local.quantity_micros END,0) AS quantity
      FROM products p LEFT JOIN stock_balances b ON (b.tenant_id,b.product_id)=(p.tenant_id,p.id)
      LEFT JOIN stock_positions local ON (local.tenant_id,local.product_id,local.warehouse_id)=(p.tenant_id,p.id,$7)
      WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.status=$2)
        AND ($6::uuid IS NULL OR p.category_id=$6)
        AND (strpos(lower(p.name),lower($3))>0 OR strpos(lower(p.sku),lower($3))>0)
        AND (NOT $8::boolean OR (CASE WHEN $7 IS NULL THEN b.quantity_micros ELSE local.quantity_micros END)>0)
    ), page AS (SELECT * FROM matches ORDER BY name,id LIMIT $4 OFFSET $5)
    SELECT totals.total, p.id, p.sku, p.name, p.unit, p.status,
      EXISTS(SELECT 1 FROM stock_serial_products s WHERE (s.tenant_id,s.product_id)=(p.tenant_id,p.id)) AS tracked,
      p.quantity,
      (SELECT coalesce(sum(l.quantity_micros),0) FROM sales_order_lines l
       JOIN sales_orders o ON o.tenant_id=l.tenant_id AND o.id=l.order_id
       WHERE l.tenant_id=p.tenant_id AND l.product_id=p.id AND o.status='confirmed'
         AND ($7::uuid IS NULL OR coalesce(l.warehouse_id,c.opening_id)=$7)) +
      (SELECT coalesce(sum(r.quantity_micros),0) FROM production_component_reservations r WHERE r.tenant_id=p.tenant_id
        AND r.product_id=p.id AND ($7::uuid IS NULL OR r.warehouse_id=$7)) AS reserved
    FROM (SELECT count(*) AS total FROM matches) totals LEFT JOIN page p ON true
    LEFT JOIN stock_location_settings c ON c.tenant_id=p.tenant_id ORDER BY p.name,p.id
  `, [context.tenantId, status, q, limit, offset, category_id, warehouseId, parsed.data.inStock==="1"])
  const pageRows = result.rows.filter(row => row.id)
  const { positions } = await projectedCosts(context,pageRows.map(row=>String(row.id)))
  const data = pageRows.map(row => {
    const quantity = BigInt(String(row.quantity)), reserved = BigInt(String(row.reserved))
    if (reserved > quantity) throw new Problem(500, "internal_error", "Reserva superior ao saldo físico")
    const valued = productValue(positions.values(),String(row.id),warehouseId)
    return { productId: row.id, name: row.name, sku: row.sku, unit: row.unit, status: row.status, ...(row.tracked ? {tracksSerials:true}:{}),
      stockValue:moneyFromMicros(valued.value),averageCost:unitFromMicros(valued.unit),
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
  const { productId, startDate, endDate, offset, limit, warehouseId, direction, orderOffset } = parsed.data
  await verifyLocation(context, warehouseId)
  if (startDate !== undefined) validateDate(startDate)
  if (endDate !== undefined) validateDate(endDate)
  if (startDate && endDate && endDate < startDate) throw new Problem(422, "invalid_input", "Período inválido")
  // One statement keeps the page, total and closing position on the same PG snapshot.
  // Subtract later movements from the current position to include pre-ledger opening stock.
  const result = await context.client.query(`
    WITH bounds AS (
      SELECT coalesce($3::date,'-infinity'::date) AS since,coalesce($4::date+1,'infinity'::date) AS until
    ), ledger AS (
      SELECT m.*,i.effective_on AS cost_date FROM stock_movements m JOIN stock_cost_inputs i
        ON (i.tenant_id,i.movement_id)=(m.tenant_id,m.id) WHERE m.tenant_id=$1 AND m.product_id=$2
    ), totals AS (
      SELECT count(*) FILTER (WHERE cost_date < until AND ($8::text IS NULL OR direction=$8)) AS total,
        coalesce(sum(quantity_micros) FILTER (WHERE direction='receipt' AND cost_date < until AND ($7::uuid IS NOT NULL OR transfer_id IS NULL)),0) AS receipts,
        coalesce(sum(quantity_micros) FILTER (WHERE direction='issue' AND cost_date < until AND ($7::uuid IS NOT NULL OR transfer_id IS NULL)),0) AS issues,
        coalesce(sum(CASE direction WHEN 'receipt' THEN quantity_micros ELSE -quantity_micros END)
          FILTER (WHERE cost_date >= until),0) AS later
      FROM ledger CROSS JOIN bounds
      WHERE cost_date >= since AND ($7::uuid IS NULL OR warehouse_id=$7)
    ), page AS (
      SELECT m.*, ${occurredAtSql} AS occurred_at FROM ledger m CROSS JOIN bounds
      WHERE cost_date >= since AND cost_date < until AND ($7::uuid IS NULL OR warehouse_id=$7)
        AND ($8::text IS NULL OR direction=$8)
      ORDER BY cost_date DESC,created_at DESC,id DESC LIMIT $5 OFFSET $6
    )
    SELECT p.id AS selected_id,p.name,p.sku,p.unit,p.status,totals.*,
      EXISTS(SELECT 1 FROM stock_serial_products s WHERE (s.tenant_id,s.product_id)=(p.tenant_id,p.id)) AS tracked,
      coalesce(CASE WHEN $7::uuid IS NULL THEN b.quantity_micros ELSE local.quantity_micros END,0)-totals.later AS closing,
      m.*,w.case_id,coalesce(m.inventory_count_id::text,origin.inventory_count_id) AS inventory_count_id,origin.return_source_id,
      EXISTS (SELECT 1 FROM stock_movements r WHERE r.tenant_id=m.tenant_id AND r.reverses_id=m.id) AS reversed
    FROM products p CROSS JOIN totals
    LEFT JOIN stock_balances b ON b.tenant_id=p.tenant_id AND b.product_id=p.id
    LEFT JOIN stock_positions local ON local.tenant_id=p.tenant_id AND local.product_id=p.id AND local.warehouse_id=$7
    LEFT JOIN page m ON true
    ${movementOriginJoins}
    WHERE p.tenant_id=$1 AND p.id=$2 ORDER BY m.cost_date DESC,m.created_at DESC,m.id DESC
  `, [context.tenantId, productId, startDate, endDate, limit, offset, warehouseId, direction])
  const row = result.rows[0]
  if (!row) throw notFound()
  const closing = BigInt(String(row.closing)), receipts = BigInt(String(row.receipts)), issues = BigInt(String(row.issues))
  const opening = closing - receipts + issues
  if (opening < 0n || closing < 0n) throw new Problem(500, "internal_error", "Saldo histórico inconsistente")
  const orders = await context.client.query(`
    WITH demand AS (
      SELECT o.id,o.number,o.status,l.quantity_micros FROM sales_order_lines l
      JOIN sales_orders o ON (o.tenant_id,o.id)=(l.tenant_id,l.order_id)
      LEFT JOIN stock_location_settings s ON s.tenant_id=l.tenant_id
      WHERE l.tenant_id=$1 AND l.product_id=$2 AND o.status IN ('accepted','confirmed')
        AND ($3::uuid IS NULL OR coalesce(l.warehouse_id,CASE WHEN o.status='accepted' THEN s.sales_id ELSE s.opening_id END)=$3)
      UNION ALL SELECT r.production_order_id,sale.number,'production',r.quantity_micros FROM production_component_reservations r
      JOIN production_orders job ON (job.tenant_id,job.id)=(r.tenant_id,r.production_order_id)
      JOIN sales_orders sale ON (sale.tenant_id,sale.id)=(job.tenant_id,job.order_id)
      WHERE r.tenant_id=$1 AND r.product_id=$2 AND ($3::uuid IS NULL OR r.warehouse_id=$3) AND r.quantity_micros>0
    ), page AS (SELECT * FROM demand WHERE CASE WHEN status='production' THEN $6::boolean ELSE $4::boolean END ORDER BY number,id LIMIT 25 OFFSET $5)
    SELECT totals.*,p.id,p.number,p.status,p.quantity_micros FROM
      (SELECT count(*) FILTER(WHERE CASE WHEN status='production' THEN $6 ELSE $4 END) AS total,
        coalesce(sum(quantity_micros) FILTER (WHERE status IN ('confirmed','production')),0) AS reserved FROM demand) totals
    LEFT JOIN page p ON true ORDER BY p.number,p.id`,
    [context.tenantId,productId,warehouseId,context.permissions.includes("sales.orders.read"),orderOffset,context.permissions.includes("production.read")])
  const {movements:costs}=await projectedCosts(context,[productId],endDate)
  return { tenantId: context.tenantId, canEdit: context.permissions.includes("inventory.stock.manage"),
    product: { productId: row.selected_id, name: row.name, sku: row.sku, unit: row.unit, status: row.status, ...(row.tracked?{tracksSerials:true}:{}) },
    warehouses: await activeStockLocations(context),
    openOrders: {reserved:amount(orders.rows[0]!.reserved),offset:orderOffset,total:Number(orders.rows[0]!.total),
      data: orders.rows.filter(order=>order.id).map(order=>({id:order.id,number:String(order.number),status:order.status,quantity:amount(order.quantity_micros)}))},
    summary: { opening: amount(opening), receipts: amount(receipts), issues: amount(issues), closing: amount(closing) },
    data: result.rows.filter(item => item.id).map(item=>{
      const result=movement(item), cost=costs.get(String(item.id))
      return {...result,effectiveDate:cost?.date,movementValue:moneyFromMicros(cost?.amount??null),unitCost:unitFromMicros(cost?.unit??null),
        balanceAfter:cost ? amount(cost.totalAfter) : result.balanceAfter,
        localBalanceAfter:cost && result.warehouseId ? amount(cost.quantityAfter) : result.localBalanceAfter}
    }), total: Number(row.total), offset, limit }
}
