import assert from "node:assert/strict"
import test from "node:test"
import { parseRevision, nextRevision, revisionValue } from "../src/platform/revision.js"
import { parseJson, stringifyJson, sameJson } from "../src/platform/json.js"
import { Problem } from "../src/platform/problem.js"

test("revision preconditions preserve positive signed i64 without rounding", () => {
  assert.equal(parseRevision('"0001"'), 1)
  assert.equal(parseRevision('"9007199254740993"'), 9007199254740993n)
  assert.equal(parseRevision('"9223372036854775807"'), 9223372036854775807n)
  for (const input of ['"9223372036854775808"', '"0"', '"-1"', 'W/"1"', '1']) assert.throws(() => parseRevision(input), (error: unknown) => error instanceof Problem && error.status === 400)
  assert.throws(() => parseRevision(undefined), (error: unknown) => error instanceof Problem && error.status === 428)
  assert.equal(nextRevision(9007199254740991), 9007199254740992n)
  assert.throws(() => nextRevision(9223372036854775807n), (error: unknown) => error instanceof Problem && error.status === 500)
  assert.equal(revisionValue("9007199254740993"), 9007199254740993n)
})

test("JSON and replay preserve integer tokens beyond the JS safe range", () => {
  const raw = '{"revision":9007199254740993,"input":{"name":"Registro"}}'
  assert.equal(parseJson(raw).revision, 9007199254740993n)
  assert.equal(stringifyJson(parseJson(raw)), raw)
  assert.equal(sameJson(parseJson(raw), { input: { name: "Registro" }, revision: 9007199254740993n }), true)
  assert.equal(sameJson(parseJson(raw), { input: { name: "Registro" }, revision: 9007199254740992n }), false)
  assert.equal(parseJson("18446744073709551615"), 18446744073709551615n)
  assert.equal(typeof parseJson("18446744073709551616"), "number")
  assert.throws(() => parseJson("1e400"), SyntaxError)
})
