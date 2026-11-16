import { STATES, type CommercialParameters } from "../src/modules/commercial/parameters.js"
import type { NegotiationInput, SourceItem } from "../src/modules/commercial/negotiation-model.js"

export function commercialFixture() {
  const parameters: CommercialParameters = {
    originState: "SP", netMarginBps: 1500, freeDiscountBps: 2000, costSafetyBps: 500, minimumDownPaymentBps: 7000, proposalValidityDays: 7,
    domesticIcmsBps: 1800, pisCofinsBps: 925, ipiBps: 1300, incomeTaxBps: 3400, commissionBps: 200, adsBps: 50, gatewayBps: 0, otherFeesBps: 0, interstateBps: 400, lossBps: 100, warrantyBps: 150, badDebtBps: 0, fixedOrderFeeCents: 0, monthlyExpensesCents: 0,
    stateRates: STATES.map(state => ({ state, internalBps: state === "MA" ? 2300 : 1800, fcpBps: 0, outgoingBps: null })),
  }
  const rules = { belowTarget: true, freight: false, directorAutoApproval: false, managerLimit: "profit" as const }
  const input: NegotiationInput = {
    line: "imported", versionId: "11111111-1111-4111-8111-111111111111", destinationState: "SP", taxpayer: false, discount: { kind: "percent", value: 0 }, freightCents: 0, downPaymentCents: null,
    items: [{ productId: "22222222-2222-4222-8222-222222222222", quantity: 1, structureColor: null, plateHolderColor: null, plateHolderType: null, upholsteryColor: null }],
  }
  const sources: SourceItem[] = [{ productId: input.items[0]!.productId, sku: "LD-A001", name: "Equipamento", unit: "UN", productRevision: 1, costRevision: 1, priceCents: 1256323, purchaseCents: 530606, creditBps: 2780, packagingCents: 0 }]
  return { parameters, rules, input, sources }
}
