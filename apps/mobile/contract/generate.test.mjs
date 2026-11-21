import assert from "node:assert/strict"
import { test } from "node:test"
import { renderKotlin, renderSwift, resolveOperations } from "./generate.mjs"

const contract = {
  paths: {
    "/api/v1/orders/{id}": { get: { operationId: "getApiV1OrdersId", parameters: [{ name: "id", in: "path" }], security: [{ bearerAuth: [], tenantHeader: [] }] } },
    "/api/v1/orders": { get: { operationId: "getApiV1Orders", parameters: [{ name: "q", in: "query" }], security: [{ bearerAuth: [], tenantHeader: [] }] } },
    "/health/live": { get: { operationId: "getHealthLive" } },
  },
}

test("lê método, caminho, parâmetros e exigência de empresa do contrato", () => {
  const [list, detail] = resolveOperations(contract, { operations: ["getApiV1OrdersId", "getApiV1Orders"] })
  assert.deepEqual(detail, { id: "getApiV1OrdersId", method: "GET", path: "/api/v1/orders/{id}", pathParameters: ["id"], queryParameters: [], requiresTenant: true, pendingOn: null })
  assert.deepEqual(list.queryParameters, ["q"])
  assert.equal(resolveOperations(contract, { operations: ["getHealthLive"] })[0].requiresTenant, false)
})

test("falha quando o app usa uma operação que saiu do contrato", () => {
  assert.throws(() => resolveOperations(contract, { operations: ["getApiV1Removed"] }), /não existe/)
})

test("exige mover de pending para operations quando a rota chega ao contrato", () => {
  assert.throws(() => resolveOperations(contract, { operations: [], pending: { getApiV1Orders: { method: "GET", path: "/api/v1/orders", waitingFor: "#1" } } }), /mova de pending/)
  assert.throws(() => resolveOperations(contract, { operations: [], pending: { getApiV1X: { method: "GET", path: "/api/v1/x" } } }), /waitingFor/)
})

test("operações pendentes saem marcadas nos dois clientes", () => {
  const operations = resolveOperations(contract, { operations: ["getApiV1Orders"], pending: { getApiV1Companies: { method: "GET", path: "/api/v1/companies", requiresTenant: false, waitingFor: "#283" } } })
  const kotlin = renderKotlin(operations), swift = renderSwift(operations)
  assert.match(kotlin, /aguardando #283/)
  assert.match(kotlin, /val all: List<ErpOperation> = listOf\(getApiV1Companies, getApiV1Orders\)/)
  assert.match(swift, /pendingOn: "#283"/)
  assert.match(swift, /requiresTenant: false/)
})
