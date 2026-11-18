import { randomUUID } from "node:crypto"
import type { AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { decimal, fixed } from "../sales/fixed.js"
import { conflict, type OrderSnapshot } from "./acceptance.js"
import type { CommandHeaders } from "./receivables.js"

export async function heldQuantity(context: AuthorizedContext, product: unknown) {
  const result = await context.client.query("SELECT COALESCE(sum(l.quantity_micros-order_line_delivered(l.tenant_id,l.order_id,l.line_number)),0)::bigint AS quantity FROM sales_order_lines l JOIN sales_orders o ON o.tenant_id=l.tenant_id AND o.id=l.order_id WHERE l.tenant_id=$1 AND l.product_id=$2 AND o.status='confirmed'", [context.tenantId, product])
  return BigInt(String(result.rows[0]!.quantity))
}

export async function reserveOrder(context: AuthorizedContext, order: OrderSnapshot) {
  for (const item of order.items) {
    const row = (await context.client.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2", [context.tenantId, item.productId])).rows[0]
    const balance = BigInt(String(row?.quantity_micros ?? 0)), held = await heldQuantity(context, item.productId)
    if (balance - held < fixed(String(item.quantity), 6) || balance < held) conflict("Saldo disponível insuficiente para reservar ou concluir o pedido")
  }
}

export async function issueOrder(context: AuthorizedContext, headers: CommandHeaders, order: OrderSnapshot) {
  for (const item of order.items) {
    const { client, tenantId } = context
    const line = (await client.query("SELECT l.quantity_micros-order_line_delivered(l.tenant_id,l.order_id,l.line_number) AS quantity_micros,l.unit FROM sales_order_lines l JOIN sales_orders o ON o.tenant_id=l.tenant_id AND o.id=l.order_id WHERE l.tenant_id=$1 AND l.order_id=$2 AND l.product_id=$3 AND o.status='confirmed'", [tenantId, order.data.id, item.productId])).rows[0]
    if (line && BigInt(String(line.quantity_micros)) === 0n) continue
    if (!line) conflict("A saída exige uma reserva confirmada deste pedido e produto")
    const product = (await client.query("SELECT status,unit FROM products WHERE tenant_id=$1 AND id=$2", [tenantId, item.productId])).rows[0]
    if (!product || product.status !== "active" || product.unit !== line.unit) conflict("O produto precisa estar ativo e conservar a unidade do pedido")
    const row = (await client.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE", [tenantId, item.productId])).rows[0]
    if (!row) conflict("Saldo insuficiente")
    const quantity = BigInt(String(line.quantity_micros)), balance = BigInt(String(row.quantity_micros)), held = await heldQuantity(context, item.productId)
    if (quantity <= 0n || held < quantity || balance < held) conflict("Saldo reservado insuficiente para concluir o pedido")
    const next = balance - quantity, movement = randomUUID()
    if (next < 0n) conflict("Saldo insuficiente")
    await client.query("UPDATE stock_balances SET quantity_micros=$3 WHERE tenant_id=$1 AND product_id=$2", [tenantId, item.productId, next])
    await client.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_order_id) VALUES($1,$2,$3,'issue',$4,$5,$6,$7)", [movement, tenantId, item.productId, quantity, next, `Conclusão comercial do pedido ${order.data.id}`, order.data.id])
    await record(context, headers, "stock_movement", movement, "stock.moved", { orderId: order.data.id, productId: item.productId, direction: "issue", quantity: decimal(quantity, 6), balanceAfter: decimal(next, 6) })
  }
}

export async function validateFiscalCompletion(context: AuthorizedContext, id: unknown) {
  const fiscal = await context.client.query("SELECT (EXISTS(SELECT 1 FROM fiscal_nfe_drafts WHERE tenant_id=$1 AND environment='production' AND details->>'sourceOrderId'=$2::uuid::text) OR EXISTS(SELECT 1 FROM fiscal_nfe_documents WHERE tenant_id=$1 AND source_order_id=$2 AND environment='production')) AND NOT EXISTS(SELECT 1 FROM fiscal_nfe_documents WHERE tenant_id=$1 AND source_order_id=$2 AND environment='production' AND status='authorized') AS pending", [context.tenantId, id])
  const lots = await context.client.query(`SELECT EXISTS(SELECT FROM sales_invoice_lots WHERE tenant_id=$1 AND order_id=$2 AND environment='production' AND NOT withdrawn)
    AND EXISTS(SELECT FROM sales_order_lines s WHERE s.tenant_id=$1 AND s.order_id=$2 AND
      (order_line_delivered(s.tenant_id,s.order_id,s.line_number)<>s.quantity_micros OR
       (SELECT coalesce(sum(i.quantity_micros),0) FROM sales_invoice_lot_items i JOIN sales_invoice_lots l ON l.tenant_id=i.tenant_id AND l.id=i.lot_id
        JOIN fiscal_nfe_documents d ON d.tenant_id=l.tenant_id AND d.id=l.draft_id WHERE i.tenant_id=s.tenant_id AND i.order_id=s.order_id AND i.line_number=s.line_number
        AND NOT l.withdrawn AND d.environment='production' AND d.status='authorized')<>s.quantity_micros)) AS pending`,[context.tenantId,id])
  if (lots.rows[0]?.pending) conflict("Autorize e entregue o saldo dos lotes de produção antes de concluir o pedido")
  if (fiscal.rows[0]?.pending) conflict("Autorize a NF-e de produção vinculada antes de concluir o pedido")
}
