import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { fixed } from "../sales/fixed.js"
import { checkCountRevision, countConflict, countSummary, missingCount, needsRecount } from "./count-query.js"

export type CommandHeaders = Record<string, string | string[] | undefined>
const reference = z
  .string()
  .trim()
  .refine((v) => [...v].length >= 2 && [...v].length <= 120)
const creation = z.strictObject({
  reference,
  warehouseId: normalizedDatabaseId.optional(),
  categoryId: normalizedDatabaseId.optional(),
  blind: z.boolean().optional(),
  lockMovements: z.boolean().optional(),
  recountPercent: z.number().refine(value => /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,4})?$/.test(String(value))).optional(),
})
const entry = z.strictObject({
  productId: normalizedDatabaseId,
  countedQuantity: z.string(),
  note: z
    .string()
    .trim()
    .refine((v) => Buffer.byteLength(v) <= 500)
    .nullish()
    .transform((v) => v ?? null),
  recount: z.boolean().optional(),
})

export async function createCount(ctx: AuthorizedContext, headers: CommandHeaders, body: unknown) {
  const key = commandKey(headers["idempotency-key"]),
    parsed = creation.safeParse(body)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Confira referência, escopo e opções da contagem")
  const input = parsed.data,
    scope = "inventory.count.create"
  const previous = await replay(ctx, key, scope, input)
  if (previous) return previous
  const { client, tenantId } = ctx
  const locations = (await client.query("SELECT enabled FROM stock_location_settings WHERE tenant_id=$1", [tenantId])).rows[0]
  if (Boolean(locations?.enabled) !== Boolean(input.warehouseId))
    throw new Problem(
      422,
      "invalid_input",
      locations?.enabled ? "Selecione o depósito a conferir" : "Controle por depósito desativado nesta empresa",
    )
  if (
    input.warehouseId &&
    !(await client.query("SELECT 1 FROM warehouses WHERE tenant_id=$1 AND id=$2 AND status='active'", [tenantId, input.warehouseId])).rows.length
  )
    throw new Problem(422, "invalid_input", "Selecione um depósito ativo da empresa")
  if (
    input.categoryId &&
    !(await client.query("SELECT 1 FROM product_categories WHERE tenant_id=$1 AND id=$2 AND status='active'", [tenantId, input.categoryId])).rows
      .length
  )
    throw new Problem(422, "invalid_input", "Selecione uma categoria ativa da empresa")
  const id = randomUUID()
  await client.query(
    `INSERT INTO inventory_counts(tenant_id,id,reference,created_by,warehouse_id,category_id,blind,lock_movements,recount_percent)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      tenantId,
      id,
      input.reference,
      ctx.authSubject,
      input.warehouseId,
      input.categoryId,
      input.blind ?? false,
      input.lockMovements ?? false,
      input.recountPercent,
    ],
  )
  await client.query(
    `INSERT INTO inventory_count_lines(tenant_id,count_id,product_id,expected_quantity_micros)
    SELECT p.tenant_id,$2,p.id,coalesce(CASE WHEN $3::uuid IS NULL THEN b.quantity_micros ELSE pos.quantity_micros END,0)
    FROM products p LEFT JOIN stock_balances b ON (p.tenant_id,p.id)=(b.tenant_id,b.product_id)
    LEFT JOIN stock_positions pos ON (p.tenant_id,p.id)=(pos.tenant_id,pos.product_id) AND pos.warehouse_id=$3
    WHERE p.tenant_id=$1 AND p.status='active' AND ($4::uuid IS NULL OR p.category_id=$4)`,
    [tenantId, id, input.warehouseId, input.categoryId],
  )
  const overlapping = await client.query(
    `SELECT 1 FROM inventory_counts c
    JOIN inventory_count_lines l ON (c.tenant_id,c.id)=(l.tenant_id,l.count_id)
    JOIN inventory_count_lines n ON (n.tenant_id,n.product_id)=(l.tenant_id,l.product_id) AND n.count_id=$2
    WHERE c.tenant_id=$1 AND c.status='open' AND c.id<>$2 AND (c.lock_movements OR $4)
      AND ($3::uuid IS NULL OR c.warehouse_id IS NULL OR c.warehouse_id=$3) LIMIT 1`,
    [tenantId, id, input.warehouseId, input.lockMovements ?? false],
  )
  if (overlapping.rows.length) throw countConflict("Outra conferência aberta já inclui os produtos sujeitos ao bloqueio")
  const result = await countSummary(ctx, id)
  if (!result.lineCount) throw countConflict("Nenhum produto ativo neste escopo para contar")
  await record(ctx, headers, "inventory_count", id, "inventory.count.created", input)
  await remember(ctx, key, scope, input, result)
  return result
}

export async function countLine(ctx: AuthorizedContext, headers: CommandHeaders, id: string, body: unknown) {
  const key = commandKey(headers["idempotency-key"]),
    parsed = entry.safeParse(body)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Informe o produto e a quantidade contada")
  const input = parsed.data,
    counted = fixed(input.countedQuantity, 6),
    scope = "inventory.count.line"
  // Existing command rows used just the line body as request and the owning count as result.
  const previous = await replay(ctx, key, scope, input)
  if (previous) {
    if (previous.countId !== id) throw countConflict("Esta confirmação pertence a outro inventário")
    return
  }
  const { client, tenantId, authSubject } = ctx,
    count = await countSummary(ctx, id)
  checkCountRevision(count, headers)
  if (count.status !== "open") throw countConflict("Este inventário já foi encerrado")
  const line = (
    await client.query(
      `SELECT expected_quantity_micros,counted_quantity_micros,recounted_at,stock_changed
    FROM inventory_count_lines WHERE tenant_id=$1 AND count_id=$2 AND product_id=$3`,
      [tenantId, id, input.productId],
    )
  ).rows[0]
  if (!line) throw missingCount()
  if (line.stock_changed) throw countConflict("O estoque mudou durante a conferência. Cancele a sessão e abra outra")
  const old = line.counted_quantity_micros == null ? null : BigInt(String(line.counted_quantity_micros))
  if (input.recount) {
    if (old === null || !needsRecount(BigInt(String(line.expected_quantity_micros)), old, count.recountPercent) || line.recounted_at)
      throw countConflict("Este item não tem recontagem pendente")
    if (old !== counted) throw countConflict("As duas contagens divergem. Confira a quantidade física e registre uma nova primeira contagem")
    await client.query(
      `UPDATE inventory_count_lines SET recounted_by=$4,recounted_at=clock_timestamp()
      WHERE tenant_id=$1 AND count_id=$2 AND product_id=$3`,
      [tenantId, id, input.productId, authSubject],
    )
  } else {
    await client.query(
      `UPDATE inventory_count_lines SET counted_quantity_micros=$4,note=$5,counted_by=$6,counted_at=clock_timestamp(),
      recounted_by=NULL,recounted_at=NULL WHERE tenant_id=$1 AND count_id=$2 AND product_id=$3`,
      [tenantId, id, input.productId, counted, input.note, authSubject],
    )
  }
  await client.query("UPDATE inventory_counts SET revision=revision+1 WHERE tenant_id=$1 AND id=$2", [tenantId, id])
  await record(ctx, headers, "inventory_count", id, input.recount ? "inventory.count.line_recounted" : "inventory.count.line_counted", {
    productId: input.productId,
    countedQuantity: input.countedQuantity,
  })
  await remember(ctx, key, scope, input, { countId: id, productId: input.productId })
}

export async function cancelCount(ctx: AuthorizedContext, headers: CommandHeaders, id: string, body: unknown) {
  const key = commandKey(headers["idempotency-key"])
  const parsed = z.strictObject({ reason: z.string().trim().min(3).max(500) }).safeParse(body)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Descreva o motivo do cancelamento")
  const input = { countId: id, reason: parsed.data.reason },
    scope = "inventory.count.cancel"
  const previous = await replay(ctx, key, scope, input)
  if (previous) return previous
  const count = await countSummary(ctx, id)
  checkCountRevision(count, headers)
  if (count.status !== "open") throw countConflict("Este inventário já foi encerrado")
  await ctx.client.query(
    `UPDATE inventory_counts SET status='cancelled',cancelled_at=clock_timestamp(),cancelled_by=$3,cancel_reason=$4,
    revision=revision+1 WHERE tenant_id=$1 AND id=$2`,
    [ctx.tenantId, id, ctx.authSubject, input.reason],
  )
  await record(ctx, headers, "inventory_count", id, "inventory.count.cancelled", input)
  const result = { id, status: "cancelled" }
  await remember(ctx, key, scope, input, result)
  return result
}
