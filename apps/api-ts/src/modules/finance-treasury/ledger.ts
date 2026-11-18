import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { TenantContext } from "../../platform/database.js"
import { normalizedDatabaseId as id } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { fixed, validateDate } from "../sales/fixed.js"
import { queryInteger } from "../registrations/query.js"

export const date = z.string().transform(validateDate)
export const textField = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u)
export const invalid = (title: string) => new Problem(422, "invalid_input", title)
export const conflict = (title: string) => new Problem(409, "domain_conflict", title)
export const missing = () => new Problem(404, "not_found", "Registro não encontrado nesta empresa")
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw invalid("Confira os campos informados")
  return result.data
}
export function money(cents: string | number | bigint) {
  const value = BigInt(cents)
  const absolute = value < 0n ? -value : value
  return (value < 0n ? "-" : "") + (absolute / 100n).toString() + "." + (absolute % 100n).toString().padStart(2, "0")
}
const base = {
  amount: z.string().refine((value) => fixed(value, 2) > 0n),
  occurredOn: date,
  description: textField(3, 200),
  reference: textField(1, 200).nullable().optional().default(null),
}
export const entrySchema = z.strictObject({
  ...base,
  accountId: id,
  categoryId: id.nullable().optional().default(null),
  direction: z.enum(["credit", "debit"]),
})
export const transferSchema = z
  .strictObject({ ...base, sourceAccountId: id, targetAccountId: id })
  .refine((value) => value.sourceAccountId !== value.targetAccountId)
export const ledgerQuery = z.strictObject({
  accountId: id,
  offset: queryInteger(0, 100000).default(0),
  limit: queryInteger(1, 100).default(25),
})
export const entriesProjection = `e.id,e.account_id AS "accountId",e.transfer_id AS "transferId",e.category_id AS "categoryId",c.name AS "categoryName",e.direction,
  (e.amount_cents::numeric/100)::numeric(18,2)::text AS amount,e.occurred_on::text AS "occurredOn",e.description,e.reference`
const entriesFrom =
  "FROM financial_account_entries e LEFT JOIN financial_categories c ON c.tenant_id=e.tenant_id AND c.id=e.category_id"

export async function account(context: TenantContext, accountId: string) {
  const row = (
    await context.client.query<{
      id: string
      code: string
      name: string
      status: string
      accountType: string
      bank: string | null
      branch: string | null
      accountNumber: string | null
    }>(
      `SELECT id,code,name,status,account_type AS "accountType",bank,branch,account_number AS "accountNumber" FROM financial_accounts WHERE tenant_id=$1 AND id=$2`,
      [context.tenantId, accountId],
    )
  ).rows[0]
  if (!row) throw missing()
  return row
}
export async function assertOpenAccountPeriod(context: TenantContext, accountId: string, occurredOn: string) {
  const locked = await context.client.query(
    "SELECT 1 FROM finance_account_periods WHERE tenant_id=$1 AND account_id=$2 AND reopened_at IS NULL AND through_date >= $3 LIMIT 1",
    [context.tenantId, accountId, occurredOn],
  )
  if (locked.rows.length) throw conflict("O período desta conta está fechado")
}
export async function writableAccount(context: TenantContext, accountId: string, occurredOn: string) {
  const row = await account(context, accountId)
  if (row.status !== "active") throw conflict("A conta financeira está arquivada")
  await assertOpenAccountPeriod(context, accountId, occurredOn)
  const sessions = await context.client.query(
    "SELECT 1 FROM pos_sessions WHERE tenant_id=$1 AND cash_account_id=$2 AND status='open'",
    [context.tenantId, accountId],
  )
  if (sessions.rows.length)
    throw conflict("Esta conta tem caixa PDV aberto. Registre a movimentação pela sessão do PDV")
}
export async function loadLedger(context: TenantContext, query: z.infer<typeof ledgerQuery>) {
  const selected = await account(context, query.accountId)
  const params = [context.tenantId, query.accountId]
  const totals = (
    await context.client.query<{ credit: string; debit: string; total: number }>(
      `SELECT COALESCE(sum(amount_cents) FILTER(WHERE direction='credit'),0)::text credit,
    COALESCE(sum(amount_cents) FILTER(WHERE direction='debit'),0)::text debit,count(*)::integer total FROM financial_account_entries WHERE tenant_id=$1 AND account_id=$2`,
      params,
    )
  ).rows[0]!
  const entries = (
    await context.client.query(
      `SELECT ${entriesProjection} ${entriesFrom} WHERE e.tenant_id=$1 AND e.account_id=$2 ORDER BY e.occurred_on DESC,e.id DESC LIMIT $3 OFFSET $4`,
      [...params, query.limit, query.offset],
    )
  ).rows
  const { id, code, name, status, accountType } = selected
  return {
    account: { id, code, name, status, accountType },
    credit: money(totals.credit),
    debit: money(totals.debit),
    balance: money(BigInt(totals.credit) - BigInt(totals.debit)),
    entries,
    total: totals.total,
    offset: query.offset,
    limit: query.limit,
  }
}
export async function insertEntry(context: TenantContext, input: z.infer<typeof entrySchema>) {
  await writableAccount(context, input.accountId, input.occurredOn)
  if (input.categoryId) {
    const category = await context.client.query(
      "SELECT 1 FROM financial_categories WHERE tenant_id=$1 AND id=$2 AND status='active' AND direction=$3",
      [context.tenantId, input.categoryId, input.direction === "credit" ? "income" : "expense"],
    )
    if (!category.rows.length) throw conflict("Categoria incompatível com a direção do lançamento")
  }
  const entryId = randomUUID()
  await context.client.query(
    "INSERT INTO financial_account_entries(id,tenant_id,account_id,category_id,direction,amount_cents,occurred_on,description,reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      entryId,
      context.tenantId,
      input.accountId,
      input.categoryId,
      input.direction,
      fixed(input.amount, 2),
      input.occurredOn,
      input.description,
      input.reference,
    ],
  )
  const entry = (
    await context.client.query(`SELECT ${entriesProjection} ${entriesFrom} WHERE e.tenant_id=$1 AND e.id=$2`, [
      context.tenantId,
      entryId,
    ])
  ).rows[0]!
  return {
    id: entryId,
    result: { tenantId: context.tenantId, canEdit: true, data: entry },
    details: { accountId: input.accountId, direction: input.direction, amount: input.amount },
  }
}
export async function transfer(context: TenantContext, input: z.infer<typeof transferSchema>) {
  await writableAccount(context, input.sourceAccountId, input.occurredOn)
  await writableAccount(context, input.targetAccountId, input.occurredOn)
  const transferId = randomUUID(),
    sourceEntryId = randomUUID(),
    targetEntryId = randomUUID(),
    amount = fixed(input.amount, 2)
  await context.client.query(
    "INSERT INTO financial_account_transfers(id,tenant_id,source_account_id,target_account_id,amount_cents,occurred_on,description,reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      transferId,
      context.tenantId,
      input.sourceAccountId,
      input.targetAccountId,
      amount,
      input.occurredOn,
      input.description,
      input.reference,
    ],
  )
  await context.client.query(
    `INSERT INTO financial_account_entries(id,tenant_id,account_id,transfer_id,direction,amount_cents,occurred_on,description,reference)
    VALUES($1,$2,$3,$4,'debit',$5,$6,$7,$8),($9,$2,$10,$4,'credit',$5,$6,$7,$8)`,
    [
      sourceEntryId,
      context.tenantId,
      input.sourceAccountId,
      transferId,
      amount,
      input.occurredOn,
      input.description,
      input.reference,
      targetEntryId,
      input.targetAccountId,
    ],
  )
  return {
    id: transferId,
    result: { tenantId: context.tenantId, transferId, sourceEntryId, targetEntryId, amount: input.amount },
    details: { ...input, sourceEntryId, targetEntryId },
  }
}
