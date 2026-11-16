import { z } from "zod"
import { revisionValue, type Revision } from "../../platform/revision.js"
import { selectPlateHolderType } from "../sales/finishes.js"
import { commercialCents as cents, invalidCommercial as invalid, rounded, up, simulateParameters, unsigned32, unsigned64, type CommercialParameters } from "./parameters.js"

const nullableText = z.string().nullable().default(null), uuid = z.string().uuid().transform(value => value.toLowerCase())
export const negotiationInputSchema = z.strictObject({
  line: z.string(), versionId: uuid, destinationState: z.string(), taxpayer: z.boolean(),
  discount: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("percent"), value: unsigned32 }), z.strictObject({ kind: z.literal("amount"), value: unsigned64 }), z.strictObject({ kind: z.literal("total"), value: unsigned64 })]),
  freightCents: unsigned64, downPaymentCents: unsigned64.nullable().default(null),
  items: z.array(z.strictObject({ productId: uuid, quantity: unsigned32, structureColor: nullableText, swingArmColor: z.preprocess(value => value === null ? undefined : value, z.string().optional()), plateHolderColor: nullableText, plateHolderType: nullableText, upholsteryColor: nullableText })),
})
export type NegotiationInput = z.infer<typeof negotiationInputSchema>
export type SourceItem = { productId: string; sku: string; name: string; unit: string; productRevision: Revision; costRevision: Revision | null; priceCents: number | bigint; purchaseCents: number | bigint; creditBps: number; packagingCents: number | bigint }
export type ApprovalRules = { belowTarget: boolean; freight: boolean; directorAutoApproval: boolean; managerLimit: "profit" | "target" }

export function calculateNegotiation(p: CommercialParameters, rules: ApprovalRules, input: NegotiationInput, sources: SourceItem[]) {
  simulateParameters(p)
  if (!input.items.length || input.items.length > 100 || sources.length !== input.items.length || BigInt(input.freightCents) > 1000000000000n) invalid("Informe de 1 a 100 equipamentos e um frete válido")
  const row = p.stateRates.find(row => row.state === input.destinationState)
  if (!row) invalid("UF de destino inválida")
  const outgoing = row.outgoingBps ?? p.interstateBps
  const icms = input.destinationState === p.originState ? p.domesticIcmsBps : outgoing
  const difal = input.destinationState === p.originState || input.taxpayer ? 0 : Math.max(0, row.internalBps - outgoing) + row.fcpBps
  const tax = icms + p.pisCofinsBps + p.commissionBps + p.adsBps + p.gatewayBps + p.otherFeesBps + p.lossBps + p.warrantyBps + p.badDebtBps
  const seen = new Set<string>()
  let table = 0n, costScaled = 0n, supplierScaled = 0n
  for (const [index, item] of input.items.entries()) {
    const source = sources[index]!, quantity = BigInt(item.quantity), price = BigInt(source.priceCents), purchase = BigInt(source.purchaseCents), packaging = BigInt(source.packagingCents)
    if (item.productId !== source.productId || seen.has(item.productId) || item.quantity < 1 || item.quantity > 1000000 || price <= 0n || purchase < 0n || packaging < 0n || source.creditBps < 0 || source.creditBps > 10000) invalid("Equipamento, custo ou quantidade inválidos")
    seen.add(item.productId)
    table += price * quantity
    costScaled += (purchase * BigInt(10000 - source.creditBps) * BigInt(10000 + p.costSafetyBps) + packaging * 100000000n) * quantity
    supplierScaled += purchase * BigInt(10000 + p.costSafetyBps) * quantity
  }
  cents(table)
  const gross = (unit: bigint) => up(unit * BigInt(10000 + p.ipiBps), 10000n)
  let numerator: bigint, denominator: bigint
  const value = BigInt(input.discount.value)
  if (input.discount.kind === "percent" && value < 10000n) { numerator = 10000n - value; denominator = 10000n }
  else if (input.discount.kind === "amount" && value < table) { numerator = table - value; denominator = table }
  else if (input.discount.kind === "total" && value > 0n) {
    const totalAt = (net: bigint) => input.items.reduce((total, item, index) => total + gross(rounded(BigInt(sources[index]!.priceCents) * net, table)) * BigInt(item.quantity), 0n)
    if (value > totalAt(table)) invalid("Total desejado deve ser positivo e não superar a tabela")
    let low = 0n, high = table
    while (low < high) {
      const mid = (low + high + 1n) / 2n
      if (totalAt(mid) <= value) low = mid
      else high = mid - 1n
    }
    numerator = low; denominator = table
  } else invalid("Desconto deve preservar uma venda positiva")
  if (numerator <= 0n || numerator > denominator) invalid("Total desejado deve ser positivo e não superar a tabela")
  let totalIpi = 0n, net = 0n
  const items = input.items.map((item, index) => {
    const source = sources[index]!, unitNet = rounded(BigInt(source.priceCents) * numerator, denominator)
    if (!unitNet) invalid("Desconto deixa um equipamento sem valor comercial")
    const unitTotal = gross(unitNet), lineNet = unitNet * BigInt(item.quantity), ipi = (unitTotal - unitNet) * BigInt(item.quantity)
    totalIpi += ipi; net += lineNet
    return { productId: item.productId, sku: source.sku, name: source.name, unit: source.unit, quantity: item.quantity, tableUnitCents: Number(source.priceCents), unitNetCents: cents(unitNet), unitTotalCents: cents(unitTotal), netCents: cents(lineNet), ipiCents: cents(ipi), totalCents: cents(lineNet + ipi), structureColor: item.structureColor, ...(item.swingArmColor === undefined ? {} : { swingArmColor: item.swingArmColor }), plateHolderColor: item.plateHolderColor, plateHolderType: selectPlateHolderType(item.plateHolderType ?? undefined), upholsteryColor: item.upholsteryColor }
  })
  const total = net + totalIpi, taxes = rounded(net * BigInt(tax), 10000n), difalAmount = rounded(net * BigInt(difal), 10000n), cost = rounded(costScaled, 100000000n)
  const fixed = BigInt(input.freightCents) + BigInt(p.fixedOrderFeeCents), beforeIr = net - taxes - difalAmount - cost - fixed, ir = rounded((beforeIr > 0n ? beforeIr : 0n) * BigInt(p.incomeTaxBps), 10000n), profit = beforeIr - ir
  const target = rounded(net * BigInt(p.netMarginBps), 10000n), band = profit < 0n ? "loss" : profit < target ? "belowTarget" : "atTarget", supplier = rounded(supplierScaled, 10000n)
  const entryDenominator = BigInt(10000 + p.ipiBps - p.commissionBps)
  if (entryDenominator <= 0n) invalid("Comissão inviabiliza o cálculo da entrada")
  const requiredEntry = up((supplier + target) * BigInt(10000 + p.ipiBps), entryDenominator), minimumEntry = rounded(total * BigInt(p.minimumDownPaymentBps), 10000n), entry = input.downPaymentCents === null ? minimumEntry : BigInt(input.downPaymentCents)
  if (entry > total) invalid("Entrada não pode superar o total da venda")
  const discount = table - net, reasons: string[] = []
  const freeNet = input.items.reduce((sum, item, index) => sum + rounded(BigInt(sources[index]!.priceCents) * BigInt(10000 - p.freeDiscountBps), 10000n) * BigInt(item.quantity), 0n)
  if (net < freeNet) reasons.push("desconto-acima-do-livre")
  if (profit < 0n || rules.belowTarget && band !== "atTarget") reasons.push("fora-da-meta")
  if (rules.freight && BigInt(input.freightCents) > 0n) reasons.push("frete-por-nossa-conta")
  if (entry < minimumEntry) reasons.push("entrada-abaixo-da-politica")
  const retained = BigInt(10000 - p.incomeTaxBps), available = BigInt(10000 - tax - difal) * retained
  const minimum = (margin: number) => {
    const denominator = available - BigInt(margin) * 10000n
    return denominator > 0n ? ((cost + fixed) * 10000n * retained + denominator - 1n) / denominator : null
  }
  const minimumTarget = minimum(p.netMarginBps)
  if (minimumTarget === null) invalid("Destino sem margem comercial viável")
  const discountLimit = (margin: number) => {
    const min = minimum(margin)
    if (min === null) return 0
    const result = (table > min ? table - min : 0n) * 10000n / table
    return Number(result < 10000n ? result : 10000n)
  }
  const maximumAtTargetDiscountBps = discountLimit(p.netMarginBps), requiredDownPaymentCents = cents(requiredEntry), requiredBps = up(requiredEntry * 10000n, total)
  if (requiredBps > 4294967295n) invalid("Entrada necessária fora do limite")
  return {
    sale: { calculatorVersion: "ludus-order-v2-integer-cents", items, tableTotalCents: cents(table), discountCents: cents(discount), discountBps: Number(rounded(discount * 10000n, table)), netSaleCents: cents(net), ipiBps: p.ipiBps, ipiCents: cents(totalIpi), totalCents: cents(total), freeDiscountBps: p.freeDiscountBps, maximumAtTargetDiscountBps, requiredDownPaymentCents, minimumDownPaymentBps: p.minimumDownPaymentBps, minimumDownPaymentCents: cents(minimumEntry), downPaymentCents: cents(entry), freightCents: Number(input.freightCents), approvalReasons: reasons },
    director: { band, targetBps: p.netMarginBps, taxBps: tax, taxesCents: cents(taxes), difalBps: difal, difalCents: cents(difalAmount), equipmentCostCents: cents(cost), fixedFeeCents: Number(p.fixedOrderFeeCents), profitBeforeIncomeTaxCents: cents(beforeIr), incomeTaxCents: cents(ir), netProfitCents: cents(profit), netProfitBps: revisionValue(profit * 10000n / net), supplierPaymentCents: cents(supplier), targetProfitCents: cents(target), downPaymentCommissionCents: cents(requiredEntry - supplier - target), requiredDownPaymentCents, requiredDownPaymentBps: Number(requiredBps), minimumAtTargetCents: cents(rounded(minimumTarget * BigInt(10000 + p.ipiBps), 10000n)), maximumAtTargetDiscountBps, maximumNoLossDiscountBps: discountLimit(0), requiresDirector: profit < 0n || rules.managerLimit === "target" && band !== "atTarget" },
  }
}
