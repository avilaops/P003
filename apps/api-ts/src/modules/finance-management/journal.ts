import { randomUUID } from "node:crypto"
import { record } from "../../platform/commands.js"
import { conflict, missing, type Context, type Headers } from "./shared.js"

export const eventTypes = [
  "sale.invoice", "purchase.receipt", "commission.closing",
  "receivable.cash", "payable.cash", "receivable.non_cash", "payable.non_cash",
  "receivable.interest", "receivable.penalty", "receivable.surcharge", "receivable.discount",
  "payable.interest", "payable.penalty", "payable.surcharge", "payable.discount",
] as const

export async function openPeriod(context: Context, occurred: string) {
  const result = await context.client.query("SELECT closed FROM accounting_periods WHERE tenant_id=$1 AND month=date_trunc('month',$2::date)::date", [context.tenantId,occurred])
  if (result.rows[0]?.closed) conflict("A competência contábil está encerrada. Reabra o período para registrar esta operação.")
}
async function post(context: Context, headers: Headers, eventId: string, memo?: string) {
  const {client, tenantId} = context
  const row = (await client.query(`SELECT e.*, e.occurred_on::text AS day, existing.id AS posted_id,
    CASE WHEN e.reverses_event_id IS NULL THEN r.debit_id ELSE original.credit_id END AS debit,
    CASE WHEN e.reverses_event_id IS NULL THEN r.credit_id ELSE original.debit_id END AS credit,
    original.id AS original_id, previously_reversed.id AS previous_id
    FROM accounting_events e LEFT JOIN accounting_rules r ON r.tenant_id=e.tenant_id AND r.event_type=e.event_type
    LEFT JOIN accounting_entries existing ON existing.tenant_id=e.tenant_id AND existing.event_id=e.id
    LEFT JOIN accounting_entries original ON original.tenant_id=e.tenant_id AND original.event_id=e.reverses_event_id
    LEFT JOIN accounting_entries previously_reversed ON previously_reversed.tenant_id=e.tenant_id AND previously_reversed.reverses_entry_id=original.id
    WHERE e.tenant_id=$1 AND e.id=$2`, [tenantId,eventId])).rows[0]
  if (!row) missing()
  if (row.posted_id || row.previous_id || !row.debit || !row.credit) return
  await openPeriod(context,String(row.day))
  const id = randomUUID()
  await client.query(`INSERT INTO accounting_entries(tenant_id,id,event_id,debit_id,credit_id,occurred_on,amount_cents,reverses_entry_id,memo)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [tenantId,id,eventId,row.debit,row.credit,row.day,row.amount_cents,row.original_id,memo ?? row.event_type])
  await record(context,headers,"accounting_entry",id,row.original_id ? "accounting.reversed" : "accounting.posted",{sourceId:row.source_id,eventType:row.event_type,debitId:row.debit,creditId:row.credit,amountCents:row.amount_cents,reversesEntryId:row.original_id})
}
export async function capture(context: Context, headers: Headers, type: string, source: string, docType: string, docId: string, day: string, cents: unknown, original?: string, memo?: string) {
  if (BigInt(String(cents)) === 0n) return
  const { client,tenantId } = context
  const prior = (await client.query("SELECT id FROM accounting_events WHERE tenant_id=$1 AND event_type=$2 AND source_id=$3",[tenantId,type,source])).rows[0]
  if (prior) return post(context,headers,String(prior.id),memo)
  await openPeriod(context,day)
  const id = randomUUID()
  await client.query(`INSERT INTO accounting_events(tenant_id,id,event_type,source_id,document_type,document_id,occurred_on,amount_cents,reverses_event_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[tenantId,id,type,source,docType,docId,day,cents,original ?? null])
  await post(context,headers,id,memo)
}
export async function reverseSource(context: Context, headers: Headers, original: string, source: string, day: string, reason: string) {
  const rows = (await context.client.query("SELECT *,occurred_on::text AS day FROM accounting_events WHERE tenant_id=$1 AND source_id=$2 AND reverses_event_id IS NULL ORDER BY id", [context.tenantId,original])).rows
  for (const row of rows) {
    if (day<String(row.day)) conflict("A data do estorno contábil antecede o evento de origem")
    await capture(context,headers,String(row.event_type)+".reversal",source,String(row.document_type),String(row.document_id),day,row.amount_cents,String(row.id),reason)
  }
}
export const pendingFilter = `NOT EXISTS(SELECT 1 FROM accounting_entries j WHERE j.tenant_id=e.tenant_id AND j.event_id=e.id)
  AND NOT EXISTS(SELECT 1 FROM accounting_entries a JOIN accounting_entries b ON b.tenant_id=a.tenant_id AND b.reverses_entry_id=a.id WHERE a.tenant_id=e.tenant_id AND a.event_id=e.reverses_event_id)`
export async function postPending(context: Context, headers: Headers) {
  const pending = (await context.client.query(`SELECT id FROM accounting_events e WHERE tenant_id=$1 AND ${pendingFilter}
    ORDER BY (reverses_event_id IS NOT NULL),occurred_on,id`, [context.tenantId])).rows
  for (const row of pending) await post(context,headers,String(row.id))
}
export async function manualReverse(context: Context, headers: Headers, entry: string, occurredOn: string, reason: string) {
  const row = (await context.client.query(`SELECT j.event_id,j.amount_cents,j.occurred_on::text AS day,j.reverses_entry_id,e.document_type,e.document_id,
    EXISTS(SELECT 1 FROM accounting_entries WHERE tenant_id=j.tenant_id AND reverses_entry_id=j.id) AS reversed
    FROM accounting_entries j JOIN accounting_events e ON e.tenant_id=j.tenant_id AND e.id=j.event_id
    WHERE j.tenant_id=$1 AND j.id=$2`,[context.tenantId,entry])).rows[0]
  if (!row) missing()
  if (row.reversed || row.reverses_entry_id || occurredOn < String(row.day)) conflict("Confira o lançamento original, a data e seus estornos")
  await capture(context,headers,"manual.reversal",randomUUID(),String(row.document_type),String(row.document_id),occurredOn,row.amount_cents,String(row.event_id),reason)
}
