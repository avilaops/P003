import { type Context } from "./shared.js"

// Split cumulative principal through the replacement's source tree. Each split is monotone,
// so a series of small receipts allocates the same cents as one payment of the same total.
export function apportion(total: bigint, weights: bigint[]) {
  let remaining = total,
    weight = weights.reduce((sum, value) => sum + value, 0n)
  return weights.map((value) => {
    const part = weight > 0n ? (remaining * value + weight / 2n) / weight : 0n
    remaining -= part
    weight -= value
    return part
  })
}
export async function orderShares(c: Context, operation: string, payment: string, amount: bigint) {
  const { tenantId, client } = c
  const { rows } = await client.query(
    `WITH RECURSIVE origins AS (
    SELECT o.id AS operation_id,1::numeric AS factor FROM finance_operations o WHERE o.tenant_id=$1 AND o.id=$2 AND o.kind='restructure'
    UNION ALL SELECT r.finance_operation_id,t.factor*i.principal_cents/(o.principal_cents+o.interest_cents)
    FROM origins t JOIN finance_operations o ON o.tenant_id=$1 AND o.id=t.operation_id
    JOIN finance_operation_items i ON i.tenant_id=o.tenant_id AND i.operation_id=o.id
    JOIN receivables r ON r.tenant_id=i.tenant_id AND r.id=i.receivable_id WHERE r.finance_operation_id IS NOT NULL
  ),weights AS (
    SELECT r.order_id, sum(t.factor*i.principal_cents/(o.principal_cents+o.interest_cents)) AS weight
    FROM origins t JOIN finance_operations o ON o.tenant_id=$1 AND o.id=t.operation_id
    JOIN finance_operation_items i ON i.tenant_id=o.tenant_id AND i.operation_id=o.id
    JOIN receivables r ON r.tenant_id=i.tenant_id AND r.id=i.receivable_id WHERE r.order_id IS NOT NULL GROUP BY r.order_id
  ) SELECT order_id,round(weight*1e28)::text AS weight FROM weights ORDER BY order_id`,
    [tenantId, operation],
  )
  if (!rows.length) return []
  const prior = (
    await client.query(
      `SELECT COALESCE(sum(CASE WHEN p.kind='receipt' THEN p.amount_cents ELSE -p.amount_cents END),0) AS total
    FROM receivable_payments p JOIN receivables r ON r.tenant_id=p.tenant_id AND r.id=p.receivable_id
    LEFT JOIN receivable_payments original ON original.tenant_id=p.tenant_id AND original.id=p.reverses_id
    WHERE r.tenant_id=$1 AND r.finance_operation_id=$2 AND p.id<>$3
    AND NOT EXISTS(SELECT 1 FROM finance_operations op WHERE op.tenant_id=p.tenant_id AND op.id::text=COALESCE(original.reference,p.reference) AND op.kind='restructure' AND p.financial_effect='non_cash')`,
      [tenantId, operation, payment],
    )
  ).rows[0]!
  const weights = rows.map((row) => BigInt(String(row.weight)))
  // Refinancing interest has no sales commission. Keep its share in the denominator.
  const residue = 10n ** 28n - weights.reduce((sum, value) => sum + value, 0n)
  weights.push(residue > 0n ? residue : 0n)
  const previous = BigInt(String(prior.total)),
    before = apportion(previous, weights),
    after = apportion(previous + amount, weights)
  return rows
    .map((r, i) => ({ orderId: String(r.order_id), cents: after[i]! - before[i]! }))
    .filter((r) => r.cents > 0n)
}
