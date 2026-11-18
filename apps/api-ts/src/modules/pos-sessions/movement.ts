import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { normalizedDatabaseId as id } from "../../platform/database-id.js"
import { assertOpenAccountPeriod, conflict, invalid, missing, textField } from "../finance-treasury/ledger.js"
import { fixed } from "../sales/fixed.js"
import { expectedCash } from "./snapshot.js"

export const reference = textField(3, 200)
export const movementSchema = z.union([
  z.strictObject({
    direction: z.enum(["supply", "withdrawal"]),
    amount: z.string(),
    reason: z.string(),
    sourceAccountId: id.nullable().default(null),
    targetAccountId: id.nullable().default(null),
  }),
  z.strictObject({ reversesMovementId: id, reason: z.string() }),
])
export async function accountBalance(c: AuthorizedContext, id: string) {
  const { rows } = await c.client.query(
    "SELECT coalesce(sum(CASE direction WHEN 'credit' THEN amount_cents ELSE -amount_cents END),0) AS balance FROM financial_account_entries WHERE tenant_id=$1 AND account_id=$2",
    [c.tenantId, id],
  )
  return BigInt(String(rows[0]!.balance))
}
export async function move(
  c: AuthorizedContext,
  session: string,
  cash: string,
  day: string,
  input: z.infer<typeof movementSchema>,
) {
  let direction: "supply" | "withdrawal",
    amount: bigint,
    source: string,
    target: string,
    reverses: string | null = null
  const reason = reference.safeParse(input.reason)
  if (!reason.success) throw invalid("Informe o motivo da movimentação com 3 a 200 caracteres")
  if ("reversesMovementId" in input) {
    const original = (
      await c.client.query(
        `SELECT m.direction,m.amount_cents,m.reverses_movement_id,t.source_account_id,t.target_account_id,
      EXISTS(SELECT 1 FROM pos_cash_movements r WHERE r.tenant_id=m.tenant_id AND r.reverses_movement_id=m.id) AS reversed
      FROM pos_cash_movements m JOIN financial_account_transfers t ON t.tenant_id=m.tenant_id AND t.id=m.transfer_id
      WHERE m.tenant_id=$1 AND m.id=$2 AND m.session_id=$3`,
        [c.tenantId, input.reversesMovementId, session],
      )
    ).rows[0]
    if (!original) throw missing()
    if (original.reverses_movement_id || original.reversed) throw conflict("Esta movimentação já possui estorno")
    reverses = input.reversesMovementId
    direction = original.direction === "supply" ? "withdrawal" : "supply"
    amount = BigInt(String(original.amount_cents))
    source = String(original.target_account_id)
    target = String(original.source_account_id)
  } else {
    direction = input.direction
    amount = fixed(input.amount, 2)
    if (!amount) throw invalid("Valor deve ser positivo")
    if (direction === "supply") {
      if (!input.sourceAccountId || input.targetAccountId) throw invalid("Selecione a origem do suprimento")
      source = input.sourceAccountId
      target = cash
    } else {
      if (!input.targetAccountId || input.sourceAccountId) throw invalid("Selecione o destino da sangria")
      source = cash
      target = input.targetAccountId
    }
  }
  if (source === target) throw invalid("As duas contas precisam ser distintas")
  const active = await c.client.query(
    "SELECT id FROM financial_accounts WHERE tenant_id=$1 AND id IN ($2,$3) AND status='active' ORDER BY id FOR UPDATE",
    [c.tenantId, source, target],
  )
  if (active.rows.length !== 2) throw conflict("As contas precisam estar ativas nesta empresa")
  const busy = await c.client.query(
    "SELECT id FROM pos_sessions WHERE tenant_id=$1 AND cash_account_id=$2 AND status='open'",
    [c.tenantId, direction === "supply" ? source : target],
  )
  if (busy.rows.length) throw conflict("A contrapartida tem uma sessão de PDV aberta")
  await assertOpenAccountPeriod(c, source, day)
  await assertOpenAccountPeriod(c, target, day)
  if ((await accountBalance(c, source)) < amount) throw conflict("Saldo financeiro insuficiente na conta de origem")
  if (direction === "withdrawal" && (await expectedCash(c, session)) < amount)
    throw conflict("Sangria excede dinheiro esperado neste caixa")
  const transfer = randomUUID(),
    movement = randomUUID()
  await c.client.query(
    `INSERT INTO financial_account_transfers(id,tenant_id,source_account_id,target_account_id,amount_cents,occurred_on,description,reference)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [transfer, c.tenantId, source, target, amount, day, reason.data, movement],
  )
  await c.client.query(
    `INSERT INTO financial_account_entries(id,tenant_id,account_id,transfer_id,direction,amount_cents,occurred_on,description,reference)
    VALUES($1,$2,$3,$4,'debit',$5,$6,$7,$8),($9,$2,$10,$4,'credit',$5,$6,$7,$8)`,
    [randomUUID(), c.tenantId, source, transfer, amount, day, "PDV " + movement, movement, randomUUID(), target],
  )
  await c.client.query(
    `INSERT INTO pos_cash_movements(tenant_id,id,session_id,direction,amount_cents,reason,transfer_id,reverses_movement_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [c.tenantId, movement, session, direction, amount, reason.data, transfer, reverses],
  )
  await c.client.query("UPDATE pos_sessions SET revision=revision+1 WHERE tenant_id=$1 AND id=$2", [
    c.tenantId,
    session,
  ])
}
