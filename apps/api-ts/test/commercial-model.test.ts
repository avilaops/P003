import assert from "node:assert/strict"
import test from "node:test"
import { simulateParameters } from "../src/modules/commercial/parameters.js"
import { calculateNegotiation } from "../src/modules/commercial/negotiation-model.js"
import { commercialFixture } from "./commercial-fixture.js"

test("commercial parameters reproduce Rust managerial reference and destination limits", () => {
  const { parameters } = commercialFixture(), actual = simulateParameters(parameters)
  assert.equal(actual.worstState, "MA")
  assert.equal(actual.variableCostsBps, 3725)
  assert.equal(actual.discountedCostMultiplier.toFixed(3), "2.499")
  assert.equal(actual.tableCostMultiplier.toFixed(3), "3.123")
  assert.equal(actual.markupPercent.toFixed(1), "212.3")
  assert.equal(actual.destinationLimits.length, 53)
  assert.equal(simulateParameters({ ...parameters, freeDiscountBps: 3000, costSafetyBps: 0, ipiBps: 0 }).tableCostMultiplier.toFixed(3), "3.569")
  for (const invalid of [{ incomeTaxBps: 10000 }, { freeDiscountBps: 10000 }, { netMarginBps: 9000 }, { proposalValidityDays: 0 }, { stateRates: parameters.stateRates.slice(1) }]) assert.throws(() => simulateParameters({ ...parameters, ...invalid }))
})

test("commercial sale preserves integer IPI, entry and discount modes from Rust reference", () => {
  const { parameters, rules, input, sources } = commercialFixture(), { sale, director } = calculateNegotiation(parameters, rules, input, sources)
  assert.deepEqual([sale.netSaleCents, sale.ipiCents, sale.totalCents, sale.minimumDownPaymentCents], [1256323, 163322, 1419645, 993752])
  assert.equal(director.requiredDownPaymentCents, director.supplierPaymentCents + director.targetProfitCents + director.downPaymentCommissionCents)
  input.discount = { kind: "percent", value: 2000 }
  const discounted = calculateNegotiation(parameters, rules, input, sources).sale
  for (const discount of [{ kind: "amount", value: discounted.discountCents }, { kind: "total", value: discounted.totalCents }] as const) {
    const actual = calculateNegotiation(parameters, rules, { ...input, discount }, sources).sale
    assert.equal(actual.totalCents, discounted.totalCents)
    assert.equal(actual.approvalReasons.includes("desconto-acima-do-livre"), false)
  }
  input.items[0]!.quantity = 3
  input.discount = { kind: "total", value: 4258934 }
  assert.equal(calculateNegotiation(parameters, rules, input, sources).sale.totalCents, 4258932)
})

test("commercial unit rounding and desired caps stay consistent across multiple products", () => {
  const { parameters, rules, input, sources } = commercialFixture()
  input.items[0]!.quantity = 3; sources[0]!.priceCents = 30001
  input.items.push({ ...input.items[0]!, productId: "33333333-3333-4333-8333-333333333333", quantity: 2 })
  sources.push({ ...sources[0]!, productId: input.items[1]!.productId, priceCents: 50003 })
  const full = calculateNegotiation(parameters, rules, input, sources).sale
  assert.deepEqual(full.items.map(item => item.unitTotalCents), [33902, 56504])
  assert.equal(full.totalCents, 214714)
  for (const cap of [214714, 214713, 214710, 193243, 171772, 10]) {
    const actual = calculateNegotiation(parameters, rules, { ...input, discount: { kind: "total", value: cap } }, sources).sale
    assert.ok(actual.totalCents <= cap)
    assert.equal(actual.items.reduce((total, item) => total + item.totalCents, 0), actual.totalCents)
    for (const item of actual.items) assert.equal(item.totalCents, item.unitTotalCents * item.quantity)
  }
  for (const value of [0, 9, 214715]) assert.throws(() => calculateNegotiation(parameters, rules, { ...input, discount: { kind: "total", value } }, sources))
})

test("loss, explicit zero entry and invalid quantities cannot escape commercial guards", () => {
  const { parameters, rules, input, sources } = commercialFixture()
  const loss = calculateNegotiation(parameters, { ...rules, belowTarget: false }, { ...input, discount: { kind: "percent", value: 9900 }, downPaymentCents: 0 }, sources)
  assert.equal(loss.director.requiresDirector, true)
  assert.equal(loss.director.incomeTaxCents, 0)
  assert.ok(loss.sale.approvalReasons.includes("fora-da-meta"))
  assert.ok(loss.sale.approvalReasons.includes("entrada-abaixo-da-politica"))
  for (const quantity of [0, 1000001]) assert.throws(() => calculateNegotiation(parameters, rules, { ...input, items: [{ ...input.items[0]!, quantity }] }, sources))
  assert.throws(() => calculateNegotiation(parameters, rules, { ...input, discount: { kind: "percent", value: 10000 } }, sources))
  assert.throws(() => calculateNegotiation(parameters, rules, { ...input, items: [{ ...input.items[0]!, plateHolderType: "Cônico" }] }, sources))
})
