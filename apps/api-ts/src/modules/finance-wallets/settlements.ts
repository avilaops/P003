import { randomUUID } from "node:crypto"
import { z } from "zod"
import { requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { sameJson } from "../../platform/json.js"
import { nextRevision, type Revision } from "../../platform/revision.js"
import { fixed, decimal, validateDate } from "../sales/fixed.js"
import { onSettlement } from "../finance-management/accrual.js"
import { assertOpenAccountPeriod } from "../finance-treasury/ledger.js"
import { documentSchema, prepareDocument, storeDocument, type Headers } from "./documents.js"
import { checkClassification, walletSettings } from "./settings.js"
import {
  currentRevision,
  conflict,
  invalid,
  loadWallet,
  missing,
  walletDefinition,
  type Wallet,
  type WalletSnapshot,
} from "./snapshot.js"

const guid = z.guid().transform((v) => v.toLowerCase()),
  reference = z
    .string()
    .trim()
    .min(3)
    .max(200)
    .refine((v) => !/\p{Cc}/u.test(v))
const inputSchema = z.strictObject({
  amount: z.string(),
  method: z.enum(["cash", "bank_transfer", "card", "other"]),
  reference,
  occurredOn: z.string(),
  financialAccountId: guid.nullish().default(null),
  paymentMethodId: guid.nullish(),
  supportingDocument: documentSchema.nullish(),
  interestAmount: z.string().optional(),
  penaltyAmount: z.string().optional(),
  surchargeAmount: z.string().optional(),
  discountAmount: z.string().optional(),
  financialEffect: z.enum(["cash", "non_cash"]).optional(),
  natureId: guid.nullish(),
  costCenterId: guid.nullish(),
  approvalId: guid.optional(),
})
export const reversalSchema = z.strictObject({ paymentId: guid, reason: reference, occurredOn: z.string() })
export function parsePayment(input: unknown) {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) invalid("Baixa inválida ou campos desconhecidos")
  validateDate(parsed.data.occurredOn)
  return parsed.data
}
type Input = ReturnType<typeof parsePayment>
export function paymentIntent(s: Input) {
  const { supportingDocument, paymentMethodId, ...rest } = s
  return {
    ...rest,
    ...(paymentMethodId ? { paymentMethodId } : {}),
    ...(supportingDocument ? { supportingDocument: prepareDocument(supportingDocument).fingerprint } : {}),
  }
}
function cents(input: string | undefined, otherwise = 0n) {
  return input === undefined ? otherwise : fixed(input, 2)
}
const rounded = (a: bigint, b: bigint) => (a + b / 2n) / b
export async function preparePayment(
  ctx: AuthorizedContext,
  wallet: Wallet,
  title: WalletSnapshot,
  s: Input,
  internalNonCash = false,
) {
  const d = walletDefinition(wallet),
    { data: settings } = await walletSettings(ctx)
  const principal = fixed(s.amount, 2)
  if (!principal) invalid("O principal deve ser positivo")
  if (title.data.status !== "open" || principal > fixed(title.data.outstandingAmount, 2))
    conflict("Valor superior ao saldo de uma conta em aberto")
  if (!d.receipt && s.paymentMethodId) invalid("A forma de recebimento cadastrada pertence à carteira de clientes")
  const elapsed = Math.floor(
    (Date.parse(s.occurredOn + "T00:00:00Z") - Date.parse(title.data.dueDate + "T00:00:00Z")) / 86400000,
  )
  const late = BigInt(Math.max(0, elapsed - settings.graceDays))
  const expectedInterest = rounded(principal * BigInt(settings.interestMonthlyBps) * late, 300000n),
    expectedPenalty = late > 0n ? rounded(principal * BigInt(settings.penaltyBps), 10000n) : 0n
  const interest = cents(s.interestAmount, expectedInterest),
    penalty = cents(s.penaltyAmount, expectedPenalty),
    surcharge = cents(s.surchargeAmount),
    discount = cents(s.discountAmount)
  if (
    !internalNonCash &&
    ((settings.interestMonthlyBps > 0 && expectedInterest !== interest) ||
      (settings.penaltyBps > 0 && expectedPenalty !== penalty))
  )
    requirePermission(ctx, "finance.charges.override")
  const net = principal + interest + penalty + surcharge - discount
  if (net < 0n || net > 99999999999999n) invalid("Valor líquido fora do intervalo")
  const effect = s.financialEffect ?? (net === 0n ? "non_cash" : "cash")
  if (effect === "non_cash" && net !== 0n && !internalNonCash) invalid("A compensação exige uma operação vinculada")
  if (effect === "cash" && (!s.financialAccountId || !net))
    invalid("Informe a conta financeira para a movimentação de caixa")
  if (effect === "non_cash" && s.financialAccountId) invalid("Uma compensação deve ser registrada sem conta de caixa")
  const center = s.costCenterId ?? title.data.costCenterId ?? settings.defaultCostCenterId
  let category = s.natureId ?? title.data.natureId
  if (!category)
    category = String(
      (
        await ctx.client.query("SELECT finance_default_category($1,$2) AS id", [
          ctx.tenantId,
          d.receipt ? "sale" : title.data.staffId ? "payroll" : "purchase",
        ])
      ).rows[0]!.id,
    )
  await checkClassification(ctx, category, center, d.receipt ? "income" : "expense", settings.requireCostCenter)
  const reasons: string[] = []
  if (discount * 10000n > principal * BigInt(settings.discountLimitBps)) reasons.push("discount")
  if (
    !d.receipt &&
    effect === "cash" &&
    settings.paymentApprovalLimit !== null &&
    net > fixed(settings.paymentApprovalLimit, 2)
  )
    reasons.push("payment")
  return { principal, interest, penalty, surcharge, discount, net, effect, category, center, reasons }
}
export function approvalIntent(s: Input, values: Awaited<ReturnType<typeof preparePayment>>) {
  const { approvalId: _, ...intent } = paymentIntent(s)
  return {
    ...intent,
    interestAmount: decimal(values.interest, 2),
    penaltyAmount: decimal(values.penalty, 2),
    surchargeAmount: decimal(values.surcharge, 2),
    discountAmount: decimal(values.discount, 2),
    natureId: values.category,
    costCenterId: values.center,
    financialEffect: values.effect,
  }
}
async function accountEntry(
  ctx: AuthorizedContext,
  account: string,
  occurredOn: string,
  credit: boolean,
  net: bigint,
  category: string | null,
  center: string | null,
  description: string,
  ref: string,
  reversing: boolean,
) {
  const accountRow = (
    await ctx.client.query("SELECT status FROM financial_accounts WHERE tenant_id=$1 AND id=$2", [
      ctx.tenantId,
      account,
    ])
  ).rows[0]
  if (!accountRow) missing()
  if (!reversing && accountRow.status !== "active") conflict("A conta financeira está arquivada")
  if (
    (
      await ctx.client.query(
        "SELECT id FROM pos_sessions WHERE tenant_id=$1 AND cash_account_id=$2 AND status='open'",
        [ctx.tenantId, account],
      )
    ).rows.length
  )
    conflict("Conta vinculada a uma sessão de caixa aberta")
  await assertOpenAccountPeriod(ctx, account, occurredOn)
  const id = randomUUID()
  await ctx.client.query(
    `INSERT INTO financial_account_entries(id,tenant_id,account_id,direction,amount_cents,occurred_on,description,reference,category_id,cost_center_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, ctx.tenantId, account, credit ? "credit" : "debit", net, occurredOn, description, ref, category, center],
  )
  return id
}
type Entry = {
  amount: bigint
  interest: bigint
  penalty: bigint
  surcharge: bigint
  discount: bigint
  method: string
  reference: string
  occurredOn: string
  effect: string | null
  account: string | null
  ledger: string | null
  category: string | null
  center: string | null
  methodId?: string | null
  methodSnapshot?: unknown
  proof?: ReturnType<typeof prepareDocument>
  approvedBy?: string | null
}
async function insertPayment(
  ctx: AuthorizedContext,
  wallet: Wallet,
  title: string,
  paymentId: string,
  reverses: string | null,
  e: Entry,
) {
  const d = walletDefinition(wallet)
  const columns = [
    "id",
    "tenant_id",
    d.foreign,
    "kind",
    "amount_cents",
    "interest_cents",
    "penalty_cents",
    "surcharge_cents",
    "discount_cents",
    "method",
    "reference",
    "occurred_on",
    "financial_effect",
    "financial_account_id",
    "account_entry_id",
    "category_id",
    "cost_center_id",
    "recorded_by",
    "reverses_id",
    "discount_approved_by",
  ]
  const values: unknown[] = [
    paymentId,
    ctx.tenantId,
    title,
    reverses ? "reversal" : d.kind,
    e.amount,
    e.interest,
    e.penalty,
    e.surcharge,
    e.discount,
    e.method,
    e.reference,
    e.occurredOn,
    e.effect,
    e.account,
    e.ledger,
    e.category,
    e.center,
    ctx.authSubject,
    reverses,
    e.approvedBy ?? null,
  ]
  if (e.proof) {
    columns.push("proof_metadata", "proof_content")
    values.push(e.proof.fingerprint, e.proof.content)
  }
  if (d.receipt) {
    columns.push("payment_method_id", "payment_method")
    values.push(e.methodId ?? null, e.methodSnapshot ?? null)
  }
  await ctx.client.query(
    `INSERT INTO ${d.payments}(${columns.join(",")}) VALUES(${values.map((_, i) => "$" + (i + 1)).join(",")})`,
    values,
  )
}
export async function applyWalletPayment(
  ctx: AuthorizedContext,
  headers: Headers,
  wallet: Wallet,
  id: string,
  expected: Revision,
  input: unknown,
  internalNonCash = false,
) {
  const d = walletDefinition(wallet),
    s = parsePayment(input),
    title = await loadWallet(ctx, wallet, id)
  currentRevision(title.data.revision, expected)
  const v = await preparePayment(ctx, wallet, title, s, internalNonCash)
  let approvedBy: string | null = null
  if (v.reasons.length || s.approvalId) {
    if (!s.approvalId) conflict("A baixa exige aprovação. Solicite a aprovação dos valores antes de confirmar")
    const row = (
      await ctx.client.query(
        "SELECT status,decided_by,title_revision,intent,reasons FROM financial_settlement_approvals WHERE tenant_id=$1 AND id=$2 AND " +
          d.foreign +
          "=$3",
        [ctx.tenantId, s.approvalId, id],
      )
    ).rows[0]
    if (
      !row ||
      row.status !== "approved" ||
      BigInt(String(row.title_revision)) !== BigInt(expected) ||
      !sameJson(row.intent, approvalIntent(s, v)) ||
      !v.reasons.every((r) => (row.reasons as string[]).includes(r))
    )
      conflict("A aprovação deve corresponder a esta baixa e revisão")
    approvedBy = String(row.decided_by)
    await ctx.client.query("UPDATE financial_settlement_approvals SET status='used' WHERE tenant_id=$1 AND id=$2", [
      ctx.tenantId,
      s.approvalId,
    ])
  }
  let method: string = s.method,
    methodSnapshot: Record<string, unknown> | null = null
  if (s.paymentMethodId) {
    methodSnapshot =
      (
        await ctx.client.query(
          "SELECT id,code,name,modality FROM payment_methods WHERE tenant_id=$1 AND id=$2 AND status='active'",
          [ctx.tenantId, s.paymentMethodId],
        )
      ).rows[0] ?? null
    if (!methodSnapshot) missing()
    const mod = String(methodSnapshot.modality)
    method = ["pix", "bank_transfer"].includes(mod)
      ? "bank_transfer"
      : ["credit_card", "debit_card"].includes(mod)
        ? "card"
        : mod === "cash"
          ? "cash"
          : "other"
  }
  const entry = s.financialAccountId
    ? await accountEntry(
        ctx,
        s.financialAccountId,
        s.occurredOn,
        d.receipt,
        v.net,
        v.category,
        v.center,
        d.receipt ? "Recebimento declarado" : "Pagamento declarado",
        s.reference,
        false,
      )
    : null
  const payment = randomUUID(),
    revision = nextRevision(expected),
    remaining = fixed(title.data.outstandingAmount, 2) - v.principal
  const proof = s.supportingDocument ? prepareDocument(s.supportingDocument) : undefined
  const salesOrder = d.receipt ? title.data.orderId : null
  await insertPayment(ctx, wallet, id, payment, null, {
    ...(!salesOrder && proof ? { proof } : {}),
    ...v,
    amount: v.principal,
    method,
    reference: s.reference,
    occurredOn: s.occurredOn,
    account: s.financialAccountId,
    ledger: entry,
    methodId: s.paymentMethodId ?? null,
    methodSnapshot,
    approvedBy,
  })
  if (salesOrder && proof) await storeDocument(ctx, headers, salesOrder, payment, proof)
  else if (proof)
    await record(ctx, headers, d.entity + "_payment", payment, "finance.payment_proof_attached", {
      titleId: id,
      ...proof.fingerprint,
    })
  await ctx.client.query(
    `UPDATE ${d.titles} SET status=$3,payment_id=$4,revision=$5,category_id=coalesce(category_id,$6),cost_center_id=coalesce(cost_center_id,$7) WHERE tenant_id=$1 AND id=$2`,
    [ctx.tenantId, id, remaining ? "open" : "paid", remaining ? null : payment, revision, v.category, v.center],
  )
  await onSettlement(ctx, headers, d.receipt ? "receivable" : "payable", payment)
  await record(ctx, headers, d.entity, id, d.entity + (remaining ? ".payment_recorded" : ".paid"), {
    paymentId: payment,
    amount: decimal(v.principal, 2),
    netAmount: decimal(v.net, 2),
    accountEntryId: entry,
    outstandingAmount: decimal(remaining, 2),
    previousRevision: expected,
    revision,
    source: internalNonCash ? "compensation" : "manual_declaration",
    approvalId: s.approvalId ?? null,
  })
  return loadWallet(ctx, wallet, id)
}
export async function reverseWalletPayment(
  ctx: AuthorizedContext,
  headers: Headers,
  wallet: Wallet,
  id: string,
  expected: Revision,
  s: z.infer<typeof reversalSchema>,
  internalNonCash = false,
) {
  const d = walletDefinition(wallet),
    title = await loadWallet(ctx, wallet, id)
  currentRevision(title.data.revision, expected)
  if (title.data.status === "cancelled") conflict("O título cancelado não admite estornos")
  const original = title.payments.find((p) => p.id === s.paymentId && p.kind === d.kind)
  if (!original || title.payments.some((p) => p.reversesId === s.paymentId))
    conflict("Escolha uma baixa ativa deste título")
  if (validateDate(s.occurredOn) < original.occurredOn) invalid("Estorno não pode anteceder a baixa original")
  if (original.financialEffect === "non_cash" && fixed(original.netAmount, 2) > 0n && !internalNonCash)
    conflict("Estorne a compensação pela operação de origem")
  const account = original.financialAccountId
  const ledger = account
    ? await accountEntry(
        ctx,
        account,
        s.occurredOn,
        !d.receipt,
        fixed(original.netAmount, 2),
        original.natureId,
        original.costCenterId,
        "Estorno de lançamento financeiro",
        s.reason,
        true,
      )
    : null
  const payment = randomUUID(),
    revision = nextRevision(expected)
  await insertPayment(ctx, wallet, id, payment, original.id, {
    amount: fixed(original.amount, 2),
    interest: fixed(original.interestAmount, 2),
    penalty: fixed(original.penaltyAmount, 2),
    surcharge: fixed(original.surchargeAmount, 2),
    discount: fixed(original.discountAmount, 2),
    method: original.method,
    reference: s.reason,
    occurredOn: s.occurredOn,
    effect: original.financialEffect === "unclassified" ? null : original.financialEffect,
    account,
    ledger,
    category: original.natureId,
    center: original.costCenterId,
    methodId: original.paymentMethodId ?? null,
    methodSnapshot: original.paymentMethod,
  })
  await ctx.client.query(
    `UPDATE ${d.titles} SET status='open',payment_id=NULL,revision=$3 WHERE tenant_id=$1 AND id=$2`,
    [ctx.tenantId, id, revision],
  )
  await onSettlement(ctx, headers, d.receipt ? "receivable" : "payable", payment)
  await record(ctx, headers, d.entity, id, d.entity + ".payment_reversed", {
    paymentId: payment,
    reversesId: original.id,
    netAmount: original.netAmount,
    accountEntryId: ledger,
    previousRevision: expected,
    revision,
  })
  return loadWallet(ctx, wallet, id)
}
