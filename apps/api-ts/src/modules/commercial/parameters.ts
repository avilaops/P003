import { z } from "zod"
import { Problem } from "../../platform/problem.js"
import { unsigned32, unsigned64 } from "../../platform/numbers.js"
export { unsigned32, unsigned64 } from "../../platform/numbers.js"

export const STATES = ["AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO"] as const
const rateSchema = z.strictObject({ state: z.string(), internalBps: unsigned32, fcpBps: unsigned32, outgoingBps: unsigned32.nullable().default(null) })
export const parametersSchema = z.strictObject({
  originState: z.string(), netMarginBps: unsigned32, freeDiscountBps: unsigned32, costSafetyBps: unsigned32, minimumDownPaymentBps: unsigned32, proposalValidityDays: unsigned32,
  domesticIcmsBps: unsigned32, pisCofinsBps: unsigned32, ipiBps: unsigned32, incomeTaxBps: unsigned32, commissionBps: unsigned32, adsBps: unsigned32, gatewayBps: unsigned32, otherFeesBps: unsigned32, interstateBps: unsigned32, lossBps: unsigned32, warrantyBps: unsigned32, badDebtBps: unsigned32,
  fixedOrderFeeCents: unsigned64, monthlyExpensesCents: unsigned64, stateRates: z.array(rateSchema),
})
export type CommercialParameters = z.infer<typeof parametersSchema>
export function invalidCommercial(title: string): never { throw new Problem(422, "invalid_input", title) }
export function rounded(numerator: bigint, denominator: bigint) { return (numerator + denominator / 2n) / denominator }
export function up(numerator: bigint, denominator: bigint) { return (numerator + denominator - 1n) / denominator }
export function commercialCents(value: bigint) {
  if (value < -99999999999999n || value > 99999999999999n) invalidCommercial("Valor comercial fora do limite")
  return Number(value)
}

export function simulateParameters(p: CommercialParameters) {
  const rates = [p.netMarginBps, p.freeDiscountBps, p.costSafetyBps, p.minimumDownPaymentBps, p.domesticIcmsBps, p.pisCofinsBps, p.ipiBps, p.incomeTaxBps, p.commissionBps, p.adsBps, p.gatewayBps, p.otherFeesBps, p.interstateBps, p.lossBps, p.warrantyBps, p.badDebtBps]
  if (rates.some(rate => rate < 0 || rate > 10000) || p.freeDiscountBps === 10000 || p.incomeTaxBps === 10000) invalidCommercial("Percentuais devem estar entre 0 e 100; desconto e IR devem ser menores que 100")
  if (p.proposalValidityDays < 1 || p.proposalValidityDays > 3650 || BigInt(p.fixedOrderFeeCents) > 1000000000000n || BigInt(p.monthlyExpensesCents) > 1000000000000n) invalidCommercial("Validade ou valores monetários fora do limite")
  if (!STATES.some(state => state === p.originState) || p.stateRates.length !== STATES.length) invalidCommercial("Informe a UF de origem e uma alíquota para cada uma das 27 UFs")
  const seen = new Set<string>()
  let worstState = p.originState, worstNonContributor = false, worstIcmsBps = p.domesticIcmsBps
  for (const row of p.stateRates) {
    if (!STATES.some(state => state === row.state) || seen.has(row.state) || row.internalBps > 10000 || row.fcpBps > 10000 || row.outgoingBps !== null && row.outgoingBps > 10000) invalidCommercial("UF repetida, desconhecida ou alíquota inválida")
    seen.add(row.state)
    if (row.state === p.originState) continue
    const nonContributor = Math.max(row.outgoingBps ?? p.interstateBps, row.internalBps) + row.fcpBps
    if (nonContributor > worstIcmsBps || nonContributor === worstIcmsBps && row.state < worstState) {
      worstState = row.state; worstNonContributor = true; worstIcmsBps = nonContributor
    }
  }
  const channel = p.pisCofinsBps + p.commissionBps + p.adsBps + p.gatewayBps + p.otherFeesBps + p.lossBps + p.warrantyBps + p.badDebtBps, costs = worstIcmsBps + channel
  const retained = BigInt(10000 - p.incomeTaxBps), numerator = BigInt(10000 - costs) * retained - BigInt(p.netMarginBps) * 10000n
  if (numerator <= 0n) invalidCommercial("Margem, impostos e taxas consomem 100% da venda; não existe preço viável para estes parâmetros")
  const discounted = Number(10000n * retained) / Number(numerator), table = discounted / (1 - p.freeDiscountBps / 10000), destinationLimits = []
  for (const state of STATES) {
    const row = p.stateRates.find(row => row.state === state)!
    for (const taxpayer of [false, true]) {
      if (state === p.originState && taxpayer) continue
      const outgoing = row.outgoingBps ?? p.interstateBps, icms = state === p.originState ? p.domesticIcmsBps : taxpayer ? outgoing : Math.max(outgoing, row.internalBps) + row.fcpBps
      const available = BigInt(10000 - channel - icms) * retained
      const discount = (share: bigint) => {
        const remaining = share * 10000n - numerator * BigInt(10000 - p.freeDiscountBps)
        return Number((remaining > 0n ? remaining : 0n) / share)
      }
      destinationLimits.push({ state, taxpayer, variableCostsBps: channel + icms, atTargetBps: discount(available - BigInt(p.netMarginBps) * 10000n), noLossBps: discount(available) })
    }
  }
  return {
    worstState, worstNonContributor, worstIcmsBps, variableCostsBps: costs, requiredPretaxMarginPercent: p.netMarginBps / Number(retained) * 100,
    discountedCostMultiplier: discounted, tableCostMultiplier: table, markupPercent: (table - 1) * 100, rawCostMultiplierWithSafety: table * (1 + p.costSafetyBps / 10000),
    monthlyExpensesCents: p.monthlyExpensesCents, breakEvenRevenue: BigInt(p.monthlyExpensesCents) === 0n ? 0 : p.netMarginBps === 0 ? null : Number(up(BigInt(p.monthlyExpensesCents) * retained, BigInt(p.netMarginBps))) / 100, destinationLimits,
  }
}
