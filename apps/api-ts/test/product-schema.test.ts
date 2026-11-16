import assert from "node:assert/strict"
import test from "node:test"
import { productInputSchema } from "../src/modules/products/schema.js"

const input = { sku: " ld-a001 ", name: " Banco ", unit: " un ", basePrice: "1234.50", status: "active" }
test("product normalization preserves optional omission and canonicalizes legacy finishes", () => {
  const parsed = productInputSchema.parse({ ...input, armColors: [" Preto "], plateHolderColors: ["Preto"], plateHolderType: " STANDARD ", plateHolderTypes: ["Standard"] })
  assert.equal(parsed.sku, "LD-A001")
  assert.equal(parsed.ncm, null)
  assert.equal(parsed.name, "Banco")
  assert.deepEqual(parsed.plateHolderColors, ["Preto"])
  assert.deepEqual(parsed.plateHolderTypes, ["Standard"])
  assert.equal(Object.hasOwn(parsed, "armColors"), false)
  assert.equal(Object.hasOwn(parsed, "plateHolderType"), false)
  assert.equal(Object.hasOwn(productInputSchema.parse({ ...input, categoryId: null, structureColors: null }), "categoryId"), false)
  assert.equal(productInputSchema.parse({ ...input, categoryId: " " }).categoryId, "")
})
test("product prices and options reject coercion, wrong scale, duplicates and conflicting aliases", () => {
  for (const basePrice of ["1", "1.2", "01.00", "-1.00", "1e2", "0.001"]) assert.equal(productInputSchema.safeParse({ ...input, basePrice }).success, false, basePrice)
  for (const value of [{ structureColors: ["Preto", " preto "] }, { structureColors: ["A\u0000"] }, { plateHolderTypes: ["Standard", "Standard"] }, { armColors: ["Azul"], plateHolderColors: ["Preto"] }, { plateHolderType: "", plateHolderTypes: ["Standard"] }]) assert.equal(productInputSchema.safeParse({ ...input, ...value }).success, false)
})
test("product photo validation requires canonical base64 and JPEG markers", () => {
  const valid = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 1, 255, 217]).toString("base64")}`
  assert.equal(productInputSchema.parse({ ...input, photoDataUrl: valid }).photoDataUrl, valid)
  assert.equal(productInputSchema.parse({ ...input, photoDataUrl: "" }).photoDataUrl, "")
  for (const photoDataUrl of [valid + "!", `data:image/jpeg;base64,${Buffer.from([255, 216, 0, 255, 217]).toString("base64")}`, "data:image/png;base64,/9j/2Q=="]) assert.equal(productInputSchema.safeParse({ ...input, photoDataUrl }).success, false)
})
