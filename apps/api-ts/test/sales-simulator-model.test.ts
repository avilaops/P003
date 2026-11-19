import assert from "node:assert/strict"
import test from "node:test"
import { Problem } from "../src/platform/problem.js"
import { quote, type PublishedCost, type QuoteInput } from "../src/modules/sales-simulator/model.js"
import { commercialFixture } from "./commercial-fixture.js"

// Fixed values come from the Rust reference (pricing_model_tests.rs); the policy is its example().
const example = () => commercialFixture().parameters
const cost: PublishedCost = { purchaseCostCents: 10000, taxCreditBps: 1000, packagingCents: 100 }
const id = "11111111-1111-4111-8111-111111111111"
const input = (patch: Partial<QuoteInput> = {}): QuoteInput => ({ versionId: id, productId: id, quantity: 2, destination: "SP", taxpayer: false, discount: { kind: "percent", value: 0 }, freightCents: 0, ...patch })
const rejects = (action: () => unknown) => assert.throws(action, error => error instanceof Problem && error.status === 422)

test("quote reproduces cost credit, safety, IPI, income tax and funding", () => {
  const { sale, director } = quote(input(), 20000, cost, example())
  assert.equal(sale.netSaleCents, 40000)
  assert.equal(sale.invoiceTotalCents, 45200)
  assert.equal(sale.minimumDownPaymentCents, 31640)
  assert.equal(director.equipmentCostCents, 19100)
  assert.equal(director.profitBeforeIncomeTaxCents, 8000)
  assert.equal(director.incomeTaxCents, 2720)
  assert.equal(director.netProfitCents, 5280)
  assert.equal(director.netProfitBps, 1320)
  assert.equal(director.supplierPaymentCents, 21000)
  assert.equal(director.targetProfitCents, 6000)
  assert.equal(director.requiredDownPaymentCents, 27487)
  assert.equal(sale.band, "below_target")
  assert.equal(director.atTargetBps, null)
})

test("fixed fee is charged once, freight affects profit and a loss pays no income tax", () => {
  const { sale, director } = quote(input({ freightCents: 100000 }), 20000, cost, { ...example(), fixedOrderFeeCents: 333 })
  assert.equal(sale.band, "loss")
  assert.equal(director.fixedFeeCents, 333)
  assert.equal(director.profitBeforeIncomeTaxCents, -92333)
  assert.equal(director.incomeTaxCents, 0)
  assert.equal(director.netProfitCents, -92333)
  assert.equal(director.noLossBps, null)
  assert.equal(sale.needsApproval, true)
})

test("discount modes round to consistent units without exceeding the desired total", () => {
  const percent = quote(input({ quantity: 3, discount: { kind: "percent", value: 1000 } }), 20000, cost, example())
  const amount = quote(input({ quantity: 3, discount: { kind: "amount", value: 6000 } }), 20000, cost, example())
  assert.equal(percent.sale.invoiceTotalCents, amount.sale.invoiceTotalCents)
  const target = quote(input({ quantity: 3, discount: { kind: "target", value: 61001 } }), 20000, cost, example()).sale
  assert.ok(target.invoiceTotalCents <= 61001)
  assert.equal(target.invoiceTotalCents, target.unitWithIpiCents * 3)
  assert.equal(target.netSaleCents + target.ipiCents, target.invoiceTotalCents)
})

test("discount limits are exact for destination, taxpayer and quantity", () => {
  for (const destination of ["SP", "MA", "SC"]) for (const taxpayer of [true, false]) for (const quantity of [1, 3, 30]) {
    const base = { destination, taxpayer, quantity, freightCents: 317 }
    const band = (value: number) => quote(input({ ...base, discount: { kind: "percent", value } }), 30000, cost, example()).sale.band
    const { atTargetBps, noLossBps } = quote(input(base), 30000, cost, example()).director
    assert.equal(band(atTargetBps!), "at_target")
    assert.notEqual(band(atTargetBps! + 1), "at_target")
    assert.notEqual(band(noLossBps!), "loss")
    assert.equal(band(noLossBps! + 1), "loss")
  }
})

test("quote rejects invalid inputs and overflow with 422", () => {
  for (const discount of [{ kind: "percent", value: 10000 }, { kind: "amount", value: -1 }, { kind: "amount", value: 40000 }, { kind: "target", value: 0 }, { kind: "target", value: 45201 }] as const)
    rejects(() => quote(input({ discount }), 20000, cost, example()))
  rejects(() => quote(input({ quantity: 0 }), 20000, cost, example()))
  rejects(() => quote(input({ quantity: 1000001 }), 20000, cost, example()))
  rejects(() => quote(input({ quantity: 1000000 }), 1000000000000, cost, example()))
  rejects(() => quote(input({ quantity: 1, freightCents: -1 }), 20000, cost, example()))
  rejects(() => quote(input({ quantity: 1, destination: "XX" }), 20000, cost, example()))
})

test("one-cent rounding keeps the composition consistent", () => {
  for (const price of [1, 2, 3, 7, 101, 12345, 20001]) {
    const { sale: s, director: d } = quote(input({ quantity: 1 }), price, cost, example())
    assert.equal(s.netSaleCents - d.icmsCents - d.pisCofinsCents - d.channelCents - d.provisionsCents - d.equipmentCostCents - d.fixedFeeCents - s.freightCents - d.roundingCents, d.profitBeforeIncomeTaxCents)
    assert.equal(d.profitBeforeIncomeTaxCents - d.incomeTaxCents, d.netProfitCents)
  }
})

test("zero discount preserves the published IPI with half-up rounding", () => {
  const { sale } = quote(input({ quantity: 1 }), 10001, cost, example())
  assert.deepEqual([sale.unitWithoutIpiCents, sale.unitWithIpiCents, sale.invoiceTotalCents], [10001, 11301, 11301])
})

test("the free discount boundary does not ask approval for sub-cent rounding", () => {
  const percent = quote(input({ quantity: 1, discount: { kind: "percent", value: 2000 } }), 1256323, cost, example()).sale
  assert.equal(percent.needsApproval, false)
  assert.equal(percent.discountBps, 2000)
  const same = quote(input({ quantity: 1, discount: { kind: "amount", value: percent.discountCents } }), 1256323, cost, example()).sale
  assert.equal(same.needsApproval, false)
  const beyond = quote(input({ quantity: 1, discount: { kind: "amount", value: percent.discountCents + 1 } }), 1256323, cost, example()).sale
  assert.ok(beyond.approvalReasons.includes("discount_above_free"))
})
