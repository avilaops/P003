import { randomUUID } from "node:crypto"
import { z } from "zod"
import { requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { normalizedDatabaseId as id } from "../../platform/database-id.js"
import { queryInteger } from "../registrations/query.js"
import { account, conflict, missing, textField } from "./ledger.js"

const candidate = z.strictObject({ id, cents: z.string().regex(/^[1-9]\d{0,18}$/), dueOn: z.iso.date() })
export const prepareBatchSchema = z.strictObject({
  accountId: id,
  reference: textField(1, 120),
  items: z
    .array(candidate)
    .min(1)
    .max(250)
    .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length),
})
export const cancelBatchSchema = z.strictObject({ batchId: id, reason: textField(3, 300) })
export const batchQuery = z.strictObject({
  batchId: id.optional(),
  q: z.string().trim().max(120).optional(),
  offset: queryInteger(0, 10000000).default(0),
  historyOffset: queryInteger(0, 10000000).default(0),
})
type Title = { id: string; partyId: string; name: string; cents: string; dueOn: string }
const eligible = `FROM finance_portfolio p WHERE p.tenant_id=$1 AND side='receivable' AND status='open' AND open_cents>0 AND party_id IS NOT NULL
  AND NOT EXISTS (SELECT FROM finance_collection_items ci WHERE (ci.tenant_id,ci.receivable_id)=(p.tenant_id,p.id))
  AND NOT EXISTS (SELECT FROM finance_collection_batch_items bi WHERE (bi.tenant_id,bi.receivable_id)=(p.tenant_id,p.id) AND bi.released_at IS NULL)
  AND NOT EXISTS (SELECT FROM finance_operation_items oi JOIN finance_active_operations op ON (op.tenant_id,op.id)=(oi.tenant_id,oi.operation_id)
    WHERE (oi.tenant_id,oi.receivable_id)=(p.tenant_id,p.id) AND op.kind='billing_group')`
const titleFields =
  'p.id,p.party_id AS "partyId",p.party_name AS name,p.open_cents::text AS cents,p.due_date::text AS "dueOn"'
const batchFields = `b.id,b.account_id AS "accountId",a.name AS "accountName",b.reference,b.created_at::text AS "createdAt",b.created_by AS "createdBy",
  b.cancelled_at::text AS "cancelledAt",b.cancelled_by AS "cancelledBy",b.cancel_reason AS "cancelReason"`
const batchJoin =
  "FROM finance_collection_batches b JOIN financial_accounts a ON (a.tenant_id,a.id)=(b.tenant_id,b.account_id)"

export async function readBatches(ctx: AuthorizedContext, query: z.output<typeof batchQuery>) {
  requirePermission(ctx, "finance.receivables.read")
  const tenant = ctx.tenantId
  if (query.batchId) {
    const batch = (
      await ctx.client.query(`SELECT ${batchFields} ${batchJoin} WHERE b.tenant_id=$1 AND b.id=$2`, [
        tenant,
        query.batchId,
      ])
    ).rows[0]
    if (!batch) throw missing()
    const items = (
      await ctx.client.query(
        `SELECT bi.receivable_id AS id,bi.party_id AS "partyId",bi.party_name AS name,
        bi.due_on::text AS "dueOn",bi.amount_cents::text AS cents,c.id AS "chargeId",c.method,c.provider_id AS "providerId",
        coalesce(c.settled_at,fi.settled_at)::text AS "settledAt", coalesce(CASE WHEN c.id IS NOT NULL THEN ci.payment_id END,fi.payment_id) AS "paymentId",
        coalesce(c.review_reason,fi.review_reason) AS "reviewReason",fi.our_number AS "cnabOurNumber",
        fi.reversal_id AS "reversedByPaymentId",rev.created_at::text AS "reversedAt",rev.reference AS "reversalReason",
        coalesce(fi.state,CASE WHEN bi.released_at IS NOT NULL THEN 'cancelled' ELSE coalesce(c.state,'selected') END) AS state,
        coalesce((SELECT jsonb_agg(jsonb_build_object('source',e.source,'key',e.event_key,'outcome',e.outcome,'at',e.created_at) ORDER BY e.created_at,e.source,e.event_key)
          FROM finance_collection_events e WHERE (e.tenant_id,e.charge_id)=(c.tenant_id,c.id)),'[]'::jsonb) ||
        coalesce((SELECT jsonb_agg(jsonb_build_object('source','cnab','key',e.occurrence,'outcome',e.outcome,'at',r.created_at)
          ORDER BY r.created_at,r.id,e.ordinal) FROM finance_collection_return_events e JOIN finance_collection_returns r ON (r.tenant_id,r.id)=(e.tenant_id,e.return_id)
          WHERE (e.tenant_id,e.profile_id,e.our_number,e.receivable_id)=(fi.tenant_id,fi.profile_id,fi.our_number,fi.receivable_id)),'[]'::jsonb)
        || CASE WHEN rev.id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object(
          'source','cnab_reversal','key',rev.id,'outcome','reversed','at',rev.created_at)) END AS events
      FROM finance_collection_batch_items bi
      LEFT JOIN finance_collection_items ci ON (ci.tenant_id,ci.receivable_id)=(bi.tenant_id,bi.receivable_id)
      LEFT JOIN finance_collection_charges c ON (c.tenant_id,c.id,c.batch_id)=(bi.tenant_id,ci.charge_id,bi.batch_id)
      LEFT JOIN finance_collection_remittance_items fi ON (fi.tenant_id,fi.batch_id,fi.receivable_id)=(bi.tenant_id,bi.batch_id,bi.receivable_id)
      LEFT JOIN receivable_payments rev ON (rev.tenant_id,rev.receivable_id,rev.id)=(fi.tenant_id,fi.receivable_id,fi.reversal_id)
      WHERE bi.tenant_id=$1 AND bi.batch_id=$2 ORDER BY bi.due_on,bi.party_name,bi.receivable_id`,
        [tenant, query.batchId],
      )
    ).rows
    return { batch, items, canIssue: ctx.permissions.includes("finance.receivables.manage") }
  }
  const accounts = (
    await ctx.client.query(
      "SELECT id,name FROM financial_accounts WHERE tenant_id=$1 AND status='active' AND account_type='bank' ORDER BY name,id",
      [tenant],
    )
  ).rows
  const candidates = (
    await ctx.client.query<Title>(
      `SELECT ${titleFields} ${eligible}
    AND ($2::text IS NULL OR strpos(lower(party_name),lower($2))>0 OR p.id::text=$2)
    ORDER BY p.due_date,p.id LIMIT 31 OFFSET $3`,
      [tenant, query.q || null, query.offset],
    )
  ).rows
  const history = (
    await ctx.client.query(
      `SELECT ${batchFields},
    (SELECT count(*)::int FROM finance_collection_batch_items i WHERE (i.tenant_id,i.batch_id)=(b.tenant_id,b.id)) AS count,
    (SELECT sum(i.amount_cents)::text FROM finance_collection_batch_items i WHERE (i.tenant_id,i.batch_id)=(b.tenant_id,b.id)) AS cents
    ${batchJoin} WHERE b.tenant_id=$1 ORDER BY b.created_at DESC,b.id DESC LIMIT 21 OFFSET $2`,
      [tenant, query.historyOffset],
    )
  ).rows
  return {
    accounts,
    candidates: candidates.slice(0, 30),
    more: candidates.length > 30,
    history: history.slice(0, 20),
    moreHistory: history.length > 20,
  }
}

export async function prepareBatch(ctx: AuthorizedContext, input: z.infer<typeof prepareBatchSchema>) {
  requirePermission(ctx, "finance.receivables.read")
  const bank = await account(ctx, input.accountId)
  if (bank.status !== "active" || bank.accountType !== "bank") throw conflict("Selecione uma conta bancária ativa")
  const titles = (
    await ctx.client.query<Title>(`SELECT ${titleFields} ${eligible} AND p.id=ANY($2::uuid[])`, [
      ctx.tenantId,
      input.items.map((i) => i.id),
    ])
  ).rows
  if (titles.length !== input.items.length)
    throw conflict("Há título indisponível, agrupado ou reservado em outra cobrança")
  const expected = new Map(input.items.map((i) => [i.id, i]))
  if (titles.some((t) => expected.get(t.id)?.cents !== t.cents || expected.get(t.id)?.dueOn !== t.dueOn))
    throw conflict("O saldo ou o vencimento mudou. Atualize a seleção do borderô")
  const batchId = randomUUID()
  await ctx.client.query(
    "INSERT INTO finance_collection_batches(tenant_id,id,account_id,reference,created_by) VALUES($1,$2,$3,$4,$5)",
    [ctx.tenantId, batchId, input.accountId, input.reference, ctx.authSubject],
  )
  await ctx.client.query(
    `INSERT INTO finance_collection_batch_items(tenant_id,batch_id,receivable_id,party_id,party_name,amount_cents,due_on)
    SELECT $1,$2,id,"partyId",name,cents,"dueOn" FROM jsonb_to_recordset($3::jsonb) AS t(id uuid,"partyId" uuid,name text,cents bigint,"dueOn" date)`,
    [ctx.tenantId, batchId, JSON.stringify(titles)],
  )
  return {
    id: batchId,
    result: { tenantId: ctx.tenantId, data: { id: batchId } },
    details: { accountId: bank.id, count: titles.length },
  }
}

export async function cancelBatch(ctx: AuthorizedContext, input: z.infer<typeof cancelBatchSchema>) {
  requirePermission(ctx, "finance.receivables.read")
  const batch = (
    await ctx.client.query("SELECT cancelled_at FROM finance_collection_batches WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
      ctx.tenantId,
      input.batchId,
    ])
  ).rows[0]
  if (!batch) throw missing()
  if (batch.cancelled_at) throw conflict("O borderô já foi cancelado")
  const started = await ctx.client.query(
    `SELECT FROM finance_collection_charges WHERE tenant_id=$1 AND batch_id=$2
     UNION ALL SELECT FROM finance_collection_remittances WHERE tenant_id=$1 AND batch_id=$2 LIMIT 1`,
    [ctx.tenantId, input.batchId],
  )
  if (started.rows.length) throw conflict("A emissão de uma cobrança já começou neste borderô")
  await ctx.client.query(
    "UPDATE finance_collection_batches SET cancelled_at=now(),cancelled_by=$3,cancel_reason=$4 WHERE tenant_id=$1 AND id=$2",
    [ctx.tenantId, input.batchId, ctx.authSubject, input.reason],
  )
  await ctx.client.query(
    "UPDATE finance_collection_batch_items SET released_at=now() WHERE tenant_id=$1 AND batch_id=$2",
    [ctx.tenantId, input.batchId],
  )
  return {
    id: input.batchId,
    result: { tenantId: ctx.tenantId, data: { id: input.batchId, cancelled: true } },
    details: { reason: input.reason },
  }
}
