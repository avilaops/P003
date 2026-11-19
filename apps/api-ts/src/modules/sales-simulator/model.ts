import { z } from "zod"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { signed64 } from "../../platform/numbers.js"
import { invalidCommercial as invalid, parametersSchema, rounded, simulateParameters, unsigned32, unsigned64, up, type CommercialParameters } from "../commercial/parameters.js"

// Deterministic managerial quote over published prices. Integer cents, one final rounding per unit.
const bps = 10000n, scale = bps * bps, maxMoney = 99_999_999_999_999n
const uuid = z.guid().transform(value => value.toLowerCase())
export const quoteInputSchema = z.strictObject({
  versionId: uuid, productId: normalizedDatabaseId, quantity: unsigned32, destination: z.string(), taxpayer: z.boolean(),
  discount: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("percent"), value: unsigned32 }), z.strictObject({ kind: z.literal("amount"), value: signed64 }), z.strictObject({ kind: z.literal("target"), value: signed64 })]),
  freightCents: signed64,
})
export type QuoteInput = z.infer<typeof quoteInputSchema>
export const publishedCostSchema = z.strictObject({ purchaseCostCents: unsigned64, taxCreditBps: unsigned32, packagingCents: unsigned64 })
export type PublishedCost = z.infer<typeof publishedCostSchema>
export const policySchema = parametersSchema

const roundedSigned = (value: bigint, denominator: bigint): bigint => value < 0n ? -roundedSigned(-value, denominator) : rounded(value, denominator)
const limited = (value: bigint) => { if (value < -maxMoney || value > maxMoney) invalid("Valor da simulação fora do limite"); return Number(value) }

export function quote(input: QuoteInput, priceCents: bigint | number, cost: PublishedCost, p: CommercialParameters) {
  simulateParameters(p)
  const price = BigInt(priceCents), q = BigInt(input.quantity), freight = BigInt(input.freightCents)
  const purchase = BigInt(cost.purchaseCostCents), packaging = BigInt(cost.packagingCents)
  if (input.quantity < 1 || input.quantity > 1000000 || price < 1n || price > 1000000000000n || freight < 0n || freight > maxMoney
    || purchase > 1000000000000n || packaging > 1000000000000n || cost.taxCreditBps > 10000) invalid("Quantidade, custo ou frete inválido")
  const row = p.stateRates.find(rate => rate.state === input.destination) ?? invalid("UF de destino inválida")
  const outgoing = row.outgoingBps ?? p.interstateBps
  const icms = input.destination === p.originState ? p.domesticIcmsBps : input.taxpayer ? outgoing : Math.max(outgoing, row.internalBps) + row.fcpBps
  const channel = p.commissionBps + p.adsBps + p.gatewayBps + p.otherFeesBps, provisions = p.lossBps + p.warrantyBps + p.badDebtBps
  const tableTotal = price * q
  limited(tableTotal)
  const factor = bps + BigInt(p.ipiBps)
  // Published tables round the final unit with IPI upwards; preserve that price at zero discount.
  const gross = (unit: bigint) => up(unit * factor, bps)
  let unit: bigint
  const value = BigInt(input.discount.value)
  if (input.discount.kind === "percent" && value < 10000n) unit = rounded(price * (bps - value), bps)
  else if (input.discount.kind === "amount" && value >= 0n && value < tableTotal) unit = rounded(tableTotal - value, q)
  else if (input.discount.kind === "target" && value > 0n && value <= gross(price) * q) {
    const cap = value / q
    let low = 0n, high = price
    while (low < high) {
      const mid = (low + high + 1n) / 2n
      if (gross(mid) <= cap) low = mid
      else high = mid - 1n
    }
    unit = low
  } else invalid("Desconto ou total desejado inválido")
  if (unit <= 0n || unit > price) invalid("O desconto precisa preservar um preço positivo")
  const adjustedUnit = purchase * (bps - BigInt(cost.taxCreditBps)) * (bps + BigInt(p.costSafetyBps)) + packaging * scale
  const equipment = rounded(adjustedUnit * q, scale), fixedFee = BigInt(p.fixedOrderFeeCents)
  const variable = BigInt(icms + p.pisCofinsBps + channel + provisions)
  // Credits, safety, taxes and income tax stay exact rationals so every boundary search is monotonic.
  const finance = (unitPrice: bigint) => {
    const pretax = unitPrice * q * (bps - variable) * bps - adjustedUnit * q - (freight + fixedFee) * scale
    const income = (pretax > 0n ? pretax : 0n) * BigInt(p.incomeTaxBps)
    return { pretax, income, profit: pretax * bps - income }
  }
  const meets = (unitPrice: bigint, target: boolean) => finance(unitPrice).profit >= (target ? unitPrice * q * BigInt(p.netMarginBps) * scale : 0n)
  const maxDiscount = (target: boolean): number | null => {
    if (!meets(price, target)) return null
    let low = 0n, high = 9999n
    while (low < high) {
      const mid = (low + high + 1n) / 2n, candidate = rounded(price * (bps - mid), bps)
      if (candidate > 0n && meets(candidate, target)) low = mid
      else high = mid - 1n
    }
    return Number(low)
  }
  let low = 1n, high = 1000000000000n
  if (!meets(high, true)) invalid("Não existe preço viável dentro do limite")
  while (low < high) {
    const mid = (low + high) / 2n
    if (meets(mid, true)) high = mid
    else low = mid + 1n
  }
  const net = unit * q, invoice = gross(unit) * q, raw = finance(unit)
  const pretax = roundedSigned(raw.pretax, scale), income = roundedSigned(raw.income, scale * bps), profit = pretax - income
  const band = meets(unit, true) ? "at_target" : raw.profit >= 0n ? "below_target" : "loss"
  const reasons: string[] = []
  // The free boundary uses the same unit-cent rounding as a percentage entry, so an exact limit never asks approval for a fraction of a cent.
  if (unit < rounded(price * (bps - BigInt(p.freeDiscountBps)), bps)) reasons.push("discount_above_free")
  if (band !== "at_target") reasons.push("below_target")
  const supplier = rounded(purchase * (bps + BigInt(p.costSafetyBps)) * q, bps), targetProfit = rounded(net * BigInt(p.netMarginBps), bps)
  // Commission applies to the entrance without IPI; round up to cover funding.
  const required = up((supplier + targetProfit) * factor, factor - BigInt(p.commissionBps))
  const tax = (rate: number) => rounded(net * BigInt(rate), bps)
  const sale = {
    quantity: input.quantity, tableUnitCents: Number(price), tableTotalCents: limited(tableTotal), discountCents: limited(tableTotal - net),
    discountBps: Number(rounded((tableTotal - net) * bps, tableTotal)), unitWithoutIpiCents: limited(unit), unitWithIpiCents: limited(gross(unit)),
    netSaleCents: limited(net), ipiCents: limited(invoice - net), ipiBps: p.ipiBps, invoiceTotalCents: limited(invoice),
    minimumDownPaymentBps: p.minimumDownPaymentBps, minimumDownPaymentCents: limited(rounded(invoice * BigInt(p.minimumDownPaymentBps), bps)),
    freeDiscountBps: p.freeDiscountBps, freightCents: Number(freight), band, needsApproval: reasons.length > 0, approvalReasons: reasons,
  }
  const director = {
    icmsCents: limited(tax(icms)), pisCofinsCents: limited(tax(p.pisCofinsBps)), channelCents: limited(tax(channel)), provisionsCents: limited(tax(provisions)),
    roundingCents: limited(net - equipment - freight - fixedFee - pretax - [icms, p.pisCofinsBps, channel, provisions].reduce((sum, rate) => sum + tax(rate), 0n)),
    equipmentCostCents: limited(equipment), fixedFeeCents: limited(fixedFee), profitBeforeIncomeTaxCents: limited(pretax), incomeTaxCents: limited(income), netProfitCents: limited(profit),
    netProfitBps: Number(raw.profit / (scale * net)), targetMarginBps: p.netMarginBps, atTargetBps: maxDiscount(true), noLossBps: maxDiscount(false),
    minimumTargetUnitWithIpiCents: limited(gross(low)), supplierPaymentCents: limited(supplier), targetProfitCents: limited(targetProfit),
    downPaymentCommissionCents: limited(required - supplier - targetProfit), requiredDownPaymentCents: limited(required), requiredDownPaymentBps: Number(up(required * bps, invoice)),
  }
  return { sale, director }
}
