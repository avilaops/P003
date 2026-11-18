import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { normalizedDatabaseId as id } from "../../platform/database-id.js"
import { queryInteger } from "../registrations/query.js"
import { account, assertOpenAccountPeriod, conflict, date, insertEntry, invalid, missing, money, textField } from "./ledger.js"
import { parseOfx } from "./ofx.js"
import { parseEfiStatement } from "./efi-cnab.js"

export const importSchema = z.strictObject({
  accountId: id,
  content: z.string().min(20).max(2_000_000),
  autoMatch: z.boolean().optional(),
})
export const matchSchema = z.strictObject({
  accountId: id,
  lineId: id,
  entryIds: z
    .array(id)
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
  reason: textField(3, 500).nullable().optional(),
})
export const exceptionSchema = z.strictObject({ accountId: id, lineId: id, reason: textField(3, 500) })
export const classifySchema = exceptionSchema.extend({ categoryId: id.nullish() })
export const periodSchema = z.strictObject({ accountId: id, throughDate: date, reason: textField(3, 500) })
export const reconciliationQuery = z.strictObject({
  accountId: id,
  offset: queryInteger(0, 1_000_000).default(0),
  entryOffset: queryInteger(0, 1_000_000).default(0),
  throughDate: date.optional(),
})
const envelope = (context: AuthorizedContext, id: string, data: Record<string, unknown>) => ({
  id,
  result: { tenantId: context.tenantId, data },
  details: data,
})
const unmatched = "NOT EXISTS(SELECT 1 FROM finance_bank_matches m WHERE m.tenant_id=e.tenant_id AND m.entry_id=e.id)"
const signed = "(CASE WHEN e.direction='credit' THEN e.amount_cents ELSE -e.amount_cents END)"
const sameDocument = `EXISTS (
  SELECT 1 FROM unnest(l.document_references) AS doc(ref) WHERE lower(doc.ref)=lower(btrim(e.reference))
)`
const accountNumber = (value: string) =>
  value
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase()
    .replace(/^0+(?=\d)/, "")

export async function importStatement(
  context: AuthorizedContext,
  input: z.infer<typeof importSchema>,
  format: "ofx" | "efi" = "ofx",
) {
  const selected = await account(context, input.accountId),
    parsed = format === "efi" ? parseEfiStatement(input.content) : parseOfx(input.content)
  if (
    selected.accountType !== "bank" ||
    selected.status !== "active" ||
    !selected.accountNumber ||
    accountNumber(selected.accountNumber) !== accountNumber(parsed.bankAccount)
  )
    throw conflict("O número do extrato deve corresponder à conta bancária ativa cadastrada")
  const params = [context.tenantId, input.accountId],
    digest = createHash("sha256").update(input.content).digest("hex")
  const existing = (
    await context.client.query<{ id: string }>(
      "SELECT id FROM finance_bank_statements WHERE tenant_id=$1 AND account_id=$2 AND digest=$3",
      [...params, digest],
    )
  ).rows[0]
  if (existing) return envelope(context, existing.id, { statementId: existing.id, imported: 0, duplicate: true })
  const differentBank = await context.client.query(
    "SELECT 1 FROM finance_bank_statements WHERE tenant_id=$1 AND account_id=$2 AND bank_id<>$3 LIMIT 1",
    [...params, parsed.bankId],
  )
  if (
    differentBank.rows.length ||
    (selected.bank && /^\d{3}$/.test(selected.bank) && Number(selected.bank) !== Number(parsed.bankId))
  )
    throw conflict("O banco informado no OFX diverge da instituição da conta")
  await assertOpenAccountPeriod(context, input.accountId, parsed.end)
  const statementId = randomUUID()
  await context.client.query(
    `INSERT INTO finance_bank_statements(tenant_id,account_id,id,bank_id,bank_account,digest,from_date,through_date,closing_cents,imported_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      ...params,
      statementId,
      parsed.bankId,
      parsed.bankAccount,
      digest,
      parsed.start,
      parsed.end,
      parsed.balance,
      context.authSubject,
    ],
  )
  let imported = 0
  for (const line of parsed.lines) {
    const previous = (
      await context.client.query<{ booked: string; amount: string; description: string; documents: string[] | null }>(
        `SELECT booked_on::text booked,signed_cents::text amount,description,document_references AS documents
        FROM finance_bank_lines WHERE tenant_id=$1 AND account_id=$2 AND fit_id=$3`,
        [...params, line.fitId],
      )
    ).rows[0]
    if (previous) {
      if (
        previous.booked !== line.bookedOn ||
        previous.amount !== String(line.signedCents) ||
        previous.description !== line.description ||
        (previous.documents !== null && JSON.stringify(previous.documents) !== JSON.stringify(line.documentReferences))
      )
        throw conflict("O banco reapresentou o mesmo FITID com dados diferentes • " + line.fitId)
      continue
    }
    await assertOpenAccountPeriod(context, input.accountId, line.bookedOn)
    await context.client.query(
      `INSERT INTO finance_bank_lines(tenant_id,account_id,id,statement_id,fit_id,booked_on,signed_cents,description,document_references)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [...params, randomUUID(), statementId, line.fitId, line.bookedOn, line.signedCents, line.description, line.documentReferences],
    )
    imported++
  }
  let matched = 0
  if (input.autoMatch && imported) {
    const pairs = await context.client.query<{ line_id: string; entry_id: string }>(
      `
      WITH pending AS (
        SELECT id,statement_id,booked_on,signed_cents,document_references,count(*) OVER(PARTITION BY booked_on,signed_cents) AS alternatives
        FROM finance_bank_lines WHERE tenant_id=$1 AND account_id=$2 AND state='pending' AND booked_on BETWEEN $4 AND $5
      ), entries AS (
        SELECT e.id,e.occurred_on,e.reference,${signed} AS amount,count(*) OVER(PARTITION BY occurred_on,${signed}) AS alternatives
        FROM financial_account_entries e WHERE e.tenant_id=$1 AND e.account_id=$2 AND e.occurred_on BETWEEN $4 AND $5 AND ${unmatched}
      ) SELECT l.id AS line_id,e.id AS entry_id FROM pending l JOIN entries e ON l.booked_on=e.occurred_on AND l.signed_cents=e.amount
        WHERE l.statement_id=$3 AND l.alternatives=1 AND e.alternatives=1
          AND (COALESCE(cardinality(l.document_references),0)=0 OR NULLIF(btrim(e.reference),'') IS NULL OR ${sameDocument})`,
      [...params, statementId, parsed.start, parsed.end],
    )
    if (pairs.rows.length) {
      const lines = pairs.rows.map((p) => p.line_id),
        entries = pairs.rows.map((p) => p.entry_id)
      await context.client.query(
        "INSERT INTO finance_bank_matches(tenant_id,line_id,entry_id) SELECT $1,l,e FROM unnest($2::uuid[],$3::uuid[]) AS pair(l,e)",
        [context.tenantId, lines, entries],
      )
      await context.client.query(
        "UPDATE finance_bank_lines SET state='matched',reviewed_at=now(),reviewed_by=$3,reason='Correspondência única por conta, data e valor' WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
        [context.tenantId, lines, context.authSubject],
      )
      matched = lines.length
    }
  }
  return envelope(context, statementId, {
    statementId,
    imported,
    matched,
    duplicate: false,
    existing: parsed.lines.length - imported,
  })
}
export async function reconciliation(context: AuthorizedContext, input: z.infer<typeof reconciliationQuery>) {
  await account(context, input.accountId)
  const params = [context.tenantId, input.accountId, input.throughDate ?? "2100-12-31"]
  const lines = (
    await context.client.query<{ id: string; suggestedEntries: { id: string }[] }>(
      `SELECT l.id,l.fit_id AS "fitId",l.booked_on::text AS "bookedOn",l.signed_cents::text AS cents,l.description,l.state,l.reason,
    COALESCE(l.document_references,'{}') AS "documentReferences",
    ARRAY(SELECT m.entry_id FROM finance_bank_matches m WHERE m.tenant_id=l.tenant_id AND m.line_id=l.id) AS "entryIds",
    (SELECT COALESCE(jsonb_agg(candidate ORDER BY candidate."documentMatch" DESC,candidate.id),'[]'::jsonb)
     FROM (SELECT e.id,e.occurred_on::text AS "occurredOn",${signed}::text AS cents,e.description,e.reference,
             ${sameDocument} AS "documentMatch"
           FROM financial_account_entries e WHERE l.state='pending' AND e.tenant_id=l.tenant_id AND e.account_id=l.account_id
             AND e.occurred_on=l.booked_on AND ${signed}=l.signed_cents AND ${unmatched}
           ORDER BY "documentMatch" DESC,e.id LIMIT 10) candidate) AS "suggestedEntries"
    FROM finance_bank_lines l WHERE l.tenant_id=$1 AND l.account_id=$2 AND l.booked_on<=$3 ORDER BY (l.state='pending') DESC,l.booked_on DESC,l.id LIMIT 50 OFFSET $4`,
      [...params, input.offset],
    )
  ).rows
  const entries = (
    await context.client.query(
      `SELECT e.id,e.occurred_on::text AS "occurredOn",${signed}::text cents,e.description,e.reference FROM financial_account_entries e
    WHERE e.tenant_id=$1 AND e.account_id=$2 AND e.occurred_on<=$3 AND ${unmatched} ORDER BY e.occurred_on DESC,e.id LIMIT 100 OFFSET $4`,
      [...params, input.entryOffset],
    )
  ).rows
  const periods = (
    await context.client.query(
      `SELECT through_date::text AS "throughDate",reason,closed_by AS "closedBy",reopen_reason AS "reopenReason",
    reopened_at AS "reopenedAt",reopened_by AS "reopenedBy" FROM finance_account_periods WHERE tenant_id=$1 AND account_id=$2 ORDER BY closed_at DESC LIMIT 50`,
      params.slice(0, 2),
    )
  ).rows
  const bank =
    (
      await context.client.query(
        `SELECT through_date::text AS "throughDate",closing_cents::text AS cents FROM finance_bank_statements
    WHERE tenant_id=$1 AND account_id=$2 AND through_date<=$3 AND closing_cents IS NOT NULL ORDER BY through_date DESC,imported_at DESC LIMIT 1`,
        params,
      )
    ).rows[0] ?? null
  const sessions = (
    await context.client.query(
      `SELECT id,register,status,opened_at AS "openedAt",closed_at AS "closedAt",counted_cents::text AS "countedCents"
    FROM pos_sessions WHERE tenant_id=$1 AND cash_account_id=$2 ORDER BY opened_at DESC LIMIT 30`,
      params.slice(0, 2),
    )
  ).rows
  return {
    lines: lines.map((line) => ({ ...line, suggestions: line.suggestedEntries.map((entry) => entry.id) })),
    entries,
    periods,
    bank,
    sessions,
    canClose: context.permissions.includes("finance.reconciliation.close"),
    canReopen: context.permissions.includes("finance.reconciliation.reopen"),
  }
}
async function lineForReview(context: AuthorizedContext, accountId: string, lineId: string) {
  const line = (
    await context.client.query<{ state: string; booked: string; amount: string }>(
      "SELECT state,booked_on::text booked,signed_cents::text amount FROM finance_bank_lines WHERE tenant_id=$1 AND account_id=$2 AND id=$3 FOR UPDATE",
      [context.tenantId, accountId, lineId],
    )
  ).rows[0]
  if (!line) throw missing()
  await assertOpenAccountPeriod(context, accountId, line.booked)
  if (line.state === "matched") throw conflict("Esta linha já foi conciliada")
  return line
}
export async function match(context: AuthorizedContext, input: z.infer<typeof matchSchema>) {
  const line = await lineForReview(context, input.accountId, input.lineId)
  const entries = (
    await context.client.query<{ amount: string; date: string }>(
      `SELECT ${signed}::text amount,e.occurred_on::text date FROM financial_account_entries e WHERE e.tenant_id=$1 AND e.account_id=$2 AND e.id=ANY($3::uuid[]) AND ${unmatched}`,
      [context.tenantId, input.accountId, input.entryIds],
    )
  ).rows
  if (entries.length !== input.entryIds.length) throw conflict("Escolha movimentos disponíveis desta conta")
  for (const date of new Set(entries.map((e) => e.date))) await assertOpenAccountPeriod(context, input.accountId, date)
  const total = entries.reduce((sum, e) => sum + BigInt(e.amount), 0n)
  const difference = BigInt(line.amount) - total
  if (difference && !input.reason) throw conflict("Informe uma justificativa para a diferença de R$ " + money(difference))
  await context.client.query("INSERT INTO finance_bank_matches(tenant_id,line_id,entry_id) SELECT $1,$2,unnest($3::uuid[])", [
    context.tenantId,
    input.lineId,
    input.entryIds,
  ])
  await context.client.query(
    "UPDATE finance_bank_lines SET state='matched',reason=$3,reviewed_by=$4,reviewed_at=now() WHERE tenant_id=$1 AND id=$2",
    [context.tenantId, input.lineId, input.reason ?? null, context.authSubject],
  )
  return envelope(context, input.lineId, {
    lineId: input.lineId,
    entryIds: input.entryIds,
    difference: money(difference),
    reason: input.reason ?? null,
  })
}
export async function classifyAndMatch(context: AuthorizedContext, input: z.infer<typeof classifySchema>) {
  if (input.reason.length > 200) throw invalid("O histórico do movimento admite até 200 caracteres")
  const line = await lineForReview(context, input.accountId, input.lineId)
  const signed = BigInt(line.amount)
  const movement = await insertEntry(context, {
    accountId: input.accountId,
    direction: signed > 0n ? "credit" : "debit",
    amount: money(signed > 0n ? signed : -signed),
    occurredOn: line.booked,
    description: input.reason,
    reference: input.lineId,
    categoryId: input.categoryId ?? null,
  })
  return match(context, { accountId: input.accountId, lineId: input.lineId, entryIds: [movement.id], reason: input.reason })
}
export async function exception(context: AuthorizedContext, input: z.infer<typeof exceptionSchema>) {
  await lineForReview(context, input.accountId, input.lineId)
  await context.client.query(
    "UPDATE finance_bank_lines SET state='exception',reason=$3,reviewed_by=$4,reviewed_at=now() WHERE tenant_id=$1 AND id=$2",
    [context.tenantId, input.lineId, input.reason, context.authSubject],
  )
  return envelope(context, input.lineId, { lineId: input.lineId, reason: input.reason })
}
export async function period(context: AuthorizedContext, input: z.infer<typeof periodSchema>, reopen: boolean) {
  const selected = await account(context, input.accountId),
    params = [context.tenantId, input.accountId, input.throughDate]
  await context.client.query("SELECT 1 FROM financial_accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE", params.slice(0, 2))
  const latest = (
    await context.client.query<{ id: string; end: string }>(
      "SELECT id,through_date::text AS end FROM finance_account_periods WHERE tenant_id=$1 AND account_id=$2 AND reopened_at IS NULL ORDER BY through_date DESC LIMIT 1",
      params.slice(0, 2),
    )
  ).rows[0]
  if (reopen) {
    if (!latest || latest.end !== input.throughDate) throw conflict("Selecione o último período fechado da conta")
    await context.client.query(
      "UPDATE finance_account_periods SET reopened_by=$3,reopened_at=now(),reopen_reason=$4 WHERE tenant_id=$1 AND id=$2",
      [context.tenantId, latest.id, context.authSubject, input.reason],
    )
    return envelope(context, latest.id, { ...input, reopened: true })
  }
  if (latest && latest.end >= input.throughDate) throw conflict("A data informada já está encerrada")
  const future = (
    await context.client.query("SELECT 1 WHERE $1::date > (now() AT TIME ZONE 'America/Sao_Paulo')::date", [input.throughDate])
  ).rows.length
  if (future) throw invalid("Fechamento exige data até hoje")
  const openCash = await context.client.query(
    "SELECT 1 FROM pos_sessions WHERE tenant_id=$1 AND cash_account_id=$2 AND status='open' AND (opened_at AT TIME ZONE 'America/Sao_Paulo')::date<=$3",
    params,
  )
  if (openCash.rows.length) throw conflict("Feche primeiro a sessão do PDV")
  if (selected.accountType === "bank") {
    const covered = await context.client.query(
      `SELECT 1 FROM finance_bank_statements WHERE tenant_id=$1 AND account_id=$2
      HAVING range_agg(daterange(from_date,through_date,'[]')) @> daterange(coalesce($4::date+1,$3::date),$3::date,'[]')`,
      [...params, latest?.end ?? null],
    )
    const pending = await context.client.query(
      `SELECT 1 FROM finance_bank_lines WHERE tenant_id=$1 AND account_id=$2 AND booked_on<=$3 AND state='pending'
      UNION ALL SELECT 1 FROM financial_account_entries e WHERE e.tenant_id=$1 AND e.account_id=$2 AND e.occurred_on<=$3 AND ${unmatched} LIMIT 1`,
      params,
    )
    if (!covered.rows.length || pending.rows.length)
      throw conflict("Importe o extrato até a data e trate as pendências da conta antes do fechamento")
  }
  const periodId = randomUUID()
  await context.client.query(
    "INSERT INTO finance_account_periods(tenant_id,account_id,through_date,id,closed_by,reason) VALUES($1,$2,$3,$4,$5,$6)",
    [...params, periodId, context.authSubject, input.reason],
  )
  return envelope(context, periodId, { ...input, reopened: false })
}
