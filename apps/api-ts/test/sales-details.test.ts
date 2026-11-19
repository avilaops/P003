import assert from "node:assert/strict"
import test from "node:test"

import { buildApp } from "../src/app.js"
import type { DatabaseClient } from "../src/platform/database.js"

const tenant = "11111111-1111-4111-8111-111111111111"
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const missing = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const headers = { authorization: "Bearer valid", "x-tenant-id": tenant }

function fixture(kind: "order" | "proposal", withCheckout = false) {
  const revisions: unknown[] = []
  const client: DatabaseClient = {
    async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
      const result = (rows: Record<string, unknown>[]) => ({ rows: rows as T[] })
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return result([])
      if (sql.includes("FROM tenants tenant")) return result([{ tenant_id: tenant, permissions: [`sales.${kind === "order" ? "orders" : "proposals"}.read`] }])
      assert.equal(values[0], tenant, "Every business query must use the active tenant")
      if (values[1] === missing) return result([])
      if (sql.includes("FROM sales_orders") && sql.startsWith("SELECT id")) return result([{ id, number: "4", revision: "2", customer_id: id, customer_name: "Cliente", customer_tax_id: "04252011000110", due_date: "2026-12-01", amount: "100.00", status: "draft", updated_at: "2026-11-16T12:00:00Z", pricing_origin: true }])
      if (sql.includes("FROM sales_order_lines")) return result([{ product_id: id, sku: "LD-1", name: "Banco", unit: "UN", quantity: "1.000000", unit_price: "100.00", amount: "100.00", equipment_weight: null, structure_color: "Preto", swing_arm_color: null, plate_holder_color: null, plate_holder_type: null, upholstery_color: null }])
      if (sql.includes("FROM sales_order_checkouts")) return result(withCheckout ? [{ customer_snapshot: { legalName: "Cliente", stateRegistration: "123456" }, entry_amount_cents: "2000", entry_payment_method_id: id, entry_payment_method: { id, code: "PIX", name: "Pix", modality: "pix" }, entry_due_on: "2026-12-01", manufacturing_days: 30, delivery_notes: "Entrega", payment_notes: "", notes: "" }] : [])
      if (sql.includes("FROM sales_order_installments")) return result([{ id, number: 0, payment_method_id: id, payment_method: {}, due_on: "2026-12-02", amount_cents: "2000" }, { id, number: 1, payment_method_id: id, payment_method: { id, code: "PIX", name: "Pix", modality: "pix" }, due_on: "2026-12-31", amount_cents: "8000" }])
      if (sql.includes("FROM receivables")) return result([{ originated: true }])
      if (sql.includes("FROM production_orders o")) return result([])
      if (sql.includes("FROM sales_proposals")) {
        if (sql.includes("COALESCE($3")) revisions.push(values[2])
        return result([{ id, number: "9", version: values[2] ?? 2, revision: "3", customer_id: id, customer_name: "Cliente", customer_tax_id: "04252011000110", valid_until: "2026-12-31", payment_terms: "À vista", delivery_terms: "Entrega", notes: "", amount: "100.00", status: "draft", expired: false, order_id: null, is_current: values[2] !== 1, created_at: "2026-11-16", updated_at: "2026-11-16", sent_at: null, decided_at: null, decided_by: null, decision_reason: null }])
      }
      if (sql.includes("FROM sales_proposal_lines")) { assert.equal(values[2], 1); return result([{ product_id: id, sku: "LD-1", name: "Banco", unit: "UN", quantity: "1.000000", unit_price: "100.00", catalog_price: "100.00", amount: "100.00", structure_color: null, upholstery_color: null, swing_arm_color: null, plate_holder_color: null, plate_holder_type: null }]) }
      throw new Error(`Unexpected query: ${sql}`)
    }, release() {},
  }
  return { app: buildApp({ pool: { async connect() { return client } }, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async () => Response.json({ sub: "subject-1", email: "user@example.test" }) }), revisions }
}

test("order detail preserves optional finishes, read-only access and saved checkout", async () => {
  const { app } = fixture("order", true)
  const response = await app.inject({ method: "GET", url: `/api/v1/orders/${id}`, headers })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.headers.etag, '"2"')
  const body = response.json()
  assert.equal(body.canEdit, false)
  assert.equal(body.pricingOrigin, true)
  assert.deepEqual(body.items[0], { productId: id, sku: "LD-1", name: "Banco", unit: "UN", quantity: "1.000000", unitPrice: "100.00", amount: "100.00", equipmentWeight: null, equipmentDimensions: null, structureColor: "Preto" })
  assert.equal(body.checkout.confirmationCreatesReceivables, false)
  assert.equal(body.checkout.entry.dueOn, "2026-12-02")
  assert.equal(body.checkout.entry.amountCents, 2000)
  assert.equal(body.checkout.installments.length, 1)
  assert.equal(body.checkout.installments[0].amountCents, 8000)
  assert.equal(body.checkout.stateRegistration, "123456")
  assert.equal((await app.inject({ method: "GET", url: `/api/v1/orders/${missing}`, headers })).statusCode, 404)
  await app.close()
  const noCheckout = fixture("order").app
  const empty = await noCheckout.inject({ method: "GET", url: `/api/v1/orders/${id}`, headers })
  assert.equal(empty.statusCode, 200, empty.body)
  assert.equal(Object.hasOwn(empty.json(), "checkout"), false)
  await noCheckout.close()
})

test("proposal detail selects a historical version and preserves explicit null fields", async () => {
  const { app, revisions } = fixture("proposal")
  const response = await app.inject({ method: "GET", url: `/api/v1/proposals/${id}?version=1`, headers })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.headers.etag, '"3"')
  assert.equal(response.json().canEdit, false)
  assert.equal(response.json().data.version, 1)
  assert.equal(response.json().data.isCurrent, false)
  assert.equal(response.json().items[0].structureColor, null)
  assert.equal(response.json().items[0].upholsteryColor, null)
  assert.equal(Object.hasOwn(response.json().items[0], "swingArmColor"), false)
  assert.deepEqual(revisions, [1])
  assert.equal((await app.inject({ method: "GET", url: `/api/v1/proposals/${missing}`, headers })).statusCode, 404)
  for (const query of ["version=0", "version=1.5", "version=2147483648", "unknown=1"]) assert.equal((await app.inject({ method: "GET", url: `/api/v1/proposals/${id}?${query}`, headers })).statusCode, 422)
  await app.close()
})
