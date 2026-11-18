import { randomUUID } from "node:crypto"
import type { AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { decimal } from "../sales/fixed.js"
import { heldQuantity } from "../orders/fulfillment.js"
import { checkCountRevision, countConflict, countSummary, needsRecount, participated } from "./count-query.js"
import type { CommandHeaders } from "./count-commands.js"

type AdjustmentLine = {
  product_id: string
  status: string
  expected_quantity_micros: string
  counted_quantity_micros: string | null
  counted_by: string | null
  recounted_at: Date | null
  stock_changed: boolean
  current_quantity: string
  total_quantity: string
}

export async function approveCount(ctx: AuthorizedContext, headers: CommandHeaders, id: string) {
  const { client, tenantId, authSubject } = ctx
  const key = commandKey(headers["idempotency-key"]),
    scope = "inventory.count.approve",
    input = { countId: id }
  const previous = await replay(ctx, key, scope, input)
  if (previous) return previous
  const count = await countSummary(ctx, id)
  if (count.status !== "open") throw countConflict("Este inventário já foi encerrado")
  checkCountRevision(count, headers)
  if (count.createdBy === authSubject || (await participated(ctx, id)))
    throw new Problem(403, "forbidden", "A aprovação exige uma pessoa autorizada que não abriu nem contou este inventário")
  const settings = (await client.query("SELECT enabled FROM stock_location_settings WHERE tenant_id=$1", [tenantId])).rows[0]
  if (Boolean(settings?.enabled) !== Boolean(count.warehouseId))
    throw countConflict("O controle de depósitos mudou. Cancele a sessão e reabra no escopo atual")
  const lines = await client.query<AdjustmentLine>(
    `SELECT l.*,p.status,
      coalesce(b.quantity_micros,0) AS total_quantity,
      coalesce(CASE WHEN $3::uuid IS NULL THEN b.quantity_micros ELSE pos.quantity_micros END,0) AS current_quantity
    FROM inventory_count_lines l JOIN products p ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id)
    LEFT JOIN stock_balances b ON (b.tenant_id,b.product_id)=(l.tenant_id,l.product_id)
    LEFT JOIN stock_positions pos ON (pos.tenant_id,pos.product_id)=(l.tenant_id,l.product_id) AND pos.warehouse_id=$3
    WHERE l.tenant_id=$1 AND l.count_id=$2 ORDER BY l.product_id`,
    [tenantId, id, count.warehouseId],
  )
  if (!lines.rows.length) throw countConflict("Sessão sem itens para aprovar")
  await client.query("SELECT set_config('app.inventory_count_id',$1,true)", [id])
  for (const line of lines.rows) {
    if (line.counted_quantity_micros === null) throw countConflict("Conte todos os produtos antes de aprovar")
    if (!line.counted_by) throw countConflict("Confirme a contagem anterior para registrar a pessoa responsável")
    const expected = BigInt(line.expected_quantity_micros),
      current = BigInt(line.current_quantity),
      counted = BigInt(line.counted_quantity_micros)
    if (line.stock_changed || current !== expected) throw countConflict("O estoque mudou desde a abertura. Cancele a sessão e abra outra")
    if (needsRecount(expected, counted, count.recountPercent) && !line.recounted_at)
      throw countConflict("Conclua a recontagem das divergências antes de aprovar")
    const delta = counted - expected
    if (delta === 0n) continue
    if (line.status !== "active") throw countConflict("Reative o produto arquivado antes de ajustar seu estoque")
    const next = BigInt(line.total_quantity) + delta
    if (next < 0n || next > 999999999999999999n) throw countConflict("O ajuste excede o limite de estoque")
    if (delta < 0n && next < (await heldQuantity(ctx, line.product_id)))
      throw countConflict("A contagem reduziria o saldo abaixo do estoque reservado")
    const movementId = randomUUID(),
      direction = delta > 0n ? "receipt" : "issue",
      quantity = delta > 0n ? delta : -delta
    await client.query(
      `INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,$3)
      ON CONFLICT(tenant_id,product_id) DO UPDATE SET quantity_micros=excluded.quantity_micros`,
      [tenantId, line.product_id, next],
    )
    await client.query(
      `INSERT INTO stock_movements(tenant_id,id,product_id,direction,quantity_micros,balance_after_micros,reason,warehouse_id,inventory_count_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, movementId, line.product_id, direction, quantity, next, "Inventário • " + count.reference, count.warehouseId, id],
    )
    await record(ctx, headers, "stock_movement", movementId, "stock.moved", {
      inventoryCountId: id,
      productId: line.product_id,
      direction,
      quantity: decimal(quantity, 6),
      balanceAfter: decimal(next, 6),
      warehouseId: count.warehouseId,
    })
  }
  await client.query(
    `UPDATE inventory_counts SET status='approved',approved_by=$3,approved_at=clock_timestamp(),revision=revision+1
    WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id, authSubject],
  )
  await record(ctx, headers, "inventory_count", id, "inventory.count.approved", { warehouseId: count.warehouseId })
  const result = { id, status: "approved" }
  await remember(ctx, key, scope, input, result)
  return result
}
