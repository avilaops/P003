import assert from "node:assert/strict"
import test from "node:test"
import { selectColor } from "../src/modules/orders/prepare.js"
import { fixed, decimal, validateDate } from "../src/modules/sales/fixed.js"

test("order decimal arithmetic preserves six-place quantities and exact rounding inputs", () => {
  const amount = (fixed("100.01", 2) * fixed("1.234567", 6) + 500000n) / 1000000n
  assert.equal(decimal(amount, 2), "123.47")
  for (const value of ["1", "01.000000", "1.1234567", "1e6", "-1.000000"]) assert.throws(() => fixed(value, 6))
  assert.equal(validateDate("2000-02-29"), "2000-02-29")
  for (const value of ["1900-02-29", "2026-02-30", "2101-01-01", "2026-1-01"]) assert.throws(() => validateDate(value))
})
test("order colors require current choices but preserve historical agreements", () => {
  assert.equal(selectColor(" preto ", ["Preto"], undefined), "Preto")
  assert.equal(selectColor(undefined, [], "Cor antiga"), "Cor antiga")
  assert.equal(selectColor("Cor antiga", ["Preto"], "Cor antiga"), "Cor antiga")
  assert.equal(selectColor(undefined, [], undefined), null)
  assert.throws(() => selectColor(undefined, ["Preto"], undefined))
  assert.throws(() => selectColor("Azul", ["Preto"], "Cor antiga"))
})
