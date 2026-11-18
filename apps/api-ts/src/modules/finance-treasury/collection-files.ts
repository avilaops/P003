import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { normalizedDatabaseId as id } from "../../platform/database-id.js"
import { canonicalJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue } from "../../platform/revision.js"
import { capture } from "../finance-management/journal.js"
import { applyWalletPayment } from "../finance-wallets/settlements.js"
import { queryInteger } from "../registrations/query.js"
import type { Headers } from "./collections.js"
import { account, conflict, invalid, missing, money, textField } from "./ledger.js"
import {
  parseSantander240,
  readSantanderReturnSource,
  santanderOurNumber,
  serializeSantander240,
  validateSantanderProfile,
  type SantanderProfile,
  type SantanderReturnEvent,
  type SantanderTitle,
} from "./santander-240.js"

export const generateCollectionFileSchema = z.strictObject({ accountId: id, batchId: id })
export const collectionFileQuery = z.strictObject({
  accountId: id,
  batchId: id.optional(),
  offset: queryInteger(0, 10000000).default(0),
})
const rate = z.number().int().min(0).max(10000).default(0)
export const collectionProfileSchema = z.strictObject({
  accountId: id,
  name: textField(1, 30),
  taxId: z.string().regex(/^(?:\d{11}|[0-9A-Z]{12}\d{2})$/),
  transmissionCode: z.string().regex(/^\d{15}$/),
  beneficiaryCode: z.string().regex(/^\d{9}$/),
  agency: z.string().regex(/^\d{4}$/),
  agencyDigit: z.string().regex(/^\d$/),
  account: z.string().regex(/^\d{9}$/),
  accountDigit: z.string().regex(/^\d$/),
  firstSequence: z.number().int().min(1).max(999999).optional(),
  firstOurNumber: z
    .string()
    .regex(/^\d{1,12}$/)
    .refine((v) => BigInt(v) > 0n)
    .optional(),
  interestMonthlyBps: rate,
  fineBps: rate,
})
export const importCollectionFileSchema = z.strictObject({
  accountId: id,
  content: z.string().min(240).max(2000000),
  fileName: textField(1, 160)
    .regex(/^[\p{L}\p{N} _().-]+$/u)
    .optional(),
})

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const manage = (ctx: AuthorizedContext) =>
  ctx.permissions.includes("finance.collections.manage") && ctx.permissions.includes("finance.receivables.manage")
export function rights(ctx: AuthorizedContext, write = false) {
  requirePermission(ctx, "finance.collections.read")
  requirePermission(ctx, "finance.receivables.read")
  if (write) {
    requirePermission(ctx, "finance.collections.manage")
    requirePermission(ctx, "finance.receivables.manage")
  }
}
export type ProfileRow = {
  id: string
  accountId: string
  profile: SantanderProfile
  nextSequence: number
  nextOurNumber: string
}
export const profileFields =
  'id,account_id AS "accountId",profile,next_sequence AS "nextSequence",next_our_number::text AS "nextOurNumber"'
const viewProfile = ({ profile, ...row }: ProfileRow) => ({ ...row, ...profile })
const remittanceFields = `f.id,f.batch_id AS "batchId",f.filename,f.sequence,f.item_count AS count,f.amount_cents::text AS cents,f.sha256,
  f.created_at::text AS "createdAt",f.created_by AS "createdBy"`
const returnFields = `f.id,f.filename,f.sequence,f.item_count AS count,f.sha256,f.created_at::text AS "createdAt",f.created_by AS "createdBy",
  coalesce((SELECT jsonb_agg(jsonb_build_object('ordinal',e.ordinal,'ourNumber',e.our_number,'occurrence',e.occurrence,'state',e.outcome,'reason',e.reason,
    'receivableId',e.receivable_id,'nominalCents',e.evidence->>'nominalCents','paidCents',e.evidence->>'paidCents',
    'netCents',e.evidence->>'netCents','feeCents',e.evidence->>'feeCents','occurredOn',e.evidence->>'occurredOn','creditOn',e.evidence->>'creditOn',
    'reviews',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'state',r.state,'reason',r.reason,'reviewReason',r.review_reason,
      'createdAt',r.created_at,'createdBy',r.created_by) ORDER BY r.created_at,r.id) FROM finance_collection_return_reviews r
      WHERE (r.tenant_id,r.return_id,r.ordinal)=(e.tenant_id,e.return_id,e.ordinal)),'[]'::jsonb)) ORDER BY e.ordinal) FROM finance_collection_return_events e
    WHERE (e.tenant_id,e.return_id)=(f.tenant_id,f.id)), '[]'::jsonb) AS outcomes`
async function company(ctx: AuthorizedContext) {
  return (
    await ctx.client.query<{ taxId: string; name: string }>(
      'SELECT tax_id AS "taxId",legal_name AS name FROM tenants WHERE id=$1',
      [ctx.tenantId],
    )
  ).rows[0]!
}
type Bank = Awaited<ReturnType<typeof account>>
function checkBank(bank: Bank, profile: SantanderProfile, tenantTaxId: string) {
  if (bank.status !== "active" || bank.accountType !== "bank") throw conflict("Selecione uma conta bancária ativa")
  const name = bank.bank?.trim() ?? ""
  const bankCode = name.match(/\b\d{3}\b/)?.[0]
  if (bankCode ? bankCode !== "033" : !/\bsantander\b/i.test(name))
    throw conflict("Informe o Santander (033) como instituição no cadastro da conta financeira")
  const sameNumber = (raw: string, expected: string) =>
    /^\d+$/.test(raw) && raw.replace(/^0+(?=\d)/, "") === expected.replace(/^0+(?=\d)/, "")
  const branch = (bank.branch ?? "").replace(/\s/g, "")
  const branchWithDigit = profile.agency + profile.agencyDigit
  const accountDigits = (bank.accountNumber ?? "").replace(/[-.\s]/g, "")
  const branchOk = /^\d+-\d$/.test(branch)
    ? sameNumber(branch.replace("-", ""), branchWithDigit)
    : sameNumber(branch, profile.agency) || sameNumber(branch, branchWithDigit)
  if (!branchOk || !sameNumber(accountDigits, profile.account + profile.accountDigit))
    throw conflict("Confira a agência e a conta com dígito no cadastro financeiro e no convênio")
  if (tenantTaxId !== profile.taxId) throw conflict("A inscrição do beneficiário deve pertencer à empresa ativa")
}
export async function checkCollectionBank(ctx: AuthorizedContext, accountId: string, profile: SantanderProfile) {
  checkBank(await account(ctx, accountId), profile, (await company(ctx)).taxId)
}
export async function readCollectionFiles(ctx: AuthorizedContext, input: z.output<typeof collectionFileQuery>) {
  rights(ctx)
  const { accountId, batchId, offset } = input
  const bank = await account(ctx, accountId)
  if (
    batchId &&
    !(
      await ctx.client.query(
        "SELECT id FROM finance_collection_batches WHERE tenant_id=$1 AND account_id=$2 AND id=$3",
        [ctx.tenantId, accountId, batchId],
      )
    ).rows.length
  )
    throw missing()
  const row = (
    await ctx.client.query<ProfileRow>(
      `SELECT ${profileFields} FROM finance_collection_file_profiles WHERE tenant_id=$1 AND account_id=$2 AND active`,
      [ctx.tenantId, accountId],
    )
  ).rows[0]
  const params = [ctx.tenantId, accountId, batchId ?? null, offset]
  const remittances = (
    await ctx.client.query(
      `SELECT ${remittanceFields} FROM finance_collection_remittances f
    WHERE f.tenant_id=$1 AND f.account_id=$2 AND ($3::uuid IS NULL OR f.batch_id=$3) ORDER BY f.created_at DESC,f.id DESC LIMIT 21 OFFSET $4`,
      params,
    )
  ).rows
  const returns = (
    await ctx.client.query(
      `SELECT ${returnFields} FROM finance_collection_returns f
    WHERE f.tenant_id=$1 AND f.account_id=$2 AND ($3::uuid IS NULL OR EXISTS(SELECT FROM finance_collection_return_events e
      JOIN finance_collection_remittance_items i ON (i.tenant_id,i.profile_id,i.our_number,i.receivable_id)=(e.tenant_id,e.profile_id,e.our_number,e.receivable_id)
      WHERE (e.tenant_id,e.return_id)=(f.tenant_id,f.id) AND i.batch_id=$3))
    ORDER BY f.created_at DESC,f.id DESC LIMIT 21 OFFSET $4`,
      params,
    )
  ).rows
  return {
    account: bank,
    company: await company(ctx),
    profile: row ? viewProfile(row) : null,
    canManage: manage(ctx),
    remittances: remittances.slice(0, 20),
    returns: returns.slice(0, 20),
    moreRemittances: remittances.length > 20,
    moreReturns: returns.length > 20,
  }
}
export async function saveCollectionProfile(ctx: AuthorizedContext, input: z.output<typeof collectionProfileSchema>) {
  rights(ctx, true)
  const { accountId, firstSequence, firstOurNumber, ...profile } = input
  validateSantanderProfile(profile)
  checkBank(await account(ctx, accountId), profile, (await company(ctx)).taxId)
  const args = [ctx.tenantId, accountId, profile.beneficiaryCode]
  const otherBinding = await ctx.client.query(
    `SELECT FROM finance_collection_file_profiles WHERE tenant_id=$1 AND account_id<>$2 AND beneficiary_code=$3
     AND profile @> $4::jsonb LIMIT 1`,
    [
      ...args,
      {
        taxId: profile.taxId,
        agency: profile.agency,
        agencyDigit: profile.agencyDigit,
        account: profile.account,
        accountDigit: profile.accountDigit,
      },
    ],
  )
  if (otherBinding.rows.length) throw conflict("Este convênio bancário já pertence a outra conta financeira da empresa")
  const previous = (
    await ctx.client.query<ProfileRow>(
      `SELECT ${profileFields} FROM finance_collection_file_profiles
    WHERE tenant_id=$1 AND account_id=$2 AND beneficiary_code=$3 FOR UPDATE`,
      args,
    )
  ).rows[0]
  if (previous && (firstSequence !== undefined || firstOurNumber !== undefined))
    throw conflict("Os números iniciais só podem ser definidos ao cadastrar um convênio")
  if (
    previous &&
    (
      await ctx.client.query(
        "SELECT FROM finance_collection_remittances WHERE tenant_id=$1 AND profile_id=$2 LIMIT 1",
        [ctx.tenantId, previous.id],
      )
    ).rows.length
  ) {
    for (const key of ["agency", "agencyDigit", "account", "accountDigit", "taxId"] as const)
      if (previous.profile[key] !== profile[key])
        throw conflict("Este convênio possui remessas com outra identificação bancária")
  }
  await ctx.client.query(
    "UPDATE finance_collection_file_profiles SET active=false WHERE tenant_id=$1 AND account_id=$2 AND active AND beneficiary_code<>$3",
    args,
  )
  const saved = (
    await ctx.client.query<ProfileRow>(
      `INSERT INTO finance_collection_file_profiles(tenant_id,account_id,beneficiary_code,id,profile,next_sequence,next_our_number)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,account_id,beneficiary_code) DO UPDATE SET active=true,profile=excluded.profile RETURNING ${profileFields}`,
      [...args, randomUUID(), profile, firstSequence ?? 1, firstOurNumber ?? "1"],
    )
  ).rows[0]!
  return {
    id: saved.id,
    result: { tenantId: ctx.tenantId, data: viewProfile(saved) },
    details: { accountId, beneficiaryCode: profile.beneficiaryCode },
  }
}

type BatchItem = {
  id: string
  dueOn: string
  cents: string
  available: boolean
  taxId: string
  name: string
  addresses: {
    primary?: boolean
    street: string
    number: string
    district: string
    postalCode: string
    city: string
    state: string
  }[]
}
export async function generateCollectionFile(
  ctx: AuthorizedContext,
  input: z.output<typeof generateCollectionFileSchema>,
) {
  rights(ctx, true)
  const { accountId, batchId } = input,
    params = [ctx.tenantId, accountId, batchId]
  const batch = (
    await ctx.client.query(
      `SELECT cancelled_at,(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date::text AS today
    FROM finance_collection_batches WHERE tenant_id=$1 AND account_id=$2 AND id=$3 FOR UPDATE`,
      params,
    )
  ).rows[0]
  if (!batch) throw missing()
  const existing = (
    await ctx.client.query(
      `SELECT ${remittanceFields} FROM finance_collection_remittances f WHERE tenant_id=$1 AND account_id=$2 AND batch_id=$3`,
      params,
    )
  ).rows[0]
  if (existing)
    return {
      id: String(existing.id),
      result: { tenantId: ctx.tenantId, data: existing },
      details: { accountId, batchId, duplicate: true },
    }
  if (batch.cancelled_at) throw conflict("O borderô foi cancelado")
  const row = (
    await ctx.client.query<ProfileRow>(
      `SELECT ${profileFields} FROM finance_collection_file_profiles
    WHERE tenant_id=$1 AND account_id=$2 AND active FOR UPDATE`,
      [ctx.tenantId, accountId],
    )
  ).rows[0]
  if (!row) throw conflict("Cadastre o convênio Santander da conta para gerar a remessa")
  checkBank(await account(ctx, accountId), row.profile, (await company(ctx)).taxId)
  const items = (
    await ctx.client.query<BatchItem>(
      `SELECT b.receivable_id AS id,b.due_on::text AS "dueOn",b.amount_cents::text AS cents,
    (p.status='open' AND p.party_id=b.party_id AND p.open_cents=b.amount_cents AND p.due_date=b.due_on AND b.released_at IS NULL
       AND NOT EXISTS (SELECT FROM finance_collection_items c WHERE (c.tenant_id,c.receivable_id)=(b.tenant_id,b.receivable_id))
       AND NOT EXISTS (SELECT FROM finance_operation_items oi JOIN finance_active_operations op ON (op.tenant_id,op.id)=(oi.tenant_id,oi.operation_id)
          WHERE (oi.tenant_id,oi.receivable_id)=(b.tenant_id,b.receivable_id) AND op.kind='billing_group')) AS available,
    t.tax_id AS "taxId",t.legal_name AS name,t.addresses
    FROM finance_collection_batch_items b LEFT JOIN finance_portfolio p ON (p.tenant_id,p.id)=(b.tenant_id,b.receivable_id) AND p.side='receivable'
    JOIN parties t ON (t.tenant_id,t.id)=(b.tenant_id,b.party_id)
    WHERE b.tenant_id=$1 AND b.batch_id=$2 ORDER BY b.due_on,b.receivable_id`,
      [ctx.tenantId, batchId],
    )
  ).rows
  if (!items.length || items.some((item) => !item.available))
    throw conflict("Há título alterado, cancelado ou reservado em outra cobrança")
  const first = BigInt(row.nextOurNumber),
    sequence = row.nextSequence,
    today = String(batch.today)
  if (sequence > 999999 || first + BigInt(items.length) - 1n > 999999999999n)
    throw conflict("A sequência do convênio se esgotou")
  const titles: SantanderTitle[] = items.map((item, index) => {
    const address = item.addresses?.find((a) => a.primary) ?? item.addresses?.[0]
    if (!address || !address.street?.trim() || !address.number?.trim())
      throw conflict("Cadastre o endereço completo do pagador " + item.name)
    const base = String(first + BigInt(index))
    return {
      ourNumber: santanderOurNumber(base),
      documentNumber: "T" + base,
      controlNumber: BigInt("0x" + item.id.replaceAll("-", ""))
        .toString(36)
        .toUpperCase(),
      issuedOn: today,
      dueOn: item.dueOn,
      cents: item.cents,
      payer: {
        name: item.name,
        taxId: item.taxId,
        address: address.street.trim() + " " + address.number.trim(),
        district: address.district,
        postalCode: address.postalCode?.replace("-", ""),
        city: address.city,
        state: address.state,
      },
    }
  })
  const content = serializeSantander240(row.profile, sequence, today, titles)
  const fileId = randomUUID(),
    filename = "SANTANDER-" + row.profile.beneficiaryCode + "-" + String(sequence).padStart(6, "0") + ".REM"
  const total = items.reduce((sum, i) => sum + BigInt(i.cents), 0n)
  const saved = (
    await ctx.client.query(
      `INSERT INTO finance_collection_remittances AS f(tenant_id,account_id,batch_id,id,profile_id,profile_snapshot,sequence,filename,
    content,sha256,item_count,amount_cents,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${remittanceFields}`,
      [
        ...params,
        fileId,
        row.id,
        row.profile,
        sequence,
        filename,
        content,
        hash(content),
        items.length,
        total,
        ctx.authSubject,
      ],
    )
  ).rows[0]!
  await ctx.client.query(
    `INSERT INTO finance_collection_remittance_items(tenant_id,remittance_id,batch_id,profile_id,receivable_id,our_number,document_number,control_number,payer_tax_id)
    SELECT $1,$2,$3,$4,id,"ourNumber","documentNumber","controlNumber","taxId" FROM jsonb_to_recordset($5::jsonb)
      AS d(id uuid,"ourNumber" text,"documentNumber" text,"controlNumber" text,"taxId" text)`,
    [
      ctx.tenantId,
      fileId,
      batchId,
      row.id,
      JSON.stringify(
        titles.map((t, i) => ({
          id: items[i]!.id,
          ourNumber: t.ourNumber,
          documentNumber: t.documentNumber,
          controlNumber: t.controlNumber,
          taxId: t.payer.taxId,
        })),
      ),
    ],
  )
  await ctx.client.query(
    "UPDATE finance_collection_file_profiles SET next_sequence=next_sequence+1,next_our_number=next_our_number+$3 WHERE tenant_id=$1 AND id=$2",
    [ctx.tenantId, row.id, items.length],
  )
  return {
    id: fileId,
    result: { tenantId: ctx.tenantId, data: saved },
    details: { accountId, batchId, sequence, sha256: saved.sha256, count: items.length },
  }
}

export async function downloadCollectionFile(
  ctx: AuthorizedContext,
  input: z.output<typeof generateCollectionFileSchema>,
) {
  rights(ctx)
  const row = (
    await ctx.client.query<{ filename: string; content: string }>(
      "SELECT filename,content FROM finance_collection_remittances WHERE tenant_id=$1 AND account_id=$2 AND batch_id=$3",
      [ctx.tenantId, input.accountId, input.batchId],
    )
  ).rows[0]
  if (!row) throw missing()
  return row
}

export type IssuedItem = {
  receivable_id: string
  batch_id: string
  document_number: string
  control_number: string
  payer_tax_id: string
  state: string
  nominal: string
  due: string
  issuedOn: string
  profileSnapshot: SantanderProfile
  available: boolean
  revision: string
}
type EventOutcome = {
  state: "registered" | "rejected" | "paid" | "review" | "unknown" | "duplicate"
  reason: string | null
}
const review = (reason: string): EventOutcome => ({ state: "review", reason })
const bankingDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" })
export function ambiguousNumbers(events: SantanderReturnEvent[]) {
  const seen = new Map<string, Map<string, string>>(),
    ambiguous = new Set<string>()
  for (const event of events) {
    if (event.kind === "other") continue
    const prior = seen.get(event.ourNumber) ?? new Map<string, string>()
    const signature = canonicalJson(event)
    if (
      (prior.has(event.kind) && prior.get(event.kind) !== signature) ||
      (event.kind === "rejected" && (prior.has("registered") || prior.has("settled"))) ||
      (event.kind !== "rejected" && prior.has("rejected"))
    )
      ambiguous.add(event.ourNumber)
    prior.set(event.kind, signature)
    seen.set(event.ourNumber, prior)
  }
  return ambiguous
}

async function settleReturn(
  ctx: AuthorizedContext,
  headers: Headers,
  profile: ProfileRow,
  item: IssuedItem,
  event: SantanderReturnEvent,
  returnId: string,
): Promise<EventOutcome> {
  if (!item.available) return review("O saldo, a situação, o cliente ou o vencimento do título mudou desde a remessa")
  // This adapter sends no discount. Segment U combines interest, fine and other charges;
  // only a fixed fine that is exact to the cent can be verified without bank-specific rounding conventions.
  const late = event.occurredOn > item.due
  if (event.discountCents !== "0") return review("A remessa não autorizou o desconto informado pelo banco")
  if (late && item.profileSnapshot.interestMonthlyBps)
    return review("Confira o cálculo diário de juros e o valor conjunto dos encargos com o convênio da remessa")
  const fineTimes10000 = late ? BigInt(item.nominal) * BigInt(item.profileSnapshot.fineBps ?? 0) : 0n
  if (BigInt(event.interestCents) * 10000n !== fineTimes10000)
    return review("Os encargos não correspondem às instruções da remessa e à data do pagamento")
  const paid = BigInt(event.paidCents),
    net = BigInt(event.netCents),
    fee = BigInt(event.feeCents)
  if (
    !event.creditOn ||
    event.creditOn < event.occurredOn ||
    !paid ||
    !net ||
    net + fee !== paid ||
    BigInt(event.nominalCents) + BigInt(event.interestCents) - BigInt(event.discountCents) !== paid ||
    [event.abatementCents, event.iofCents, event.expenseCents, event.otherCreditCents, event.payerOccurrenceCents].some(
      (value) => value !== "0",
    ) ||
    event.reasons.some((code) => !/^0[1-8]$/.test(code))
  )
    return review(
      "Confira as datas, os motivos, o valor pago, os acréscimos, os descontos, a tarifa e o crédito líquido",
    )
  const reference = "Santander CNAB • " + item.profileSnapshot.beneficiaryCode + " • " + event.ourNumber
  // The wallet can reject a posting after creating entries (e.g. closed accounting period).
  // Keep the bank evidence and roll the entire financial effect of that occurrence back together.
  await ctx.client.query("SAVEPOINT cnab_settlement")
  try {
    await applyWalletPayment(
      ctx,
      headers,
      "receivables",
      item.receivable_id,
      revisionValue(item.revision),
      {
        amount: money(event.nominalCents),
        method: "bank_transfer",
        reference,
        occurredOn: event.creditOn,
        financialAccountId: profile.accountId,
        interestAmount: "0.00",
        penaltyAmount: "0.00",
        surchargeAmount: money(event.interestCents),
        discountAmount: money(event.discountCents),
      },
      false,
      {
        source: "santander_cnab",
        returnId,
        ourNumber: event.ourNumber,
        occurredOn: event.occurredOn,
        creditOn: event.creditOn,
        combinedChargesCents: event.interestCents,
      },
    )
    let feeId: string | null = null
    if (fee > 0n) {
      feeId = randomUUID()
      await ctx.client.query(
        `INSERT INTO financial_account_entries(id,tenant_id,account_id,direction,amount_cents,occurred_on,description,reference,category_id)
        VALUES($1,$2,$3,'debit',$4,$5,'Tarifa de cobrança Santander',$6,finance_ledger_nature($2,'fee','debit'))`,
        [feeId, ctx.tenantId, profile.accountId, fee, event.creditOn, reference],
      )
      await capture(ctx, headers, "collection.fee", feeId, "account", profile.accountId, event.creditOn, fee)
    }
    await ctx.client.query(
      `UPDATE finance_collection_remittance_items i SET state='paid',payment_id=r.payment_id,fee_entry_id=$4,
      settled_at=now(),review_reason=NULL FROM receivables r WHERE (r.tenant_id,r.id)=(i.tenant_id,i.receivable_id)
      AND i.tenant_id=$1 AND i.profile_id=$2 AND i.our_number=$3`,
      [ctx.tenantId, profile.id, event.ourNumber, feeId],
    )
    await ctx.client.query("RELEASE SAVEPOINT cnab_settlement")
    return { state: "paid", reason: null }
  } catch (error) {
    if (!(error instanceof Problem) || ![403, 409, 412, 422].includes(error.status)) throw error
    await ctx.client.query("ROLLBACK TO SAVEPOINT cnab_settlement")
    await ctx.client.query("RELEASE SAVEPOINT cnab_settlement")
    return review(error.title)
  }
}

export async function processEvent(
  ctx: AuthorizedContext,
  headers: Headers,
  profile: ProfileRow,
  item: IssuedItem,
  event: SantanderReturnEvent,
  digest: string,
  returnId: string,
  ambiguous: boolean,
  generatedOn: string,
): Promise<EventOutcome> {
  if (ambiguous) return review("O mesmo arquivo contém ocorrências incompatíveis para este nosso número")
  const today = bankingDate.format(Date.now())
  if (generatedOn > today || (event.creditOn && event.creditOn > today))
    return review("Reavalie na data efetiva de geração do retorno e do crédito bancário")
  if (event.occurredOn < item.issuedOn || event.occurredOn > generatedOn)
    return review("A data da ocorrência deve estar entre a emissão da remessa e a geração do retorno")
  if (
    item.document_number !== event.documentNumber ||
    item.payer_tax_id !== event.payerTaxId ||
    item.nominal !== event.nominalCents ||
    item.due !== event.dueOn ||
    ((event.controlNumber || event.kind === "settled") && event.controlNumber !== item.control_number)
  )
    return review("O documento, o controle, o pagador, o valor ou o vencimento diverge da remessa")
  const prior = (
    await ctx.client.query<{ occurrence: string; event_sha256: string; outcome: string }>(
      `SELECT occurrence,event_sha256,outcome FROM finance_collection_return_events
    WHERE tenant_id=$1 AND profile_id=$2 AND our_number=$3 AND outcome IN ('registered','rejected','paid')
    UNION ALL
    SELECT e.occurrence,e.event_sha256,r.state AS outcome FROM finance_collection_return_events e
    JOIN finance_collection_return_reviews r ON (r.tenant_id,r.return_id,r.ordinal)=(e.tenant_id,e.return_id,e.ordinal)
    WHERE e.tenant_id=$1 AND e.profile_id=$2 AND e.our_number=$3 AND r.state IN ('registered','rejected','paid')`,
      [ctx.tenantId, profile.id, event.ourNumber],
    )
  ).rows
  const previous = prior.find((p) => p.occurrence === event.occurrence)
  if (previous)
    return previous.event_sha256 === digest
      ? { state: "duplicate", reason: null }
      : review("O banco já comunicou esta ocorrência com outros dados")
  if (event.kind === "other") return review("Ocorrência Santander " + event.occurrence + " exige conferência")
  if (
    ["rejected", "reversed"].includes(item.state) ||
    (item.state === "paid" && event.kind !== "registered") ||
    (event.kind === "rejected" && prior.some((p) => p.outcome !== "rejected"))
  )
    return review("A ocorrência conflita com o histórico de registro, rejeição ou liquidação")
  if (event.kind === "settled") return settleReturn(ctx, headers, profile, item, event, returnId)
  if (
    [
      event.paidCents,
      event.netCents,
      event.feeCents,
      event.interestCents,
      event.discountCents,
      event.abatementCents,
      event.iofCents,
      event.expenseCents,
      event.otherCreditCents,
      event.payerOccurrenceCents,
    ].some((v) => v !== "0")
  )
    return review("Ocorrência de registro ou rejeição com valores financeiros")
  const reason =
    event.kind === "rejected"
      ? "Entrada rejeitada pelo banco" + (event.reasons.length ? " • " + event.reasons.join(", ") : "")
      : null
  if (item.state !== "paid") {
    await ctx.client.query(
      `UPDATE finance_collection_remittance_items SET state=$4,review_reason=$5
      WHERE tenant_id=$1 AND profile_id=$2 AND our_number=$3`,
      [ctx.tenantId, profile.id, event.ourNumber, event.kind, reason],
    )
    if (event.kind === "rejected")
      await ctx.client.query(
        `UPDATE finance_collection_batch_items SET released_at=now()
      WHERE tenant_id=$1 AND batch_id=$2 AND receivable_id=$3 AND released_at IS NULL`,
        [ctx.tenantId, item.batch_id, item.receivable_id],
      )
  }
  return { state: event.kind, reason }
}

export async function loadIssuedItem(ctx: AuthorizedContext, profileId: string, ourNumber: string) {
  return (
    await ctx.client.query<IssuedItem>(
      `SELECT i.receivable_id,i.batch_id,i.document_number,i.control_number,i.payer_tax_id,i.state,
      f.profile_snapshot AS "profileSnapshot",b.amount_cents::text AS nominal,b.due_on::text AS due,p.revision,(f.created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS "issuedOn",
      (b.released_at IS NULL AND p.party_id=b.party_id AND p.due_date=b.due_on AND p.open_cents=b.amount_cents AND p.status='open') AS available
      FROM finance_collection_remittance_items i JOIN finance_collection_batch_items b ON (b.tenant_id,b.batch_id,b.receivable_id)=(i.tenant_id,i.batch_id,i.receivable_id)
      JOIN finance_collection_remittances f ON (f.tenant_id,f.id)=(i.tenant_id,i.remittance_id)
      LEFT JOIN finance_portfolio p ON (p.tenant_id,p.id)=(i.tenant_id,i.receivable_id) AND p.side='receivable'
      WHERE i.tenant_id=$1 AND i.profile_id=$2 AND i.our_number=$3 FOR UPDATE OF i`,
      [ctx.tenantId, profileId, ourNumber],
    )
  ).rows[0]
}

export async function markCollectionReview(
  ctx: AuthorizedContext,
  profileId: string,
  ourNumber: string,
  reason: string | null,
) {
  await ctx.client.query(
    `UPDATE finance_collection_remittance_items
      SET state=CASE WHEN state IN ('paid','rejected','reversed') THEN state ELSE 'review' END,review_reason=$4
      WHERE tenant_id=$1 AND profile_id=$2 AND our_number=$3`,
    [ctx.tenantId, profileId, ourNumber, reason],
  )
}

export async function importCollectionFile(
  ctx: AuthorizedContext,
  input: z.output<typeof importCollectionFileSchema>,
  headers: Headers = {},
) {
  rights(ctx, true)
  if (Buffer.byteLength(input.content) > 2000000) throw invalid("O arquivo de retorno excede 2 MB")
  const bank = await account(ctx, input.accountId)
  const source = readSantanderReturnSource(input.content)
  const profile = (
    await ctx.client.query<ProfileRow>(
      `SELECT ${profileFields} FROM finance_collection_file_profiles
    WHERE tenant_id=$1 AND account_id=$2 AND beneficiary_code=$3 FOR UPDATE`,
      [ctx.tenantId, input.accountId, source.beneficiaryCode],
    )
  ).rows[0]
  if (!profile) throw conflict("O convênio do retorno não corresponde à conta selecionada")
  const parsed = parseSantander240(input.content, profile.profile)
  const digest = hash(input.content)
  const prior = (
    await ctx.client.query(
      `SELECT ${returnFields} FROM finance_collection_returns f WHERE f.tenant_id=$1 AND f.profile_id=$2 AND f.sequence=$3`,
      [ctx.tenantId, profile.id, parsed.sequence],
    )
  ).rows[0]
  if (prior) {
    if (prior.sha256 !== digest) throw conflict("Já existe outro conteúdo para o sequencial deste retorno")
    return {
      id: String(prior.id),
      result: { tenantId: ctx.tenantId, data: prior },
      details: { accountId: input.accountId, sha256: digest, duplicate: true },
    }
  }
  checkBank(bank, profile.profile, (await company(ctx)).taxId)
  const returnId = randomUUID(),
    filename = input.fileName ?? "SANTANDER-" + String(parsed.sequence).padStart(6, "0") + ".RET"
  await ctx.client.query(
    `INSERT INTO finance_collection_returns(tenant_id,id,account_id,profile_id,sequence,generated_on,filename,sha256,content,item_count,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      ctx.tenantId,
      returnId,
      input.accountId,
      profile.id,
      parsed.sequence,
      parsed.generatedOn,
      filename,
      digest,
      input.content,
      parsed.events.length,
      ctx.authSubject,
    ],
  )
  const ambiguous = ambiguousNumbers(parsed.events)
  for (const [index, event] of parsed.events.entries()) {
    const item = await loadIssuedItem(ctx, profile.id, event.ourNumber)
    const evidenceDigest = hash(canonicalJson(event))
    const outcome: EventOutcome = item
      ? await processEvent(
          ctx,
          headers,
          profile,
          item,
          event,
          evidenceDigest,
          returnId,
          ambiguous.has(event.ourNumber),
          parsed.generatedOn,
        )
      : { state: "unknown", reason: "Nosso número sem título emitido neste convênio" }
    if (item && outcome.state === "review") await markCollectionReview(ctx, profile.id, event.ourNumber, outcome.reason)
    await ctx.client.query(
      `INSERT INTO finance_collection_return_events(tenant_id,return_id,ordinal,profile_id,receivable_id,our_number,occurrence,event_sha256,evidence,outcome,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        ctx.tenantId,
        returnId,
        index + 1,
        profile.id,
        item?.receivable_id ?? null,
        event.ourNumber,
        event.occurrence,
        evidenceDigest,
        event,
        outcome.state,
        outcome.reason,
      ],
    )
  }
  const saved = (
    await ctx.client.query(
      `SELECT ${returnFields} FROM finance_collection_returns f WHERE f.tenant_id=$1 AND f.id=$2`,
      [ctx.tenantId, returnId],
    )
  ).rows[0]!
  return {
    id: returnId,
    result: { tenantId: ctx.tenantId, data: saved },
    details: { accountId: input.accountId, sha256: digest, sequence: parsed.sequence, count: parsed.events.length },
  }
}
