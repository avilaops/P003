import { capture, reverseSource } from "./journal.js"
import { missing, type Context, type Headers } from "./shared.js"

export async function postOperation(context: Context, headers: Headers, operationId: string) {
  const row = (
    await context.client.query(
      `SELECT side,kind,party_id,occurred_on::text AS day,principal_cents,interest_cents
    FROM finance_operations WHERE tenant_id=$1 AND id=$2 AND kind IN ('advance','restructure')`,
      [context.tenantId, operationId],
    )
  ).rows[0]
  if (!row) return
  const advance = row.kind === "advance"
  const type = String(row.side) + (advance ? ".advance" : ".restructure_interest")
  await capture(
    context,
    headers,
    type,
    operationId,
    "party",
    String(row.party_id),
    String(row.day),
    advance ? row.principal_cents : row.interest_cents,
  )
}
export async function postOperationReversal(context: Context, headers: Headers, operationId: string) {
  const row = (
    await context.client.query(
      "SELECT id,occurred_on::text AS day,reason FROM finance_operation_reversals WHERE tenant_id=$1 AND operation_id=$2",
      [context.tenantId, operationId],
    )
  ).rows[0]
  if (!row) missing()
  // An original may predate rule installation. Queue it before its inverse so both use the same accounts.
  await postOperation(context, headers, operationId)
  await reverseSource(context, headers, operationId, String(row.id), String(row.day), String(row.reason))
}
export async function postCollectionFee(context: Context, headers: Headers, chargeId: string) {
  const row = (
    await context.client.query(
      `SELECT e.id,e.amount_cents,e.occurred_on::text AS day,e.account_id FROM finance_collection_charges c
    JOIN financial_account_entries e ON (e.tenant_id,e.id)=(c.tenant_id,c.fee_entry_id)
    WHERE c.tenant_id=$1 AND c.id=$2 AND e.direction='debit'`,
      [context.tenantId, chargeId],
    )
  ).rows[0]
  if (!row) missing()
  await capture(
    context,
    headers,
    "collection.fee",
    String(row.id),
    "account",
    String(row.account_id),
    String(row.day),
    row.amount_cents,
  )
}
export async function recoverOperationPostings(context: Context, headers: Headers) {
  const { tenantId, client } = context
  const operations = await client.query(
    `SELECT o.id FROM finance_operations o WHERE o.tenant_id=$1
    AND (o.kind='advance' OR (o.kind='restructure' AND o.interest_cents>0))
    AND NOT EXISTS(SELECT 1 FROM accounting_events e WHERE e.tenant_id=o.tenant_id AND e.source_id=o.id
      AND e.event_type=o.side||CASE o.kind WHEN 'advance' THEN '.advance' ELSE '.restructure_interest' END)`,
    [tenantId],
  )
  for (const row of operations.rows) await postOperation(context, headers, String(row.id))
  const reversed = await client.query(
    `SELECT r.operation_id FROM finance_operation_reversals r JOIN finance_operations o
    ON (o.tenant_id,o.id)=(r.tenant_id,r.operation_id) WHERE r.tenant_id=$1 AND (o.kind='advance' OR (o.kind='restructure' AND o.interest_cents>0))
    AND NOT EXISTS(SELECT 1 FROM accounting_events e WHERE e.tenant_id=r.tenant_id AND e.source_id=r.id AND e.reverses_event_id IS NOT NULL)`,
    [tenantId],
  )
  for (const row of reversed.rows) await postOperationReversal(context, headers, String(row.operation_id))
  const fees = await client.query(
    `SELECT c.id FROM finance_collection_charges c WHERE c.tenant_id=$1 AND c.fee_entry_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM accounting_events e WHERE e.tenant_id=c.tenant_id AND e.source_id=c.fee_entry_id AND e.event_type='collection.fee')`,
    [tenantId],
  )
  for (const row of fees.rows) await postCollectionFee(context, headers, String(row.id))
}
