import { z } from "zod"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue, type Revision } from "../../platform/revision.js"
import { calculateNegotiation, negotiationInputSchema, type ApprovalRules, type NegotiationInput, type SourceItem } from "./negotiation-model.js"
import { commercialCents, invalidCommercial as invalid, rounded, up, simulateParameters, unsigned32, type CommercialParameters } from "./parameters.js"

const nullableText = z.string().nullable().default(null), uuid = z.string().uuid().transform(value => value.toLowerCase())
export const mixedInputSchema = negotiationInputSchema.omit({ line: true, versionId: true }).extend({ items: z.array(z.strictObject({ line: z.string(), versionId: uuid, productId: normalizedDatabaseId, quantity: unsigned32, structureColor: nullableText, swingArmColor: nullableText, plateHolderColor: nullableText, plateHolderType: nullableText, upholsteryColor: nullableText })) }).strict()
export type MixedInput = z.infer<typeof mixedInputSchema>
export type Policy = { line: string; versionId: string; version: Revision; parameters: CommercialParameters }
type QuotedLine = ReturnType<typeof calculateNegotiation>["sale"]["items"][number] & { line: string; versionId: string; ipiBps: number }
const moneyKeys = ["taxesCents", "difalCents", "equipmentCostCents", "fixedFeeCents", "profitBeforeIncomeTaxCents", "incomeTaxCents", "netProfitCents", "supplierPaymentCents", "targetProfitCents", "downPaymentCommissionCents", "minimumAtTargetCents"] as const
type MoneyKey = typeof moneyKeys[number]
function cents(value: bigint) { if (value < 0n) invalid("Valor comercial fora do limite"); return commercialCents(value) }
function common(values: number[]) { return values.length && values.every(value => value === values[0]) ? values[0]! : null }
function allocation(value: bigint, weights: bigint[]) {
  const sum = weights.reduce((sum, value) => sum + value, 0n), amounts = weights.map(weight => value * weight / sum)
  const order = weights.map((weight, index) => ({ index, remainder: value * weight % sum })).sort((left, right) => left.remainder > right.remainder ? -1 : left.remainder < right.remainder ? 1 : left.index - right.index)
  const remainder = Number(value - amounts.reduce((sum, value) => sum + value, 0n))
  for (const { index } of order.slice(0, remainder)) amounts[index] = amounts[index]! + 1n
  return amounts
}
function legacyItem(item: MixedInput["items"][number]): NegotiationInput["items"][number] {
  return { productId: item.productId, quantity: item.quantity, structureColor: item.structureColor, ...(item.swingArmColor === null ? {} : { swingArmColor: item.swingArmColor }), plateHolderColor: item.plateHolderColor, plateHolderType: item.plateHolderType, upholsteryColor: item.upholsteryColor }
}

function core(input: MixedInput, policies: Policy[], sources: SourceItem[], rules: ApprovalRules) {
  if (!input.items.length || input.items.length > 100 || sources.length !== input.items.length || !policies.length || policies.length > 2 || BigInt(input.freightCents) > 1000000000000n) invalid("Informe de 1 a 100 equipamentos e um frete válido")
  for (const policy of policies) {
    simulateParameters(policy.parameters)
    if (BigInt(policy.parameters.fixedOrderFeeCents) !== BigInt(policies[0]!.parameters.fixedOrderFeeCents)) throw new Problem(409, "domain_conflict", "As tabelas publicadas possuem taxas fixas diferentes. Ajuste e publique uma política comum antes de misturar as tabelas")
  }
  const seen = new Set<string>(), groups = policies.map(() => [] as number[])
  let table = 0n
  for (const [index, item] of input.items.entries()) {
    const source = sources[index]!
    if (item.productId !== source.productId || seen.has(item.productId) || item.quantity < 1 || item.quantity > 1000000 || BigInt(source.priceCents) <= 0n) invalid("Equipamento ou quantidade inválidos")
    seen.add(item.productId)
    const group = policies.findIndex(policy => policy.line === item.line && policy.versionId === item.versionId)
    if (group < 0) invalid("Origem comercial inválida")
    groups[group]!.push(index)
    table += BigInt(source.priceCents) * BigInt(item.quantity)
  }
  if (groups.some(group => !group.length)) invalid("Política sem itens")
  cents(table)
  const totalAt = (numerator: bigint, denominator: bigint) => groups.reduce((sum, indexes, group) => sum + indexes.reduce((sum, index) => sum + up(rounded(BigInt(sources[index]!.priceCents) * numerator, denominator) * BigInt(10000 + policies[group]!.parameters.ipiBps), 10000n) * BigInt(input.items[index]!.quantity), 0n), 0n)
  const value = BigInt(input.discount.value)
  let numerator: bigint, denominator: bigint
  if (input.discount.kind === "percent" && value < 10000n) { numerator = 10000n - value; denominator = 10000n }
  else if (input.discount.kind === "amount" && value < table) { numerator = table - value; denominator = table }
  else if (input.discount.kind === "total" && value > 0n && value <= totalAt(1n, 1n)) {
    let low = 0n, high = table
    while (low < high) { const mid = (low + high + 1n) / 2n; if (totalAt(mid, table) <= value) low = mid; else high = mid - 1n }
    numerator = low; denominator = table
  } else invalid("Desconto deve preservar uma venda positiva e não superar a tabela")
  const normalized = sources.map(source => {
    const priceCents = cents(rounded(BigInt(source.priceCents) * numerator, denominator))
    if (!priceCents) invalid("Desconto deixa um equipamento sem valor comercial")
    return { ...source, priceCents }
  })
  const weights = groups.map(indexes => indexes.reduce((sum, index) => sum + BigInt(normalized[index]!.priceCents) * BigInt(input.items[index]!.quantity), 0n))
  const freight = allocation(BigInt(input.freightCents), weights), fees = allocation(BigInt(policies[0]!.parameters.fixedOrderFeeCents), weights)
  const items: (QuotedLine | undefined)[] = Array(sources.length), publicGroups = [], privateGroups = [], reasons: string[] = []
  const moneyTotals = Object.fromEntries(moneyKeys.map(key => [key, 0n])) as Record<MoneyKey, bigint>
  let net = 0n, ipi = 0n, total = 0n, minimumEntry = 0n, requiredEntry = 0n, needsDirector = false
  for (const [group, indexes] of groups.entries()) {
    const policy = policies[group]!, parameters = { ...policy.parameters, fixedOrderFeeCents: fees[group]!, freeDiscountBps: 0 }
    const groupInput: NegotiationInput = { line: policy.line, versionId: policy.versionId, destinationState: input.destinationState, taxpayer: input.taxpayer, discount: { kind: "percent", value: 0 }, freightCents: freight[group]!, downPaymentCents: null, items: indexes.map(index => legacyItem(input.items[index]!)) }
    const { sale, director } = calculateNegotiation(parameters, rules, groupInput, indexes.map(index => normalized[index]!))
    const groupTable = indexes.reduce((sum, index) => sum + BigInt(sources[index]!.priceCents) * BigInt(input.items[index]!.quantity), 0n)
    const freeNet = indexes.reduce((sum, index) => sum + rounded(BigInt(sources[index]!.priceCents) * BigInt(10000 - policy.parameters.freeDiscountBps), 10000n) * BigInt(input.items[index]!.quantity), 0n)
    if (BigInt(sale.netSaleCents) < freeNet) sale.approvalReasons.push("desconto-acima-do-livre")
    const bounds = calculateNegotiation({ ...policy.parameters, fixedOrderFeeCents: fees[group]! }, rules, groupInput, indexes.map(index => sources[index]!)).director
    director.maximumAtTargetDiscountBps = bounds.maximumAtTargetDiscountBps; director.maximumNoLossDiscountBps = bounds.maximumNoLossDiscountBps
    net += BigInt(sale.netSaleCents); ipi += BigInt(sale.ipiCents); total += BigInt(sale.totalCents)
    minimumEntry += BigInt(sale.minimumDownPaymentCents); requiredEntry += BigInt(director.requiredDownPaymentCents); needsDirector ||= director.requiresDirector
    for (const reason of sale.approvalReasons) if (!reasons.includes(reason)) reasons.push(reason)
    for (const key of moneyKeys) moneyTotals[key] += BigInt(director[key])
    publicGroups.push({ line: policy.line, versionId: policy.versionId, version: policy.version, ipiBps: policy.parameters.ipiBps, freeDiscountBps: policy.parameters.freeDiscountBps, minimumDownPaymentBps: policy.parameters.minimumDownPaymentBps, tableTotalCents: cents(groupTable), netSaleCents: sale.netSaleCents, ipiCents: sale.ipiCents, totalCents: sale.totalCents, minimumDownPaymentCents: sale.minimumDownPaymentCents, freightCents: Number(freight[group]!), approvalReasons: sale.approvalReasons })
    privateGroups.push({ line: policy.line, versionId: policy.versionId, director })
    for (const [offset, index] of indexes.entries()) items[index] = { ...sale.items[offset]!, tableUnitCents: Number(sources[index]!.priceCents), line: policy.line, versionId: policy.versionId, ipiBps: policy.parameters.ipiBps }
  }
  const entry = input.downPaymentCents === null ? minimumEntry : BigInt(input.downPaymentCents)
  if (entry > total) invalid("Entrada não pode superar o total da venda")
  if (entry < minimumEntry) reasons.push("entrada-abaixo-da-politica")
  const band = needsDirector && privateGroups.some(group => group.director.band === "loss") ? "loss" : privateGroups.some(group => group.director.band !== "atTarget") ? "belowTarget" : "atTarget"
  const money = Object.fromEntries(moneyKeys.map(key => {
    if (moneyTotals[key] < -99999999999999n || moneyTotals[key] > 99999999999999n) invalid("Valor gerencial fora do limite")
    return [key, Number(moneyTotals[key])]
  })) as Record<MoneyKey, number>
  return {
    sale: { calculatorVersion: "ludus-mixed-order-v1-integer-cents", items: items.map(item => { if (!item) invalid("Origem comercial inválida"); return item }), totalCents: cents(total), netSaleCents: cents(net), downPaymentCents: cents(entry), approvalReasons: reasons, policyGroups: publicGroups, tableTotalCents: cents(table), discountCents: cents(table - net), discountBps: Number(rounded((table - net) * 10000n, table)), ipiBps: common(policies.map(policy => policy.parameters.ipiBps)), ipiCents: cents(ipi), freeDiscountBps: Math.min(...policies.map(policy => policy.parameters.freeDiscountBps)), minimumDownPaymentBps: common(policies.map(policy => policy.parameters.minimumDownPaymentBps)), minimumDownPaymentCents: cents(minimumEntry), requiredDownPaymentCents: cents(requiredEntry), freightCents: input.freightCents, maximumAtTargetDiscountBps: null as number | null },
    director: { requiresDirector: needsDirector, policyGroups: privateGroups, band, targetBps: common(policies.map(policy => policy.parameters.netMarginBps)), taxBps: common(privateGroups.map(group => group.director.taxBps)), difalBps: common(privateGroups.map(group => group.director.difalBps)), netProfitBps: revisionValue(moneyTotals.netProfitCents * 10000n / net), requiredDownPaymentCents: cents(requiredEntry), requiredDownPaymentBps: revisionValue(up(requiredEntry * 10000n, total)), maximumAtTargetDiscountBps: null as number | null, maximumNoLossDiscountBps: null as number | null, ...money },
  }
}

export function calculateMixed(input: MixedInput, policies: Policy[], sources: SourceItem[], rules: ApprovalRules) {
  const result = core(input, policies, sources, rules)
  for (const [name, target] of [["maximumAtTargetDiscountBps", true], ["maximumNoLossDiscountBps", false]] as const) {
    const allowed = (bps: number) => {
      try { return core({ ...input, discount: { kind: "percent", value: bps }, downPaymentCents: null }, policies, sources, rules).director.policyGroups.every(group => target ? group.director.band === "atTarget" : group.director.netProfitCents >= 0) }
      catch (error) { if (error instanceof Problem) return false; throw error }
    }
    let low = 0, high = 9999
    if (allowed(0)) while (low < high) { const mid = Math.ceil((low + high) / 2); if (allowed(mid)) low = mid; else high = mid - 1 }
    result.director[name] = low
    if (target) result.sale.maximumAtTargetDiscountBps = low
  }
  return result
}
