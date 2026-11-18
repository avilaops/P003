import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, revisionValue, type Revision } from "../../platform/revision.js"
import { queryInteger } from "../registrations/query.js"
import { decimal } from "../sales/fixed.js"

const listQuery = z.strictObject({ offset: queryInteger(0, 100000).default(0), limit: queryInteger(1, 100).default(25) })
const canEdit = (ctx: AuthorizedContext) => ctx.permissions.includes("inventory.counts.manage")
export const countConflict = (message: string) => new Problem(409, "domain_conflict", message)
export const missingCount = () => new Problem(404, "not_found", "Sessão ou produto ausente neste inventário")
export function checkCountRevision(count: { revision: Revision }, headers: Record<string, string | string[] | undefined>) {
  if (headers["if-match"] !== undefined && parseRevision(headers["if-match"]) !== count.revision)
    throw new Problem(412, "revision_conflict", "A sessão foi alterada por outra pessoa. Atualize a conferência")
}
const summarySql = `SELECT c.*,w.name AS warehouse_name,g.name AS category_name,
    (SELECT count(*) FROM inventory_count_lines l WHERE (l.tenant_id,l.count_id)=(c.tenant_id,c.id)) AS line_count,
    (SELECT count(l.counted_quantity_micros) FROM inventory_count_lines l WHERE (l.tenant_id,l.count_id)=(c.tenant_id,c.id)) AS counted_lines
  FROM inventory_counts c LEFT JOIN warehouses w ON (w.tenant_id,w.id)=(c.tenant_id,c.warehouse_id)
  LEFT JOIN product_categories g ON (g.tenant_id,g.id)=(c.tenant_id,c.category_id)`
type CountRow = {
  id: string
  status: string
  reference: string
  revision: string
  created_by: string
  approved_by: string | null
  created_at: Date
  approved_at: Date | null
  line_count: string
  counted_lines: string
  blind: boolean
  lock_movements: boolean
  recount_percent: string | null
  warehouse_id: string | null
  warehouse_name: string | null
  category_id: string | null
  category_name: string | null
  cancel_reason: string | null
}
function summary(row: CountRow) {
  return {
    id: row.id,
    status: row.status,
    reference: row.reference,
    revision: revisionValue(row.revision),
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    createdAt: row.created_at.toISOString(),
    approvedAt: row.approved_at?.toISOString() ?? null,
    lineCount: Number(row.line_count),
    countedLines: Number(row.counted_lines),
    blind: row.blind,
    lockMovements: row.lock_movements,
    recountPercent: row.recount_percent === null ? null : Number(row.recount_percent),
    warehouseId: row.warehouse_id,
    warehouseName: row.warehouse_name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    cancelReason: row.cancel_reason,
  }
}
export async function countSummary({ client, tenantId }: AuthorizedContext, id: string) {
  const row = (await client.query<CountRow>(summarySql + " WHERE c.tenant_id=$1 AND c.id=$2", [tenantId, id])).rows[0]
  if (!row) throw missingCount()
  return summary(row)
}
export async function listCounts(ctx: AuthorizedContext, query: unknown) {
  const params = listQuery.safeParse(query)
  if (!params.success) throw new Problem(422, "invalid_input", "Paginação inválida")
  const { offset, limit } = params.data,
    { client, tenantId } = ctx
  const data = await client.query<CountRow>(summarySql + " WHERE c.tenant_id=$1 ORDER BY c.created_at DESC,c.id DESC LIMIT $2 OFFSET $3", [
    tenantId,
    limit,
    offset,
  ])
  const total = await client.query("SELECT count(*) AS total FROM inventory_counts WHERE tenant_id=$1", [tenantId])
  const locations = await client.query<{ id: string; name: string; code: string }>(
    `SELECT w.id,w.name,w.code FROM warehouses w
    JOIN stock_location_settings s ON s.tenant_id=w.tenant_id WHERE w.tenant_id=$1 AND w.status='active' AND s.enabled ORDER BY w.name,w.code`,
    [tenantId],
  )
  const categories = canEdit(ctx)
    ? (await client.query("SELECT id,name,code FROM product_categories WHERE tenant_id=$1 AND status='active' ORDER BY name,code", [tenantId]))
        .rows
    : []
  return {
    tenantId,
    canEdit: canEdit(ctx),
    data: data.rows.map(summary),
    total: Number(total.rows[0]!.total),
    offset,
    limit,
    warehouses: locations.rows,
    categories,
  }
}
export function needsRecount(expected: bigint, counted: bigint, percent: number | null) {
  if (percent === null) return false
  const deviation = expected > counted ? expected - counted : counted - expected
  const [whole, fraction = ""] = String(percent).split(".")
  const scaledPercent = BigInt(whole + fraction.padEnd(4,"0"))
  return deviation * 1_000_000n > expected * scaledPercent
}
export async function participated({ client, tenantId, authSubject }: AuthorizedContext, id: string) {
  return (
    (
      await client.query(
        `SELECT EXISTS(SELECT 1 FROM inventory_count_lines
      WHERE tenant_id=$1 AND count_id=$2 AND ($3=counted_by OR $3=recounted_by))
    OR EXISTS(SELECT 1 FROM audit_log a JOIN identities i ON i.id=a.identity_id
      WHERE a.tenant_id=$1 AND a.entity_id=$2::uuid::text AND a.entity_type='inventory_count'
        AND a.action IN ('inventory.count.line_counted','inventory.count.line_recounted') AND i.auth_subject=$3) AS involved`,
        [tenantId, id, authSubject],
      )
    ).rows[0]!.involved === true
  )
}
type CountLineRow = {
  product_id: string
  sku: string
  name: string
  unit: string
  expected_quantity_micros: string
  counted_quantity_micros: string | null
  note: string | null
  counted_at: Date | null
  recounted_at: Date | null
  stock_changed: boolean
}
export async function countDetail(ctx: AuthorizedContext, id: string) {
  const count = await countSummary(ctx, id)
  const showExpected = !count.blind || count.status !== "open"
  const { rows } = await ctx.client.query<CountLineRow>(
    `SELECT l.*,p.sku,p.name,p.unit FROM inventory_count_lines l
    JOIN products p ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id) WHERE l.tenant_id=$1 AND l.count_id=$2 ORDER BY p.name,p.id`,
    [ctx.tenantId, id],
  )
  const canApprove =
    ctx.permissions.includes("inventory.counts.approve") && count.createdBy !== ctx.authSubject && !(await participated(ctx, id))
  return {
    tenantId: ctx.tenantId,
    canEdit: canEdit(ctx),
    canApprove,
    count,
    lines: rows.map((row) => {
      const expected = BigInt(row.expected_quantity_micros),
        counted = row.counted_quantity_micros === null ? null : BigInt(row.counted_quantity_micros)
      return {
        productId: row.product_id,
        sku: row.sku,
        name: row.name,
        unit: row.unit,
        expectedQuantity: showExpected ? decimal(expected, 6) : null,
        countedQuantity: counted === null ? null : decimal(counted, 6),
        note: row.note,
        countedAt: row.counted_at?.toISOString() ?? null,
        needsRecount: counted !== null && !row.recounted_at && needsRecount(expected, counted, count.recountPercent),
        recountedAt: row.recounted_at?.toISOString() ?? null,
        stockChanged: row.stock_changed,
      }
    }),
  }
}
