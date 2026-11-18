import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { decimal, fixed } from "../sales/fixed.js"
import { queryInteger } from "../registrations/query.js"

const reasonInput = z.string().trim().min(3).max(500)
const transferInput = z.strictObject({ fromId: normalizedDatabaseId, toId: normalizedDatabaseId, reason: reasonInput,
  items: z.array(z.strictObject({ productId: normalizedDatabaseId, quantity: z.string() })).min(1).max(100) })
const reverseInput = z.strictObject({ reason: reasonInput })
const pageInput = z.strictObject({ id: normalizedDatabaseId.optional(), offset: queryInteger(0, 100_000).default(0), limit: queryInteger(1, 100).default(25) })
type Line = { productId: string; quantity: string; issueId?: string; receiptId?: string }
type Transfer = { fromId: string; toId: string; reason: string; items: Line[] }
type Headers = Record<string, string | string[] | undefined>
const unavailable = () => new Problem(404, "not_found", "Transferência não encontrada nesta empresa")

export async function listTransfers({ client, tenantId }: AuthorizedContext, query: unknown) {
  const page = pageInput.safeParse(query)
  if (!page.success) throw new Problem(422, "invalid_input", "Paginação inválida")
  const { offset, limit } = page.data
  const rows = await client.query(`
    SELECT t.id,t.created_at AS "createdAt",t.reverses_id AS "reversesId",r.id AS "reversedBy",
      t.from_id AS "fromId",o.name AS "fromName",t.to_id AS "toId",d.name AS "toName",t.reason
    FROM stock_transfers t JOIN warehouses o ON (o.tenant_id,o.id)=(t.tenant_id,t.from_id)
    JOIN warehouses d ON (d.tenant_id,d.id)=(t.tenant_id,t.to_id)
    LEFT JOIN stock_transfers r ON (r.tenant_id,r.reverses_id)=(t.tenant_id,t.id)
    WHERE t.tenant_id=$1 AND ($4::uuid IS NULL OR t.id=$4) ORDER BY t.created_at DESC,t.id DESC LIMIT $2 OFFSET $3`, [tenantId, limit+1, offset,page.data.id])
  return { tenantId, data: rows.rows.slice(0,limit), hasMore: rows.rows.length>limit, offset, limit }
}

export async function transferItems({ client, tenantId }: AuthorizedContext, id: string) {
  const rows = await client.query<{ productId: string; sku: string; name: string; unit: string; quantity_micros: string; issueId: string; receiptId: string }>(`
    SELECT p.id AS "productId",p.sku,p.name,p.unit,i.quantity_micros,i.id AS "issueId",r.id AS "receiptId"
    FROM stock_movements i JOIN stock_movements r ON (r.tenant_id,r.transfer_id,r.product_id)=(i.tenant_id,i.transfer_id,i.product_id)
    JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.product_id)
    WHERE i.tenant_id=$1 AND i.transfer_id=$2 AND i.direction='issue' AND r.direction='receipt' ORDER BY p.sku,p.id`, [tenantId, id])
  if (!rows.rows.length) throw unavailable()
  return rows.rows.map(({ quantity_micros, ...item }) => ({ ...item, quantity: decimal(BigInt(quantity_micros),6) }))
}

async function reverseTransfer(context: AuthorizedContext, id: string, reason: string): Promise<Transfer> {
  const { rows } = await context.client.query<{ from_id: string; to_id: string; reversed: boolean }>(`
    SELECT t.from_id,t.to_id,t.reverses_id IS NOT NULL OR EXISTS (SELECT 1 FROM stock_transfers r
      WHERE r.tenant_id=t.tenant_id AND r.reverses_id=t.id) AS reversed
    FROM stock_transfers t WHERE t.tenant_id=$1 AND t.id=$2`, [context.tenantId,id])
  const original = rows[0]
  if (!original) throw unavailable()
  if (original.reversed) throw new Problem(409, "domain_conflict", "A transferência já foi estornada ou é um estorno")
  return { fromId: original.to_id, toId: original.from_id, reason, items: await transferItems(context, id) }
}

async function postPair({ client, tenantId }: AuthorizedContext, id: string, line: Line, reason: string) {
  const quantity = fixed(line.quantity,6)
  if (quantity<=0n) throw new Problem(422, "invalid_input", "A quantidade deve ser positiva")
  const result = await client.query<{ quantity_micros: string; status: string }>(`
    SELECT b.quantity_micros,p.status FROM stock_balances b JOIN products p ON (p.tenant_id,p.id)=(b.tenant_id,b.product_id)
    WHERE b.tenant_id=$1 AND b.product_id=$2 FOR UPDATE OF b`, [tenantId,line.productId])
  const balance = result.rows[0]
  if (!balance || BigInt(balance.quantity_micros)<quantity) throw new Problem(409,"domain_conflict","Saldo insuficiente para transferir")
  if (balance.status!=="active" && !line.receiptId) throw new Problem(409,"domain_conflict","Reative o produto antes de transferir")
  for (const direction of ["issue","receipt"] as const) {
    const after = BigInt(balance.quantity_micros) - (direction==="issue" ? quantity : 0n)
    await client.query("UPDATE stock_balances SET quantity_micros=$3 WHERE tenant_id=$1 AND product_id=$2", [tenantId,line.productId,after])
    await client.query(`INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,transfer_id,reverses_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(),tenantId,line.productId,direction,quantity,after,reason,id,direction==="issue" ? line.receiptId : line.issueId])
  }
}

export async function postTransfer(context: AuthorizedContext, headers: Headers, body: unknown, originalId?: string) {
  const key = commandKey(headers["idempotency-key"])
  const request = originalId ? reverseInput.safeParse(body) : undefined
  const creation = originalId ? undefined : transferInput.safeParse(body)
  if (!creation?.success && !request?.success) throw new Problem(422,"invalid_input","Confira depósitos, produtos, quantidades e motivo da transferência")
  const input = { ...(creation?.data ?? request?.data), originalId: originalId ?? null }, scope = "stock.transfer"
  const previous = await replay(context, key, scope, input)
  if (previous) return previous
  const doc: Transfer = creation?.success ? creation.data : await reverseTransfer(context,originalId!,request!.data!.reason)
  if (doc.fromId===doc.toId || new Set(doc.items.map(item=>item.productId)).size!==doc.items.length)
    throw new Problem(422,"invalid_input","Informe depósitos distintos e uma linha por produto")
  const { client, tenantId } = context
  const enabled = await client.query("SELECT enabled FROM stock_location_settings WHERE tenant_id=$1", [tenantId])
  if (!enabled.rows[0]?.enabled) throw new Problem(409,"domain_conflict","Habilite os saldos por depósito")
  const sites = await client.query("SELECT id FROM warehouses WHERE tenant_id=$1 AND status='active' AND id IN ($2,$3)", [tenantId,doc.fromId,doc.toId])
  if (sites.rows.length!==2) throw new Problem(422,"invalid_input","Selecione dois depósitos ativos desta empresa")
  const id = randomUUID()
  await client.query("INSERT INTO stock_transfers(tenant_id,id,from_id,to_id,reason,reverses_id) VALUES($1,$2,$3,$4,$5,$6)",
    [tenantId,id,doc.fromId,doc.toId,doc.reason,originalId])
  for (const item of doc.items) await postPair(context,id,item,doc.reason)
  const result = { tenantId,id,fromId: doc.fromId,toId: doc.toId,reason:doc.reason,reversesId:originalId ?? null,
    items: await transferItems(context,id) }
  await record(context,headers,"stock_transfer",id,originalId ? "stock.transfer.reversed" : "stock.transferred",result)
  await remember(context,key,scope,input,result)
  return result
}
