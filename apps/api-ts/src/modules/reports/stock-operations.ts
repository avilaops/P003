import type { AuthorizedContext } from "../../platform/access.js"
import type { ReportRow } from "./stock-metrics.js"

// A timestamp belongs to the local business day, including when UTC has already
// crossed midnight. Keep the timestamp column bare to allow a date range scan.
const openingPeriod = (column: string) => `
  ${column} >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
  AND ${column} < (($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`

const queries = {
  stock_movement_activity: {
    sql: `SELECT i.effective_on::text AS date, coalesce(w.name,'Sem depósito registrado') AS warehouse,
        m.warehouse_id, p.unit,
        (coalesce(sum(m.quantity_micros) FILTER (WHERE m.direction='receipt'),0)*0.000001)::text AS receipts,
        (coalesce(sum(m.quantity_micros) FILTER (WHERE m.direction='issue'),0)*0.000001)::text AS issues,
        (count(*) FILTER (WHERE m.direction='receipt'))::float8 AS receipt_count,
        (count(*) FILTER (WHERE m.direction='issue'))::float8 AS issue_count, count(*)::float8 AS movements
      FROM stock_cost_inputs i
      JOIN stock_movements m ON (m.tenant_id,m.id)=(i.tenant_id,i.movement_id)
      JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.product_id)
      LEFT JOIN warehouses w ON (w.tenant_id,w.id)=(m.tenant_id,m.warehouse_id)
      WHERE i.tenant_id=$1 AND i.effective_on BETWEEN $2::date AND $3::date
        AND ($4::uuid IS NULL OR i.product_id=$4) AND ($5::uuid IS NULL OR m.warehouse_id=$5)
        AND ($6::text IS NULL OR m.direction=$6)
      GROUP BY i.effective_on,m.warehouse_id,w.name,p.unit`,
    order: "date,warehouse,warehouse_id,unit",
  },
  stock_count_progress: {
    sql: `SELECT (c.created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS date,
        c.created_at,c.id,c.reference,coalesce(w.name,'Consolidado') AS warehouse,c.status,
        count(l.product_id)::float8 AS lines, count(l.counted_quantity_micros)::float8 AS counted_lines,
        (count(l.product_id)-count(l.counted_quantity_micros))::float8 AS pending_lines,
        round(count(l.counted_quantity_micros)*100.0/nullif(count(l.product_id),0),2)::text AS progress
      FROM inventory_counts c
      LEFT JOIN inventory_count_lines l ON (l.tenant_id,l.count_id)=(c.tenant_id,c.id)
      LEFT JOIN warehouses w ON (w.tenant_id,w.id)=(c.tenant_id,c.warehouse_id)
      WHERE c.tenant_id=$1 AND ${openingPeriod("c.created_at")}
        AND ($4::uuid IS NULL OR l.product_id=$4) AND ($5::uuid IS NULL OR c.warehouse_id=$5)
        AND ($6::text IS NULL OR c.status=$6)
      GROUP BY c.id,w.name`,
    order: "created_at DESC,id",
  },
  stock_production_progress: {
    sql: `SELECT s.name AS stage,s.position,s.id AS stage_id,o.status,
        o.product_id,o.sku,o.name AS product,o.unit,
        count(*)::float8 AS orders,(sum(o.quantity_micros)*0.000001)::text AS quantity
      FROM production_orders o
      JOIN production_stages s ON (s.tenant_id,s.id)=(o.tenant_id,o.stage_id)
      WHERE o.tenant_id=$1 AND ${openingPeriod("o.created_at")}
        AND ($4::uuid IS NULL OR o.product_id=$4) AND ($5::uuid IS NULL OR o.warehouse_id=$5)
        AND ($6::text IS NULL OR o.status=$6)
      GROUP BY s.id,o.status,o.product_id,o.sku,o.name,o.unit`,
    order: "position,stage,stage_id,status,sku,product_id,product,unit",
  },
}

type OperationalDataset = keyof typeof queries
export function operationalDataset(key: string): key is OperationalDataset {
  return Object.hasOwn(queries,key)
}

type Filters = {
  start: string
  end: string
  productId?: string | undefined
  warehouseId?: string | undefined
  movementDirection?: string | undefined
  countStatus?: string | undefined
  productionStatus?: string | undefined
}
export async function operationalReport(
  {client,tenantId}: AuthorizedContext, dataset: OperationalDataset, filters: Filters,
  page?: {limit: number; offset: number},
) {
  const {sql,order} = queries[dataset]
  const {start,end,productId,warehouseId,movementDirection,countStatus,productionStatus} = filters
  const args = [tenantId,start,end,productId,warehouseId,movementDirection ?? countStatus ?? productionStatus]
  if (!page) {
    const {rows} = await client.query<ReportRow>(`${sql} ORDER BY ${order}`,args)
    return {rows,total:rows.length}
  }
  const {rows} = await client.query<ReportRow & {total_rows: number}>(`
    SELECT summary.*,count(*) OVER()::float8 AS total_rows FROM (${sql}) summary
    ORDER BY ${order} LIMIT $7 OFFSET $8`,[...args,page.limit,page.offset])
  if (rows.length || !page.offset) return {rows,total:rows[0]?.total_rows ?? 0}
  const count = await client.query<{total: number}>(`SELECT count(*)::float8 AS total FROM (${sql}) summary`,args)
  return {rows,total:count.rows[0]!.total}
}
