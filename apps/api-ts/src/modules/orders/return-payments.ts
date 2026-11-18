import type { AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { nextRevision } from "../../platform/revision.js"
import { reverseWalletPayment } from "../finance-wallets/settlements.js"
import { loadWallet } from "../finance-wallets/snapshot.js"
import { conflict } from "./acceptance.js"
import type { CommandHeaders } from "./receivables.js"

export async function cancelCompletedReceivables(context: AuthorizedContext, headers: CommandHeaders, order: string, reason: string, occurredOn: string) {
  const { client, tenantId } = context
  const titles = await client.query<{ id: string }>("SELECT id FROM receivables WHERE tenant_id=$1 AND order_id=$2 ORDER BY id FOR UPDATE", [tenantId, order])
  if (!titles.rows.length) conflict("Pedido concluído sem título financeiro. Concilie antes de cancelar")
  const receivableIds = titles.rows.map(row => row.id), paymentReversalIds: string[] = []
  for (const id of receivableIds) {
    let title = await loadWallet(context, "receivables", id)
    if (title.data.status === "cancelled") conflict("Título financeiro já cancelado")
    const reversed = new Set(title.payments.map(row => row.reversesId))
    const receipts = title.payments.filter(row => row.kind === "receipt" && !reversed.has(row.id))
    for (const receipt of receipts) {
      title = await reverseWalletPayment(context, headers, "receivables", id, title.data.revision, {
        paymentId: receipt.id, reason, occurredOn,
      })
      paymentReversalIds.push(title.payments.find(payment => payment.reversesId === receipt.id)!.id)
    }
    const previousRevision = title.data.revision, revision = nextRevision(previousRevision)
    await client.query("UPDATE receivables SET status='cancelled',payment_id=NULL,revision=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, id, revision])
    await record(context, headers, "receivable", id, "receivable.cancelled", { sourceId: order, reason, previousRevision, revision, status: "cancelled", outstandingAmount: "0.00" })
  }
  return { receivableId: receivableIds.length === 1 ? receivableIds[0] : null, receivableIds, paymentReversalIds }
}
