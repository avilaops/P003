/**
 * Regras puras do cronograma de faturamento recorrente (S1). Datas são
 * `YYYY-MM-DD` de calendário, sem fuso: o "hoje" vem de `brazilToday()`.
 */
export type Periodicity = "monthly" | "quarterly" | "semiannual" | "annual"
export const periodicityMonths: Record<Periodicity, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 }

const day = (value: string) => new Date(value + "T00:00:00.000Z")
const iso = (value: Date) => value.toISOString().slice(0, 10)

/** Soma meses preservando o dia; no mês mais curto, usa o último dia (31/01 + 1 mês = 28/02). */
export function addMonths(date: string, months: number) {
  const base = day(date), target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(base.getUTCDate(), last))
  return iso(target)
}
export function addDays(date: string, days: number) {
  const value = day(date)
  value.setUTCDate(value.getUTCDate() + days)
  return iso(value)
}
/** Primeira data a partir de `date` cujo dia do mês é `billingDay` (1–28). */
export function nextBillingDay(date: string, billingDay: number) {
  const value = day(date)
  if (value.getUTCDate() > billingDay) value.setUTCMonth(value.getUTCMonth() + 1, billingDay)
  else value.setUTCDate(billingDay)
  return iso(value)
}

export type ScheduleTerms = { startOn: string; endOn: string; periodicity: Periodicity; billingDay: number; dueDays: number }
export type SchedulePeriod = { index: number; periodStart: string; periodEnd: string; issueOn: string; dueOn: string }

/**
 * Períodos do contrato com emissão até `until` (inclusive). Cada período é
 * calculado a partir do início original, para não acumular desvio de dias.
 * A emissão cai no primeiro "dia de faturamento" dentro do período.
 */
export function schedule(terms: ScheduleTerms, until: string, limit = 240): SchedulePeriod[] {
  const step = periodicityMonths[terms.periodicity], result: SchedulePeriod[] = []
  for (let index = 0; index < limit; index++) {
    const periodStart = addMonths(terms.startOn, index * step)
    if (periodStart > terms.endOn) break
    const following = addDays(addMonths(terms.startOn, (index + 1) * step), -1)
    const periodEnd = following < terms.endOn ? following : terms.endOn
    const candidate = nextBillingDay(periodStart, terms.billingDay)
    const issueOn = candidate > periodEnd ? periodEnd : candidate
    if (issueOn > until) break
    result.push({ index, periodStart, periodEnd, issueOn, dueOn: addDays(issueOn, terms.dueDays) })
  }
  return result
}

/** Data do reajuste do ciclo `cycle` (1 = primeiro aniversário da data-base). */
export function adjustmentOn(baseOn: string, cycle: number) { return addMonths(baseOn, 12 * cycle) }
/** Quantos reajustes a data-base exige até `date` (inclusive). */
export function requiredCycles(baseOn: string, date: string) {
  let cycle = 0
  while (adjustmentOn(baseOn, cycle + 1) <= date) cycle++
  return cycle
}

export type ContractItem = { description: string; serviceCode: string; quantity: string; unitCents: number }
const micros = (value: string) => { const [whole, fraction = ""] = value.split("."); return BigInt(whole! + fraction.padEnd(6, "0")) }
/** Arredondamento comercial (meio para cima) de `numerator / denominator`, ambos positivos. */
const roundHalfUp = (numerator: bigint, denominator: bigint) => (numerator * 2n + denominator) / (denominator * 2n)
export function itemAmount(item: ContractItem) { return Number(roundHalfUp(micros(item.quantity) * BigInt(item.unitCents), 1_000_000n)) }
export function contractAmount(items: ContractItem[]) { return items.reduce((total, item) => total + itemAmount(item), 0) }
/** Aplica a taxa do índice (pontos-base; 452 = 4,52%) ao preço unitário de cada item. */
export function adjustItems(items: ContractItem[], rateBp: number): ContractItem[] {
  return items.map(item => ({ ...item, unitCents: Number(roundHalfUp(BigInt(item.unitCents) * BigInt(10_000 + rateBp), 10_000n)) }))
}
