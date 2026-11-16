import assert from "node:assert/strict"
import test from "node:test"
import { partyInputSchema } from "../src/modules/parties/schema.js"

const input = { personType: "fisica", legalName: " Cliente ", taxId: "529.982.247-25", isCustomer: true, isSupplier: false, status: "active" }
const address = { label: " Entrega ", postalCode: "01001-000", state: "sp", city: "São Paulo", street: "Praça", number: "1", district: "Centro", primary: true }

test("party normalization preserves omission, explicit null and optional contact defaults", () => {
  const result = partyInputSchema.parse(input)
  assert.equal(result.legalName, "Cliente")
  assert.equal(result.taxId, "52998224725")
  assert.equal(result.email, null)
  assert.equal(Object.hasOwn(result, "addresses"), false)
  assert.equal(Object.hasOwn(result, "fiscal"), false)
  assert.equal(partyInputSchema.parse({ ...input, fiscal: null }).fiscal, null)
  assert.equal(partyInputSchema.parse({ ...input, email: "user@host" }).email, "user@host")
  assert.equal(partyInputSchema.parse({ ...input, email: "  " }).email, null)
})

test("party validation rejects malformed documents, control characters and invalid role", () => {
  for (const change of [{ taxId: "!52998224725" }, { taxId: "11111111111" }, { legalName: "Nome\u0000" }, { email: "josé@example.test" }, { email: "a@@b" }, { isCustomer: false }, { unknown: true }]) assert.equal(partyInputSchema.safeParse({ ...input, ...change }).success, false, JSON.stringify(change))
})

test("addresses normalize CEP and UF, validate IBGE and enforce one primary", () => {
  const parsed = partyInputSchema.parse({ ...input, addresses: [{ ...address, municipalityCode: " 3550308 " }] })
  assert.deepEqual(parsed.addresses?.[0], { ...address, label: "Entrega", postalCode: "01001000", state: "SP", municipalityCode: "3550308", complement: null })
  const emptyCode = partyInputSchema.parse({ ...input, addresses: [{ ...address, municipalityCode: " " }] })
  assert.equal(JSON.stringify(emptyCode.addresses).includes("municipalityCode"), false)
  for (const addresses of [[address, address], [{ ...address, municipalityCode: "3304557" }], [{ ...address, state: "XX" }], [{ ...address, postalCode: "X01001000" }], null]) assert.equal(partyInputSchema.safeParse({ ...input, addresses }).success, false)
})

test("contacts and fiscal registration preserve Rust validation rules", () => {
  const contact = { name: " Maria ", email: "maria@example.test", primary: true }
  assert.deepEqual(partyInputSchema.parse({ ...input, contacts: [contact] }).contacts?.[0], { name: "Maria", email: "maria@example.test", primary: true, role: null, phone: null })
  for (const contacts of [[contact, contact], [{ name: "Maria" }], [{ name: "Maria", email: "user@host" }], null]) assert.equal(partyInputSchema.safeParse({ ...input, contacts }).success, false)
  assert.deepEqual(partyInputSchema.parse({ ...input, fiscal: { taxpayerIndicator: "2" } }).fiscal, { taxpayerIndicator: "2", stateRegistration: null })
  assert.equal(partyInputSchema.safeParse({ ...input, fiscal: { taxpayerIndicator: "1" } }).success, false)
  assert.equal(partyInputSchema.safeParse({ ...input, fiscal: { taxpayerIndicator: "2", stateRegistration: "123" } }).success, false)
})
