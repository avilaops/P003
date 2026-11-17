import assert from "node:assert/strict"
import test from "node:test"
import { orderInputSchema } from "../src/modules/orders/schema.js"
import { proposalId, proposalInputSchema } from "../src/modules/proposals/schema.js"

// Imported catalog rows carry deterministic identifiers that Postgres stores as uuid
// but that do not follow the RFC 9562 version/variant nibbles.
const importedIds = ["23951779-D8C5-30DF-2E2A-C909B08D7832", "5a72ce2e-ffda-cde8-b182-efb3aa9309ce"]

test("sales inputs accept imported identifiers outside the RFC 9562 version and variant ranges", () => {
  for (const id of importedIds) {
    const order = orderInputSchema.parse({ customerId: id, dueDate: "2026-12-01", items: [{ productId: id, quantity: "1" }] })
    assert.equal(order.items[0]?.productId, id.toLowerCase())
    const proposal = proposalInputSchema.parse({ customerId: id, validUntil: "2026-12-01", paymentTerms: "", deliveryTerms: "", notes: "", items: [{ productId: id, quantity: "1" }] })
    assert.equal(proposal.items[0]?.productId, id.toLowerCase())
    assert.equal(proposalId(id), id.toLowerCase())
  }
})

test("sales inputs still reject values that are not 8-4-4-4-12 hexadecimal identifiers", () => {
  for (const id of ["not-a-uuid", "23951779d8c530df2e2ac909b08d7832", "23951779-d8c5-30df-2e2a-c909b08d783g"]) {
    assert.equal(orderInputSchema.safeParse({ customerId: id, dueDate: "2026-12-01", items: [] }).success, false)
    assert.throws(() => proposalId(id))
  }
})
