import assert from "node:assert/strict"
import test from "node:test"
import { proposalSimulationInput, proposalFiscalLabel, proposalTechnicalSummary } from "../src/features/sales/proposal-commercial-model.ts"

const table = (line, id, product) => ({ tenantId: "tenant", line, authority: "seller", data: { id, originState: "SP", items: [{ productId: product, available: true }] } })
const tables = [table("national", "national-version", "national-product"), table("imported", "imported-version", "imported-product")]
const customer = { personType: "fisica", fiscal: null, addresses: [{ state: "SP", primary: true }] }
const input = { destinationState: "SP", discount: { kind: "percent", value: 1000 }, freightCents: 0, downPaymentCents: null }

test("quote input combines both published tables and requires whole equipment quantities", () => {
  const result = proposalSimulationInput([{ id: "national-product", quantity: "2.000000" }, { id: "imported-product", quantity: "1" }], tables, customer, input)
  assert.deepEqual(result.items.map(({ productId, line, versionId, quantity }) => ({ productId, line, versionId, quantity })), [{ productId: "national-product", line: "national", versionId: "national-version", quantity: 2 }, { productId: "imported-product", line: "imported", versionId: "imported-version", quantity: 1 }])
  assert.equal(result.taxpayer, false)
  assert.throws(() => proposalSimulationInput([{ id: "national-product", quantity: "1.500000" }], tables, customer, input), /inteiras/)
  assert.throws(() => proposalSimulationInput([{ id: "national-product", quantity: "1" }, { id: "missing", quantity: "1" }], tables, customer, input), /tabela publicada/)
  assert.equal(proposalSimulationInput([{ id: "generic", quantity: "1.5" }], tables, customer, input), null)
})

test("PF and exempt PJ never receive contributor pricing; registered PJ does", () => {
  assert.equal(proposalFiscalLabel(customer), "Pessoa física • Não contribuinte")
  const pj = { ...customer, personType: "juridica", fiscal: { taxpayerIndicator: "1", stateRegistration: "12345" } }
  assert.equal(proposalFiscalLabel(pj), "Pessoa jurídica • Contribuinte de ICMS")
  assert.equal(proposalSimulationInput([{ id: "national-product", quantity: "1" }], tables, pj, input).taxpayer, true)
  assert.equal(proposalFiscalLabel({ ...pj, fiscal: { taxpayerIndicator: "2", stateRegistration: null } }), "Pessoa jurídica • Não contribuinte")
  assert.equal(proposalFiscalLabel({ ...pj, personType: "fisica" }), "Pessoa física • Não contribuinte")
})

test("technical summary distinguishes absent stack data from equipment without a stack", () => {
  assert.deepEqual(proposalTechnicalSummary({ dimensionsMm: [1500, 1200, 1400], weight: "150 kg", weightStack: "100 kg", category: "Bateria de pesos" }), { dimensions: "1.500 × 1.200 × 1.400 mm", weight: "Peso: 150 kg", stack: "Bateria: 100 kg" })
  assert.equal(proposalTechnicalSummary({ dimensionsMm: [1000, 500, 600], weight: "30 kg", weightStack: "", category: "Bancos e suportes" }).stack, "Bateria: não se aplica")
  assert.equal(proposalTechnicalSummary({ category: "Bateria de pesos", weightStack: "" }).stack, "Bateria: não informada")
})
