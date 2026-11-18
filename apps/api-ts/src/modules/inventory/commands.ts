import { randomUUID } from "node:crypto"
import { z } from "zod"
import { type AuthorizedContext, requirePermission } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { heldQuantity } from "../orders/fulfillment.js"
import { decimal, fixed } from "../sales/fixed.js"
import { movement, movementOriginJoins, notFound, occurredAtSql } from "./queries.js"

const inputSchema = z.strictObject({
  productId: normalizedDatabaseId,
  warehouseId: normalizedDatabaseId.optional(),
  direction: z.enum(["receipt", "issue"]),
  quantity: z.string(),
  reason: z.string().trim().refine(value => Array.from(value).length >= 3 && Array.from(value).length <= 500),
  reversesId: normalizedDatabaseId.nullish().transform(value => value ?? null),
})

function conflict(message: string): never { throw new Problem(409, "domain_conflict", message) }

async function validateReversal(context: AuthorizedContext, input: z.output<typeof inputSchema>, quantity: bigint) {
  const { client, tenantId } = context
  const row = (await client.query(`
    SELECT m.product_id,m.direction,m.quantity_micros,m.reverses_id,m.transfer_id,
      coalesce(m.source_order_id,m.source_purchase_receipt_id,m.production_order_id,m.source_pos_sale_id,w.case_id)::text AS document,origin.inventory_count_id,origin.return_source_id,
      EXISTS (SELECT 1 FROM stock_movements r WHERE r.tenant_id=m.tenant_id AND r.reverses_id=m.id) AS reversed
    FROM stock_movements m ${movementOriginJoins}
    WHERE m.tenant_id=$1 AND m.id=$2
  `, [tenantId, input.reversesId])).rows[0]
  if (!row) throw notFound()
  if (row.document || row.inventory_count_id || row.return_source_id || row.transfer_id) conflict("Use o fluxo do documento de origem para estornar")
  if (row.product_id !== input.productId || row.direction === input.direction || BigInt(String(row.quantity_micros)) !== quantity || row.reverses_id)
    conflict("Estorno exige o mesmo produto e quantidade, com direção oposta a um movimento original")
  if (row.reversed) conflict("Movimento já estornado")
}

export async function postMovement(context: AuthorizedContext, headers: Record<string, string | string[] | undefined>, body: unknown) {
  requirePermission(context, "inventory.stock.read")
  requirePermission(context, "inventory.stock.manage")
  const key = commandKey(headers["idempotency-key"])
  const parsed = inputSchema.safeParse(body)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Informe produto, direção, quantidade e motivo de 3 a 500 caracteres")
  const input = parsed.data, quantity = fixed(input.quantity, 6)
  if (!quantity) throw new Problem(422, "invalid_input", "Informe quantidade positiva")
  const previous = await replay(context, key, "stock.movement", input)
  if (previous) return previous

  const { client, tenantId } = context
  const settings = (await client.query("SELECT allow_manual_movements,minimum_reason_length FROM inventory_settings WHERE tenant_id=$1", [tenantId])).rows[0]
  if (settings?.allow_manual_movements === false) conflict("Movimentações manuais desabilitadas em Preferências de estoque")
  if (settings && Array.from(input.reason).length < Number(settings.minimum_reason_length)) throw new Problem(422, "invalid_input", "Motivo menor que o mínimo configurado em Preferências de estoque")
  const product = (await client.query("SELECT status FROM products WHERE tenant_id=$1 AND id=$2", [tenantId, input.productId])).rows[0]
  if (!product) throw notFound()
  if (product.status !== "active") conflict("Reative o produto antes de movimentar o estoque")
  if (input.reversesId) await validateReversal(context, input, quantity)
  await client.query("INSERT INTO stock_balances(tenant_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [tenantId, input.productId])
  const balance = (await client.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE", [tenantId, input.productId])).rows[0]!
  const next = BigInt(String(balance.quantity_micros)) + (input.direction === "receipt" ? quantity : -quantity)
  if (next < 0n || next > 999999999999999999n) conflict("Saldo insuficiente ou limite de estoque excedido")
  if (next < await heldQuantity(context, input.productId)) conflict("Saldo disponível insuficiente para atender à reserva dos pedidos")
  await client.query("UPDATE stock_balances SET quantity_micros=$3 WHERE tenant_id=$1 AND product_id=$2", [tenantId, input.productId, next])
  const id = randomUUID()
  const inserted = await client.query(`
    INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,reverses_id,warehouse_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *,${occurredAtSql} AS occurred_at
  `, [id, tenantId, input.productId, input.direction, quantity, next, input.reason, input.reversesId, input.warehouseId])
  const result = movement(inserted.rows[0]!)
  await record(context, headers, "stock_movement", id, "stock.moved", { productId: input.productId, direction: input.direction,
    quantity: input.quantity, balanceAfter: decimal(next, 6), reversesId: input.reversesId })
  await remember(context, key, "stock.movement", input, result)
  return result
}
