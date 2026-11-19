import { randomUUID } from "node:crypto"
import type { AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { decimal } from "../sales/fixed.js"
import { prepareOrder, storeLines } from "./prepare.js"

export async function persistDraft(context: AuthorizedContext, headers: Parameters<typeof record>[1], customerId: string, prepared: Awaited<ReturnType<typeof prepareOrder>>) {
  const id = randomUUID()
  const order = await context.client.query<{number:string}>(
    "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,$4,$5,$6,$7,'draft') RETURNING number::text",
    [id, context.tenantId, customerId, prepared.customerName, prepared.customerTaxId, prepared.due, prepared.total],
  )
  await storeLines(context, id, prepared.lines)
  await record(context, headers, "sales_order", id, "order.created", { revision: 1, amount: decimal(prepared.total, 2), items: prepared.lines.length })
  return { id, number: order.rows[0]!.number }
}
