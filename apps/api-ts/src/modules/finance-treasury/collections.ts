import { postCollectionFee } from "../finance-management/operation-postings.js"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { normalizedDatabaseId as id } from "../../platform/database-id.js"
import { record } from "../../platform/commands.js"
import { revisionValue } from "../../platform/revision.js"
import { applyWalletPayment } from "../finance-wallets/settlements.js"
import { validateDate } from "../sales/fixed.js"
import { account, conflict, invalid, missing, money, writableAccount } from "./ledger.js"
import { merchants, providerCents, requirePilot, type BankPayment } from "./mercadopago.js"

export type Headers = Record<string, string | string[] | undefined>
export const chargeSchema = z.strictObject({
  accountId: id,
  groupId: id.nullish(),
  batchId: id.optional(),
  receivableIds: z
    .array(id)
    .min(1)
    .max(100)
    .refine((ids) => ids.length === new Set(ids).size),
  billingType: z.enum(["BOLETO", "PIX"]),
})
type Charge = {
  id: string
  account_id: string
  collector_id: string
  live_mode: boolean
  method: "PIX" | "BOLETO"
  amount_cents: string
  provider_request: Record<string, unknown>
  state: string
  provider_id: string | null
  instructions: {
    qrCode?: string | null
    barcode?: string | null
    ticketUrl?: string | null
    boletoReference?: string | null
  } | null
  settled_at: string | null
}
export async function getCharge(ctx: AuthorizedContext, id: string) {
  const row = (
    await ctx.client.query<Charge>("SELECT * FROM finance_collection_charges WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
      ctx.tenantId,
      id,
    ])
  ).rows[0]
  if (!row) throw missing()
  return row
}
export async function collections(ctx: AuthorizedContext, groupId?: string) {
  const configs = merchants().filter((c) => c.tenantId === ctx.tenantId)
  const accounts = (
    await ctx.client.query<{ id: string; name: string }>(
      "SELECT id,name FROM financial_accounts WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status='active' AND account_type='bank' ORDER BY name,id",
      [ctx.tenantId, configs.map((c) => c.accountId)],
    )
  ).rows.map((r) => ({ ...r, live: configs.find((c) => c.accountId === r.id)!.live }))
  const charges = (
    await ctx.client.query(
      `SELECT c.id,c.account_id AS "accountId",c.group_id AS "groupId",c.batch_id AS "batchId",c.method,c.due_on::text AS "dueOn",c.amount_cents::text cents,c.state,c.provider_id AS "providerId",c.instructions,c.review_reason AS "reviewReason",p.legal_name AS name,
    ARRAY(SELECT i.receivable_id FROM finance_collection_items i WHERE i.tenant_id=c.tenant_id AND i.charge_id=c.id ORDER BY i.receivable_id) AS "receivableIds"
    FROM finance_collection_charges c JOIN parties p ON (p.tenant_id,p.id)=(c.tenant_id,c.party_id) WHERE c.tenant_id=$1 AND ($2::uuid IS NULL OR c.group_id=$2) ORDER BY c.created_at DESC LIMIT 100`,
      [ctx.tenantId, groupId ?? null],
    )
  ).rows
  const options = (
    await ctx.client.query(
      `SELECT p.id,p.party_name AS name,p.party_id AS "partyId",p.open_cents::text cents,p.due_date::text AS "dueOn" FROM finance_portfolio p
    WHERE p.tenant_id=$1 AND side='receivable' AND open_cents>0 AND NOT EXISTS(SELECT 1 FROM finance_collection_items i WHERE i.tenant_id=p.tenant_id AND i.receivable_id=p.id)
      AND NOT EXISTS(SELECT FROM finance_collection_batch_items bi WHERE (bi.tenant_id,bi.receivable_id)=(p.tenant_id,p.id) AND bi.released_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM finance_operation_items i JOIN finance_active_operations g ON (g.tenant_id,g.id)=(i.tenant_id,i.operation_id)
        WHERE i.tenant_id=p.tenant_id AND i.receivable_id=p.id AND g.kind='billing_group')
    ORDER BY p.due_date,p.id LIMIT 100`,
      [ctx.tenantId],
    )
  ).rows
  return { charges, options, accounts, accountId: accounts.length === 1 ? accounts[0]!.id : null }
}
type Address = {
  primary: boolean
  postalCode: string
  street: string
  number: string
  district: string
  city: string
  state: string
}
export async function reserveCharge(
  ctx: AuthorizedContext,
  headers: Headers,
  input: z.infer<typeof chargeSchema>,
  key: string,
) {
  requirePermission(ctx, "finance.receivables.read")
  const selected = await account(ctx, input.accountId)
  if (selected.status !== "active" || selected.accountType !== "bank")
    throw conflict("Selecione uma conta bancária ativa")
  const cfg = requirePilot(ctx.tenantId, input.accountId)
  const batchItems = (await ctx.client.query<{ batch_id:string; account_id:string; party_id:string; due:string; cents:string }>(
    `SELECT b.id AS batch_id,b.account_id,i.party_id,i.due_on::text AS due,i.amount_cents::text AS cents
     FROM finance_collection_batch_items i JOIN finance_collection_batches b ON (b.tenant_id,b.id)=(i.tenant_id,i.batch_id)
     WHERE i.tenant_id=$1 AND i.receivable_id=ANY($2::uuid[]) AND i.released_at IS NULL`, [ctx.tenantId,input.receivableIds])).rows
  const batchItem = batchItems[0]
  if (input.batchId) {
    if (input.groupId || input.receivableIds.length !== 1 || !batchItem || batchItem.batch_id !== input.batchId || batchItem.account_id !== input.accountId)
      throw conflict("A conta e o título devem corresponder ao borderô ativo")
  } else if (batchItem) throw conflict("Abra o borderô para emitir a cobrança deste título")
  if (input.groupId) {
    const active = await ctx.client.query(
      "SELECT 1 FROM finance_active_operations WHERE tenant_id=$1 AND id=$2 AND kind='billing_group'",
      [ctx.tenantId, input.groupId],
    )
    if (!active.rows.length) throw conflict("Agrupamento inexistente ou estornado")
  } else {
    const grouped = await ctx.client.query(
      `SELECT 1 FROM finance_operation_items i JOIN finance_active_operations g ON (g.tenant_id,g.id)=(i.tenant_id,i.operation_id)
      WHERE i.tenant_id=$1 AND i.receivable_id=ANY($2::uuid[]) AND g.kind='billing_group' LIMIT 1`,
      [ctx.tenantId, input.receivableIds],
    )
    if (grouped.rows.length) throw conflict("Abra o agrupamento ativo para emitir a cobrança destas parcelas")
  }
  const existing = (
    await ctx.client.query<{ charge_id: string }>(
      `SELECT DISTINCT charge_id FROM finance_collection_items
    WHERE tenant_id=$1 AND receivable_id=ANY($2::uuid[])`,
      [ctx.tenantId, input.receivableIds],
    )
  ).rows
  if (existing.length) {
    const previous = await getCharge(ctx, existing[0]!.charge_id)
    const members = await ctx.client.query<{ receivable_id: string }>(
      "SELECT receivable_id FROM finance_collection_items WHERE tenant_id=$1 AND charge_id=$2",
      [ctx.tenantId, previous.id],
    )
    const same =
      members.rows.length === input.receivableIds.length &&
      members.rows.every((m) => input.receivableIds.includes(m.receivable_id))
    if (
      existing.length !== 1 ||
      !same ||
      previous.account_id !== input.accountId ||
      previous.method !== input.billingType ||
      (previous as Record<string, unknown>).group_id !== (input.groupId ?? null) ||
      (previous as Record<string, unknown>).batch_id !== (input.batchId ?? null)
    )
      throw conflict("Há uma cobrança reservada para estes títulos")
    return previous.id
  }
  const rows = (
    await ctx.client.query<{ id: string; party_id: string; due: string; open_cents: string }>(
      "SELECT id,party_id,due_date::text due,open_cents::text FROM finance_portfolio WHERE tenant_id=$1 AND side='receivable' AND id=ANY($2::uuid[]) AND open_cents>0 ORDER BY due_date,id",
      [ctx.tenantId, input.receivableIds],
    )
  ).rows
  if (
    rows.length !== input.receivableIds.length ||
    new Set(rows.map((r) => r.party_id)).size !== 1 ||
    !rows[0]?.party_id
  )
    throw conflict("Selecione títulos em aberto do mesmo cliente")
  const partyId = rows[0].party_id,
    total = rows.reduce((sum, r) => sum + BigInt(r.open_cents), 0n)
  if (batchItem && (batchItem.cents !== total.toString() || batchItem.due !== rows[0].due || batchItem.party_id !== partyId))
    throw conflict("O saldo, o cliente ou o vencimento diverge do borderô preparado")
  if (total > 99999999999999n) throw invalid("Valor fora do limite do banco")
  let dueOn = rows[0].due
  if (input.groupId) {
    const detail = await ctx.client.query<{ due: string; receivable_id: string; principal_cents: string }>(
      `SELECT g.due_on::text due,i.receivable_id,i.principal_cents::text FROM finance_active_operations g JOIN finance_operation_items i ON
      (i.tenant_id,i.operation_id)=(g.tenant_id,g.id) WHERE g.tenant_id=$1 AND g.id=$2 AND g.kind='billing_group' AND g.party_id=$3`,
      [ctx.tenantId, input.groupId, partyId],
    )
    if (
      detail.rows.length !== rows.length ||
      !detail.rows.every((item) =>
        rows.some((r) => r.id === item.receivable_id && r.open_cents === item.principal_cents),
      )
    )
      throw conflict("Os títulos e saldos devem corresponder ao agrupamento")
    dueOn = detail.rows[0]!.due
  } else if (rows.some((r) => r.due !== dueOn))
    throw conflict("Crie um agrupamento com vencimento comum para estas parcelas")
  const party = (
    await ctx.client.query<{ legal_name: string; email: string; tax_id: string; addresses: Address[] }>(
      "SELECT legal_name,email,tax_id,addresses FROM parties WHERE tenant_id=$1 AND id=$2",
      [ctx.tenantId, partyId],
    )
  ).rows[0]
  if (!party?.email) throw conflict("Cadastre o e-mail do pagador")
  if (!cfg.live && !/^(?:test_user[^@]*@testuser\.com|[^@]+@example\.(?:org|com|net))$/i.test(party.email))
    throw conflict("Use um cliente de homologação com e-mail de teste")
  const addr = party.addresses.find((a) => a?.primary) ?? party.addresses[0]
  if (input.billingType === "BOLETO") {
    const complete = addr && typeof addr.postalCode === "string" && /^\d{5}-?\d{3}$/.test(addr.postalCode)
      && /^[A-Z]{2}$/.test(addr.state)
      && [addr.street, addr.number, addr.district, addr.city].every(value => typeof value === "string" && value.trim())
    if (!complete) throw conflict("Cadastre o endereço completo do pagador para emitir o boleto")
  }
  const names = party.legal_name.trim().split(/\s+/),
    chargeId = randomUUID()
  const providerRequest = {
    external_reference: chargeId,
    transaction_amount: Number(money(total)),
    description: cfg.live ? "Cobrança de título" : "Cobrança de homologação",
    payment_method_id: input.billingType === "PIX" ? "pix" : "bolbradesco",
    date_of_expiration: dueOn + "T23:59:59.000-03:00",
    payer: {
      email: party.email,
      first_name: names[0],
      last_name: names.slice(1).join(" ") || names[0],
      identification: { type: party.tax_id.length === 11 ? "CPF" : "CNPJ", number: party.tax_id },
      ...(addr
        ? {
            address: {
              zip_code: input.billingType === "BOLETO" ? addr.postalCode.replace("-", "") : addr.postalCode,
              street_name: addr.street,
              street_number: addr.number,
              neighborhood: addr.district,
              city: addr.city,
              federal_unit: addr.state,
            },
          }
        : {}),
    },
  }
  await ctx.client.query(
    `INSERT INTO finance_collection_charges(tenant_id,id,account_id,party_id,group_id,method,amount_cents,due_on,provider_request,issue_key,live_mode,collector_id,batch_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      ctx.tenantId,
      chargeId,
      input.accountId,
      partyId,
      input.groupId ?? null,
      input.billingType,
      total,
      dueOn,
      providerRequest,
      key,
      cfg.live,
      cfg.collectorId,
      input.batchId ?? null,
    ],
  )
  for (const r of rows)
    await ctx.client.query(
      "INSERT INTO finance_collection_items(tenant_id,charge_id,receivable_id,amount_cents) VALUES($1,$2,$3,$4)",
      [ctx.tenantId, chargeId, r.id, r.open_cents],
    )
  await record(ctx, headers, "finance_collection", chargeId, "finance_collection.prepared", {
    accountId: input.accountId,
    receivableIds: input.receivableIds,
    amount: money(total),
  })
  return chargeId
}
export async function observePayment(
  ctx: AuthorizedContext,
  headers: Headers,
  charge: Charge,
  p: BankPayment,
  source: string,
  eventKey: string,
) {
  requirePermission(ctx, "finance.receivables.manage")
  const cfg = requirePilot(ctx.tenantId, charge.account_id)
  if (
    p.live_mode !== cfg.live ||
    p.live_mode !== charge.live_mode ||
    p.collector_id !== charge.collector_id ||
    p.collector_id !== cfg.collectorId ||
    p.external_reference !== charge.id ||
    p.currency_id !== "BRL" ||
    p.payment_method_id !== (charge.method === "PIX" ? "pix" : "bolbradesco") ||
    (charge.provider_id && charge.provider_id !== p.id) ||
    providerCents(p.transaction_amount) !== BigInt(charge.amount_cents)
  )
    throw conflict("Identidade, moeda ou valor do pagamento diverge da cobrança")
  const old = await ctx.client.query(
    "SELECT outcome FROM finance_collection_events WHERE tenant_id=$1 AND source=$2 AND event_key=$3 AND charge_id=$4",
    [ctx.tenantId, source, eventKey, charge.id],
  )
  if (old.rows.length) return { chargeId: charge.id, state: charge.state, duplicate: true }
  const link = p.transaction_details?.external_resource_url
  const instructions = {
    qrCode: p.point_of_interaction?.transaction_data?.qr_code ?? charge.instructions?.qrCode ?? null,
    barcode: p.barcode?.content ?? charge.instructions?.barcode ?? null,
    boletoReference: charge.method === "BOLETO"
      ? p.transaction_details?.payment_method_reference_id ?? charge.instructions?.boletoReference ?? null
      : null,
    ticketUrl: link && /^https:\/\/(www\.)?mercadopago\.com(?:\.br)?\//i.test(link)
      ? link : charge.instructions?.ticketUrl ?? null,
  }
  let state = charge.state,
    reason: string | null = null,
    feeId: string | null = null
  if (
    ["refunded", "charged_back", "cancelled", "rejected"].includes(p.status) ||
    (p.transaction_amount_refunded ?? 0) > 0
  ) {
    state = "review"
    reason = "Situação comunicada pelo provedor • " + p.status
  } else if (p.status === "approved" && !charge.settled_at) {
    const items = (
      await ctx.client.query<{ id: string; revision: string; open_cents: string; amount_cents: string }>(
        `SELECT i.receivable_id id,p.revision,p.open_cents,i.amount_cents
      FROM finance_collection_items i JOIN finance_portfolio p ON (p.tenant_id,p.id)=(i.tenant_id,i.receivable_id) AND p.side='receivable'
      WHERE i.tenant_id=$1 AND i.charge_id=$2 ORDER BY i.receivable_id`,
        [ctx.tenantId, charge.id],
      )
    ).rows
    const net = p.transaction_details?.net_received_amount,
      gross = BigInt(charge.amount_cents)
    if (
      !items.length ||
      items.some((i) => BigInt(i.amount_cents) !== BigInt(i.open_cents)) ||
      !p.date_approved ||
      net == null ||
      providerCents(net) > gross
    ) {
      state = "review"
      reason = "Confira os saldos, data de aprovação e valor líquido antes de baixar"
    } else {
      const occurredOn = validateDate(
        new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date(p.date_approved)),
      )
      await writableAccount(ctx, charge.account_id, occurredOn)
      const ref = "Mercado Pago • " + p.id
      for (const i of items) {
        await applyWalletPayment(ctx, headers, "receivables", i.id, revisionValue(i.revision), {
          amount: money(i.amount_cents),
          method: "bank_transfer",
          reference: ref,
          occurredOn,
          financialAccountId: charge.account_id,
        })
        await ctx.client.query(
          "UPDATE finance_collection_items i SET payment_id=r.payment_id FROM receivables r WHERE (i.tenant_id,i.receivable_id)=(r.tenant_id,r.id) AND i.tenant_id=$1 AND i.charge_id=$2 AND i.receivable_id=$3",
          [ctx.tenantId, charge.id, i.id],
        )
      }
      const fee = gross - providerCents(net)
      if (fee > 0n) {
        feeId = randomUUID()
        await ctx.client.query(
          "INSERT INTO financial_account_entries(id,tenant_id,account_id,direction,amount_cents,occurred_on,description,reference,category_id) VALUES($1,$2,$3,'debit',$4,$5,'Tarifa Mercado Pago',$6,finance_ledger_nature($2,'fee','debit'))",
          [feeId, ctx.tenantId, charge.account_id, fee, occurredOn, ref],
        )
      }
      state = "paid"
    }
  } else if (!charge.settled_at && state === "prepared") state = "issued"
  await ctx.client.query(
    `UPDATE finance_collection_charges SET provider_id=$3,state=$4,instructions=$5,review_reason=$6,fee_entry_id=coalesce(fee_entry_id,$7),
    settled_at=CASE WHEN $4='paid' THEN coalesce(settled_at,now()) ELSE settled_at END WHERE tenant_id=$1 AND id=$2`,
    [ctx.tenantId, charge.id, p.id, state, instructions, reason, feeId],
  )
  if (feeId) await postCollectionFee(ctx, headers, charge.id)
  await ctx.client.query(
    "INSERT INTO finance_collection_events(tenant_id,charge_id,source,event_key,outcome) VALUES($1,$2,$3,$4,$5)",
    [ctx.tenantId, charge.id, source, eventKey, state],
  )
  await record(ctx, headers, "finance_collection", charge.id, "finance_collection.observed", {
    source,
    providerId: p.id,
    state,
    reason,
    feeId,
  })
  return { chargeId: charge.id, state, instructions, reason }
}
