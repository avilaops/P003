import test from "node:test"
import assert from "node:assert/strict"
import { emptyOrderCustomerDraft, orderCustomerIssues } from "../src/features/sales/order-customer-model.ts"
import { groupOrderCustomerProgress } from "../src/features/sales/order-progress-summary.ts"

test("a customer who has yet to be chosen or registered has a single pending action", () => {
  const draft = emptyOrderCustomerDraft()
  const issues = orderCustomerIssues(draft)
  assert.ok(issues.length > 1)
  assert.deepEqual(groupOrderCustomerProgress(issues, { selected: false, creating: false }), [
    { field: "selection", message: "Selecione ou cadastre o cliente" },
  ])
})

test("registration progress distinguishes missing and invalid fields without changing validation", () => {
  const draft = { ...emptyOrderCustomerDraft(), personType: "fisica", legalName: "a".repeat(201), email: "inválido" }
  const issues = orderCustomerIssues(draft)
  const progress = groupOrderCustomerProgress(issues, { selected: false, creating: true, values: draft })
  assert.deepEqual(progress.map(issue => issue.field), issues.map(issue => issue.field))
  assert.equal(progress.find(issue => issue.field === "taxId")?.message, "Informe o CPF.")
  assert.equal(progress.find(issue => issue.field === "legalName")?.message, "Confira o nome completo.")
  assert.equal(progress.find(issue => issue.field === "phone")?.message, "Informe o celular.")
  assert.equal(progress.find(issue => issue.field === "email")?.message, "Informe um e-mail válido.")
  assert.match(issues.find(issue => issue.field === "legalName")?.message, /limite de 200 caracteres/)
})

test("a selected customer shows specific issues even with the editor closed", () => {
  const issues = [
    { field: "city", message: "O código IBGE não corresponde à UF. Consulte o CEP ou confira cidade e UF." },
    { field: "complement", message: "O campo contém caracteres inválidos ou ultrapassa o limite permitido." },
    { field: "futureField", message: "Confira o cadastro." },
  ]
  const state = { selected: true, creating: false }
  assert.deepEqual(groupOrderCustomerProgress(issues, state), [
    { field: "city", message: "Confira a cidade e a UF do código IBGE." },
    { field: "complement", message: "Confira o complemento." },
    { field: "futureField", message: "Confira o cadastro." },
  ])
  assert.deepEqual(groupOrderCustomerProgress([], state), [])
})
