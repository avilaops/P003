import { Problem } from "../../platform/problem.js"
import { calculateNegotiation, type ApprovalRules, type NegotiationInput, type SourceItem } from "./negotiation-model.js"
import { STATES, type CommercialParameters } from "./parameters.js"

export type TableAuthority = { manager: boolean; director: boolean }
export type TableRow = { source: SourceItem; ipiBps: number; priceWithIpiCents: number | bigint; available: boolean }
export function authorityKind(authority: TableAuthority, rules: ApprovalRules | null) {
  return authority.director ? "director" : authority.manager ? rules?.managerLimit === "profit" ? "managerProfit" : "managerTarget" : "seller"
}
function quoteAt(parameters: CommercialParameters, rules: ApprovalRules, input: NegotiationInput, source: SourceItem, bps: number) {
  try { return calculateNegotiation(parameters, rules, { ...input, discount: { kind: "percent", value: bps } }, [source]) }
  catch (error) { if (error instanceof Problem) return null; throw error }
}
function tableLimit(parameters: CommercialParameters, rules: ApprovalRules, input: NegotiationInput, source: SourceItem, authority: TableAuthority) {
  const at = (bps: number) => {
    const result = quoteAt(parameters, rules, input, source, bps)
    return result && (!result.sale.approvalReasons.length || authority.director || authority.manager && !result.director.requiresDirector) ? result : null
  }
  if (!at(0)) return null
  let low = 0, high = 9999
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (at(middle)) low = middle; else high = middle - 1 }
  const result = at(low)
  return result ? { limit: low, price: result.sale.totalCents } : null
}
export function tableProjection(context: { parameters: CommercialParameters; rules: ApprovalRules | null; version: string; line: string; destination: string; taxpayer: boolean; globallyAvailable: boolean; authority: TableAuthority }, rows: TableRow[]) {
  const { parameters, rules, version, line, destination, taxpayer, globallyAvailable, authority } = context
  const bounds = Array.from({ length: 54 }, () => ({ limit: 9999 as number | null, count: 0 }))
  const items = rows.map(row => {
    const available = globallyAvailable && row.available
    let selected: { limit: number; price: number } | null = null, freePrice: number | null = null
    if (rules && available) {
      const input: NegotiationInput = { line, versionId: version, destinationState: destination, taxpayer, discount: { kind: "percent", value: parameters.freeDiscountBps }, freightCents: 0, downPaymentCents: null, items: [{ productId: row.source.productId, quantity: 1, structureColor: null, plateHolderColor: null, plateHolderType: null, upholsteryColor: null }] }
      freePrice = quoteAt(parameters, rules, input, row.source, parameters.freeDiscountBps)?.sale.totalCents ?? null
      for (const [stateIndex, state] of STATES.entries()) for (const [taxpayerIndex, condition] of [false, true].entries()) {
        input.destinationState = state; input.taxpayer = condition
        const limit = tableLimit(parameters, rules, input, row.source, authority)
        if (state === destination && condition === taxpayer) selected = limit
        const entry = bounds[stateIndex * 2 + taxpayerIndex]!
        entry.limit = entry.limit !== null && limit ? Math.min(entry.limit, limit.limit) : null
        entry.count++
      }
    }
    return { productId: row.source.productId, sku: row.source.sku, name: row.source.name, unit: row.source.unit, priceWithoutIpiCents: row.source.priceCents, ipiBps: row.ipiBps, priceWithIpiCents: row.priceWithIpiCents, available,
      unavailableReason: available ? null : !globallyAvailable ? "Confira os parâmetros e as regras de aprovação antes de negociar" : "Produto ou custo alterado, indisponível ou fora da tabela. Atualize e publique a tabela",
      freeDiscountPriceWithIpiCents: freePrice, maxOwnDiscountBps: selected?.limit ?? null, minOwnPriceWithIpiCents: selected?.price ?? null }
  })
  const destinations = STATES.flatMap((state, stateIndex) => [false, true].map((taxpayer, taxpayerIndex) => {
    const bound = bounds[stateIndex * 2 + taxpayerIndex]!
    return { state, taxpayer, maxOwnDiscountBps: bound.count > 0 ? bound.limit : null }
  }))
  return { items, destinations }
}
