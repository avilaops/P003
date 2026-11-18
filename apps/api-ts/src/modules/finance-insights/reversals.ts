import { postOperationReversal } from "../finance-management/operation-postings.js"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue } from "../../platform/revision.js"
import { writableAccount } from "../finance-treasury/ledger.js"
import { reverseWalletPayment } from "../finance-wallets/settlements.js"
import { validate } from "./portfolio.js"

const reversal = z.object({ id: z.guid(), occurredOn: z.iso.date(), reason: z.string().trim().min(3).max(200) }).strict()
type Input = z.infer<typeof reversal>
type Headers = Record<string, string | string[] | undefined>
function conflict(message: string): never {
  throw new Problem(409, "domain_conflict", message)
}

async function reverse(context: AuthorizedContext, headers: Headers, input: Input, key: string) {
  const { tenantId, client } = context
  const operation = (
    await client.query(
      "SELECT id,kind,side,occurred_on::text AS day,entry_id FROM finance_operations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenantId, input.id],
    )
  ).rows[0]
  if (!operation) throw new Problem(404, "not_found", "Operação não encontrada")
  const sides = operation.kind === "offset" ? ["receivable", "payable"] : [operation.side]
  for (const side of sides) {
    requirePermission(context, "finance." + side + "s.read")
    requirePermission(context, "finance." + side + "s.manage")
  }
  if (operation.kind === "advance") requirePermission(context, "finance.account_entries.manage")
  const prior = await replay(context, key, "finance.operation.reverse", input)
  if (prior) return prior
  if (input.occurredOn < String(operation.day)) conflict("A data do estorno precisa ser igual ou posterior à operação")
  if (
    (await client.query("SELECT FROM finance_operation_reversals WHERE tenant_id=$1 AND operation_id=$2", [tenantId, input.id]))
      .rows.length
  )
    conflict("Operação já estornada")
  let entryId: string | null = null
  if (operation.kind === "advance") {
    if (
      (await client.query("SELECT FROM finance_active_operations WHERE tenant_id=$1 AND advance_id=$2", [tenantId, input.id]))
        .rows.length
    )
      conflict("Estorne primeiro as aplicações deste adiantamento")
    const original = (
      await client.query("SELECT account_id,direction,amount_cents FROM financial_account_entries WHERE tenant_id=$1 AND id=$2", [
        tenantId,
        operation.entry_id,
      ])
    ).rows[0]!
    await writableAccount(context, String(original.account_id), input.occurredOn)
    entryId = randomUUID()
    await client.query(
      "INSERT INTO financial_account_entries(id,tenant_id,account_id,direction,amount_cents,occurred_on,description,reference,category_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,finance_ledger_nature($2,'advance',$4))",
      [
        entryId,
        tenantId,
        original.account_id,
        original.direction === "credit" ? "debit" : "credit",
        original.amount_cents,
        input.occurredOn,
        input.reason,
        input.id,
      ],
    )
  }
  if (
    operation.kind === "billing_group" &&
    (await client.query("SELECT FROM finance_collection_charges WHERE tenant_id=$1 AND group_id=$2", [tenantId, input.id])).rows
      .length
  )
    conflict("Já existe uma cobrança bancária reservada para o grupo")
  if (operation.kind === "restructure") {
    const receiving = operation.side === "receivable"
    const table = receiving ? "receivables" : "payables"
    const blocked = await client.query(
      `SELECT FROM finance_portfolio p WHERE p.tenant_id=$1 AND p.finance_operation_id=$2
      AND (p.open_cents<>p.amount_cents OR p.status<>'open' OR EXISTS (
        SELECT FROM finance_operation_items i JOIN finance_active_operations a ON (a.tenant_id,a.id)=(i.tenant_id,i.operation_id)
        WHERE i.tenant_id=p.tenant_id AND coalesce(i.receivable_id,i.payable_id)=p.id
      ) OR EXISTS (SELECT FROM finance_collection_items c WHERE c.tenant_id=p.tenant_id AND c.receivable_id=p.id)) LIMIT 1`,
      [tenantId, input.id],
    )
    if (blocked.rows.length) conflict("Uma parcela substituta já foi movimentada ou vinculada a uma cobrança")
    await client.query(
      `UPDATE ${table} SET status='cancelled',revision=revision+1 WHERE tenant_id=$1 AND finance_operation_id=$2`,
      [tenantId, input.id],
    )
  }
  if (["allocation", "offset", "restructure"].includes(String(operation.kind))) {
    const originals = await client.query(
      `SELECT p.id,p.side,p.revision,coalesce(i.receipt_payment_id,i.payable_payment_id) AS payment_id
      FROM finance_operation_items i JOIN finance_portfolio p ON p.tenant_id=i.tenant_id AND
        ((p.side='receivable' AND p.id=i.receivable_id) OR (p.side='payable' AND p.id=i.payable_id))
      WHERE i.tenant_id=$1 AND i.operation_id=$2 ORDER BY p.id`,
      [tenantId, input.id],
    )
    for (const item of originals.rows) {
      await reverseWalletPayment(
        context,
        headers,
        item.side === "receivable" ? "receivables" : "financial-payables",
        String(item.id),
        revisionValue(item.revision),
        { paymentId: String(item.payment_id), reason: input.reason, occurredOn: input.occurredOn },
        true,
      )
    }
  }
  await client.query(
    "INSERT INTO finance_operation_reversals(tenant_id,operation_id,occurred_on,reason,recorded_by,entry_id) VALUES($1,$2,$3,$4,$5,$6)",
    [tenantId, input.id, input.occurredOn, input.reason, context.authSubject, entryId],
  )
  if (operation.kind === "advance" || operation.kind === "restructure") await postOperationReversal(context, headers, input.id)
  await record(context, headers, "finance_operation", input.id, "finance.operation.reversed", {
    occurredOn: input.occurredOn,
    reason: input.reason,
    entryId,
  })
  const result = { tenantId, data: { id: input.id, status: "reversed", revision: 2 } }
  await remember(context, key, "finance.operation.reverse", input, result)
  return result
}

export function registerOperationReversals(app: FastifyInstance, deps: AppDependencies) {
  app.post("/api/v1/finance/operation-reversals", async (request, reply) => {
    const input = validate(reversal, request.body),
      key = commandKey(request.headers["idempotency-key"])
    const result = await authorizeRequest(request, deps, (ctx) => reverse(ctx, request.headers, input, key))
    return reply.header("etag", '"2"').header("cache-control", "no-store").send(result)
  })
}
