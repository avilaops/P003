import assert from "node:assert/strict"
import test from "node:test"
import { parseListQuery, queryInteger } from "../src/modules/registrations/query.js"
import { orderSearchNumber, queryInput } from "../src/modules/sales/shared.js"

test("query integers preserve Rust lexical and i64 order-number boundaries", () => {
  for (const input of ["", "1e1", "1.0", " 1", "0x10", ["1"], -1]) assert.equal(queryInteger(0, 100).safeParse(input).success, false)
  assert.equal(queryInteger(0, 100).parse("+0001"), 1)
  assert.equal(orderSearchNumber("pv-000004"), "4")
  assert.equal(orderSearchNumber("+1"), "1")
  assert.equal(orderSearchNumber("9223372036854775807"), "9223372036854775807")
  for (const input of ["0", "-1", "1.0", "1e30", "9223372036854775808"]) assert.equal(orderSearchNumber(input), null)
})

test("search limits count trimmed Unicode characters and preserve domain control rules", () => {
  const text = "😀".repeat(160)
  assert.equal(parseListQuery({ q: `   ${text}   ` }).q, text)
  assert.throws(() => parseListQuery({ q: `${text}a` }))
  assert.throws(() => queryInput({ q: "middle\tcontrol" }, [""]))
  assert.equal(queryInput({ q: "middle\tcontrol" }, [""], true).q, "middle\tcontrol")
  assert.throws(() => queryInput({ q: "middle\0control" }, [""], true))
})
