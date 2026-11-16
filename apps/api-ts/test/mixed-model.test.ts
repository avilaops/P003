import assert from "node:assert/strict"
import test from "node:test"
import { calculateMixed, type MixedInput, type Policy } from "../src/modules/commercial/mixed-model.js"
import { commercialFixture } from "./commercial-fixture.js"

export function mixedFixture() {
  const { parameters, rules, sources: base } = commercialFixture()
  const policies: Policy[] = ["imported", "national"].map((line, index) => ({ line, versionId: `00000000-0000-4000-8000-00000000001${index}`, version: 1, parameters: { ...parameters, ipiBps: index ? 0 : 1300, fixedOrderFeeCents: 101, minimumDownPaymentBps: index ? 3000 : 7000 } }))
  const items = policies.map((policy, index) => ({ line: policy.line, versionId: policy.versionId, productId: `00000000-0000-4000-8000-00000000000${index}`, quantity: 3, structureColor: null, swingArmColor: null, plateHolderColor: null, plateHolderType: null, upholsteryColor: null }))
  const input: MixedInput = { destinationState: "SP", taxpayer: false, discount: { kind: "percent", value: 0 }, freightCents: 103, downPaymentCents: null, items }
  const sources = items.map((item, index) => ({ ...base[0]!, productId: item.productId, sku: `TEST-${index}`, priceCents: index ? 17003 : 30001, purchaseCents: 1000, creditBps: 0 }))
  return { input, policies, sources, rules }
}

test("mixed policies conserve freight, fixed fees, item totals and different entries/IPI", () => {
  const { input, policies, sources, rules } = mixedFixture(), { sale, director } = calculateMixed(input, policies, sources, rules)
  assert.equal(sale.totalCents, 152715)
  assert.equal(sale.ipiBps, null)
  assert.equal(sale.minimumDownPaymentBps, null)
  assert.equal(sale.items.reduce((sum, item) => sum + item.totalCents, 0), sale.totalCents)
  assert.equal(sale.policyGroups.reduce((sum, group) => sum + group.freightCents, 0), 103)
  assert.equal(director.policyGroups.reduce((sum, group) => sum + group.director.fixedFeeCents, 0), 101)
  assert.equal(director.fixedFeeCents, 101)
  assert.equal(sale.downPaymentCents, sale.policyGroups.reduce((sum, group) => sum + group.minimumDownPaymentCents, 0))
  assert.ok(!JSON.stringify(sale).includes("fixedFeeCents"))
})

test("mixed discounts share a ratio and never exceed the desired total after rounding", () => {
  const { input, policies, sources, rules } = mixedFixture()
  const percent = calculateMixed({ ...input, discount: { kind: "percent", value: 1000 } }, policies, sources, rules).sale
  const amount = calculateMixed({ ...input, discount: { kind: "amount", value: 14101 } }, policies, sources, rules).sale
  assert.equal(percent.totalCents, amount.totalCents)
  const target = calculateMixed({ ...input, discount: { kind: "total", value: 120000 } }, policies, sources, rules).sale
  assert.ok(target.totalCents <= 120000)
  for (const item of target.items) assert.equal(item.totalCents, item.unitTotalCents * item.quantity)
  const incompatible = structuredClone(policies)
  incompatible[1]!.parameters.fixedOrderFeeCents = 102
  assert.throws(() => calculateMixed(input, incompatible, sources, rules))
})

test("one losing mixed group requires a director even when aggregate profit is positive", () => {
  const { input, policies, sources, rules } = mixedFixture()
  sources[1]!.purchaseCents = 20000
  const { sale, director } = calculateMixed(input, policies, sources, rules)
  assert.equal(director.requiresDirector, true)
  assert.ok(director.netProfitCents > 0)
  assert.ok(sale.approvalReasons.includes("fora-da-meta"))
})
