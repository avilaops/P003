import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { TenantContext } from "../../platform/database.js"
import { invalid, walletDefinition, type Wallet } from "./snapshot.js"

export const distributionInput = z
  .array(
    z.strictObject({
      costCenterId: z.guid().transform((v) => v.toLowerCase()),
      basisPoints: z.number().int().min(1).max(9999),
    }),
  )
  .max(100)
export type Share = z.infer<typeof distributionInput>[number]
type Components = { principal: bigint; interest: bigint; penalty: bigint; surcharge: bigint; discount: bigint }
const ordered = (a: Share, b: Share) => a.costCenterId.localeCompare(b.costCenterId, "en")
export const allocationKey = (wallet: Wallet) =>
  wallet === "receivables" ? "receivable_payment_id" : "payable_payment_id"

export async function configureDistribution(
  ctx: TenantContext,
  current: string | null,
  existing: Share[],
  input: Share[] | undefined,
  center: string | null,
) {
  if (input === undefined) return center ? null : current
  if (!input.length) return null
  if (center) invalid("Selecione um centro único ou distribua o título entre centros")
  const rows = [...input].sort(ordered),
    ids = rows.map((r) => r.costCenterId)
  if (rows.length < 2 || new Set(ids).size !== rows.length || rows.reduce((sum, r) => sum + r.basisPoints, 0) !== 10000)
    invalid("O rateio exige centros distintos e percentuais que somem 100%")
  const active = await ctx.client.query(
    "SELECT id FROM financial_cost_centers WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status='active'",
    [ctx.tenantId, ids],
  )
  if (active.rows.length !== rows.length) invalid("Todos os centros do rateio devem estar ativos")
  if (
    current &&
    existing.length === rows.length &&
    rows.every((r) => existing.some((s) => s.costCenterId === r.costCenterId && s.basisPoints === r.basisPoints))
  )
    return current
  const group = randomUUID()
  await ctx.client.query("INSERT INTO finance_cost_center_distributions(tenant_id,id) VALUES($1,$2)", [
    ctx.tenantId,
    group,
  ])
  await ctx.client.query(
    "INSERT INTO finance_cost_center_shares(tenant_id,distribution_id,cost_center_id,basis_points) SELECT $1,$2,* FROM unnest($3::uuid[],$4::int[])",
    [ctx.tenantId, group, ids, rows.map((r) => r.basisPoints)],
  )
  return group
}

// Highest averages with previous active allocations as a lower bound. Start at the
// proportional floor, freezing centers already above quota after an out-of-order reversal.
// Fewer than one residual cent per center remains to be assigned by exact quotient.
function distribute(amount: bigint, weights: bigint[], previous: bigint[]) {
  const total = [...previous]
  let active = weights.map((_, index) => index),
    remaining = amount
  while (active.length && remaining > 0n) {
    const weight = active.reduce((n, i) => n + weights[i]!, 0n),
      seats = active.reduce((n, i) => n + previous[i]!, amount)
    const eligible = active.filter((i) => (seats * weights[i]!) / weight >= previous[i]!)
    if (eligible.length !== active.length) {
      active = eligible
      continue
    }
    for (const i of active) {
      total[i] = (seats * weights[i]!) / weight
      remaining -= total[i]! - previous[i]!
    }
    while (remaining > 0n) {
      let best = active[0]!
      for (const i of active) if (weights[i]! * (total[best]! + 1n) > weights[best]! * (total[i]! + 1n)) best = i
      total[best] = total[best]! + 1n
      remaining--
    }
  }
  return total.map((v, i) => v - previous[i]!)
}

function distributeDiscount(amount: bigint, gross: bigint[]) {
  const total = gross.reduce((sum, v) => sum + v, 0n)
  if (!amount || !total) return gross.map(() => 0n)
  const shares = gross.map((v) => (amount * v) / total)
  const order = gross
    .map((v, i) => ({ i, rest: (amount * v) % total }))
    .sort((a, b) => (a.rest === b.rest ? a.i - b.i : a.rest > b.rest ? -1 : 1))
  const residual = Number(amount - shares.reduce((sum, v) => sum + v, 0n))
  for (const { i } of order.slice(0, residual)) shares[i] = shares[i]! + 1n
  return shares
}

export async function saveAllocations(
  ctx: TenantContext,
  wallet: Wallet,
  payment: string,
  distribution: string,
  amounts: Components,
) {
  const key = allocationKey(wallet),
    d = walletDefinition(wallet)
  const rows = (
    await ctx.client.query(
      `SELECT s.cost_center_id,s.basis_points,c.status,
      coalesce(sum(x.principal_cents*direction.sign),0) AS principal,coalesce(sum(x.interest_cents*direction.sign),0) AS interest,
      coalesce(sum(x.penalty_cents*direction.sign),0) AS penalty,coalesce(sum(x.surcharge_cents*direction.sign),0) AS surcharge
      FROM finance_cost_center_shares s JOIN financial_cost_centers c ON (c.tenant_id,c.id)=(s.tenant_id,s.cost_center_id)
      LEFT JOIN financial_payment_allocations x ON (x.tenant_id,x.distribution_id,x.cost_center_id)=(s.tenant_id,s.distribution_id,s.cost_center_id)
      LEFT JOIN ${d.payments} p ON (p.tenant_id,p.id)=(x.tenant_id,x.${key})
      CROSS JOIN LATERAL (SELECT CASE WHEN p.kind='reversal' THEN -1 ELSE 1 END AS sign) direction
      WHERE s.tenant_id=$1 AND s.distribution_id=$2 GROUP BY s.cost_center_id,s.basis_points,c.status ORDER BY s.cost_center_id`,
      [ctx.tenantId, distribution],
    )
  ).rows
  if (rows.some((r) => r.status !== "active"))
    invalid("Atualize os centros arquivados do rateio antes de baixar o título")
  const weights = rows.map((r) => BigInt(String(r.basis_points)))
  const split = (k: "principal" | "interest" | "penalty" | "surcharge") =>
    distribute(
      amounts[k],
      weights,
      rows.map((row) => BigInt(String(row[k]))),
    )
  const principal = split("principal"),
    interest = split("interest"),
    penalty = split("penalty"),
    surcharge = split("surcharge")
  const discount = distributeDiscount(
    amounts.discount,
    principal.map((v, i) => v + interest[i]! + penalty[i]! + surcharge[i]!),
  )
  await ctx.client.query(
    `INSERT INTO financial_payment_allocations(tenant_id,distribution_id,${key},cost_center_id,principal_cents,interest_cents,penalty_cents,surcharge_cents,discount_cents)
      SELECT $1,$2,$3,* FROM unnest($4::uuid[],$5::bigint[],$6::bigint[],$7::bigint[],$8::bigint[],$9::bigint[])`,
    [
      ctx.tenantId,
      distribution,
      payment,
      rows.map((r) => r.cost_center_id),
      principal,
      interest,
      penalty,
      surcharge,
      discount,
    ],
  )
}

export async function reverseAllocations(ctx: TenantContext, wallet: Wallet, payment: string, original: string) {
  const key = allocationKey(wallet)
  await ctx.client.query(
    `INSERT INTO financial_payment_allocations(tenant_id,${key},distribution_id,cost_center_id,principal_cents,interest_cents,penalty_cents,surcharge_cents,discount_cents)
    SELECT tenant_id,$3,distribution_id,cost_center_id,principal_cents,interest_cents,penalty_cents,surcharge_cents,discount_cents FROM financial_payment_allocations WHERE tenant_id=$1 AND ${key}=$2`,
    [ctx.tenantId, original, payment],
  )
}
