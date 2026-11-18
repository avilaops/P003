import { fixed, itemTotal, type DraftItem } from "./nfe-draft-model"

export const amountFields = [["freightAmount", "Frete"], ["insuranceAmount", "Seguro"], ["otherAmount", "Outras despesas"], ["discountAmount", "Desconto"]] as const
export type AmountKey = typeof amountFields[number][0]
export type AllocationRules = Partial<Record<AmountKey, { total: string; locked: number[] }>>
const cents = (value: string) => BigInt(fixed(value || "0", 2, 13).replace(".", ""))
const money = (value: bigint) => `${value / BigInt(100)}.${String(value % BigInt(100)).padStart(2, "0")}`

export function amountTotal(items: DraftItem[], key: AmountKey): string {
  return money(items.reduce((total, item) => total + cents(item[key] || "0"), BigInt(0)))
}

// Largest remainders preserve every cent and keep equal-weight ties in item order.
export function allocateAmount(items: DraftItem[], key: AmountKey, value: string): DraftItem[] {
  const total = cents(value)
  if (total === BigInt(0)) return items.map(item => ({ ...item, [key]: "0.00" }))
  const weights = items.map(item => cents(itemTotal(item.quantity, item.unitPrice)))
  const base = weights.reduce((sum, weight) => sum + weight, BigInt(0))
  if (!base) throw new Error("Preencha os preços e as quantidades antes de distribuir os valores.")
  if (key === "discountAmount" && total > base) throw new Error("O desconto não pode superar o total dos produtos.")
  const shares = weights.map(weight => total * weight / base)
  const ranking = weights.map((weight, index) => ({ index, remainder: total * weight % base }))
    .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)
  let remaining = total - shares.reduce((sum, share) => sum + share, BigInt(0))
  for (const { index } of ranking) {
    if (!remaining) break
    shares[index] += BigInt(1)
    remaining -= BigInt(1)
  }
  return items.map((item, index) => ({ ...item, [key]: money(shares[index]) }))
}

export function reallocateAmounts(items: DraftItem[], rules: AllocationRules): DraftItem[] {
  let result = items
  for (const [key] of amountFields) {
    const rule = rules[key]
    if (!rule) continue
    const locked = new Set(rule.locked)
    const fixedTotal = result.reduce((sum, item, index) => sum + (locked.has(index) ? cents(item[key] || "0") : BigInt(0)), BigInt(0))
    const remainder = cents(rule.total) - fixedTotal
    if (remainder < BigInt(0)) throw new Error("Os ajustes individuais superam o total definido. Revise o total ou os ajustes.")
    const unlocked = result.filter((_, index) => !locked.has(index))
    if (!unlocked.length && remainder !== BigInt(0)) throw new Error("Todos os itens têm ajustes individuais. Aplique um novo total para redistribuir.")
    const allocated = allocateAmount(unlocked, key, money(remainder))
    let position = 0
    result = result.map((item, index) => locked.has(index) ? item : { ...item, [key]: allocated[position++][key] })
  }
  return result
}
