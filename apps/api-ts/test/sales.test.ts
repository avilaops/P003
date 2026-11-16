import assert from "node:assert/strict"
import test from "node:test"

import { buildApp } from "../src/app.js"
import type { DatabaseClient } from "../src/platform/database.js"

const tenant = "11111111-1111-4111-8111-111111111111"
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const headers = { authorization: "Bearer valid", "x-tenant-id": tenant }

test("sales lists preserve filters, public names, permissions and pagination", async () => {
  const client: DatabaseClient = { async query<T extends Record<string, unknown>>(sql: string) {
    if (sql.includes("FROM tenants tenant")) return { rows: [{ tenant_id: tenant, permissions: ["sales.orders.read", "sales.orders.manage", "sales.proposals.read", "sales.proposals.manage"] }] as unknown as T[] }
    if (sql.startsWith("SELECT count")) return { rows: [{ total: "1" }] as unknown as T[] }
    if (sql.includes("FROM sales_orders") && sql.startsWith("SELECT id")) return { rows: [{ id, number: "4", customer_id: id, customer_name: "Cliente", customer_tax_id: "04252011000110", due_date: "2026-12-01", amount: "100.00", status: "draft", revision: "2", updated_at: "2026-11-16T12:00:00Z", pricing_origin: false }] as unknown as T[] }
    if (sql.includes("FROM sales_proposals") && sql.startsWith("SELECT p.id")) return { rows: [{ id, number: "9", version: 1, revision: "3", customer_id: id, customer_name: "Cliente", customer_tax_id: "04252011000110", valid_until: "2026-12-31", payment_terms: "À vista", delivery_terms: "Entrega", notes: "", amount: "100.00", status: "draft", expired: false, order_id: null, is_current: true, created_at: "2026-11-16", updated_at: "2026-11-16", sent_at: null, decided_at: null, decided_by: null, decision_reason: null }] as unknown as T[] }
    return { rows: [] as T[] }
  }, release() {} }
  const app = buildApp({ pool: { async connect() { return client } }, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async () => Response.json({ sub: "subject-1", email: "user@example.test" }) })
  const orders = await app.inject({ method: "GET", url: "/api/v1/orders?q=PV-000004&status=draft&sort=updated", headers })
  assert.equal(orders.statusCode, 200, orders.body); assert.equal(orders.json().data[0].number, "4"); assert.equal(orders.json().data[0].customerName, "Cliente"); assert.equal(orders.json().canEdit, true)
  const proposals = await app.inject({ method: "GET", url: "/api/v1/proposals?status=draft", headers })
  assert.equal(proposals.statusCode, 200, proposals.body); assert.equal(proposals.json().data[0].validUntil, "2026-12-31"); assert.equal(proposals.json().total, 1)
  const invalid = await app.inject({ method: "GET", url: "/api/v1/orders?status=unknown", headers }); assert.equal(invalid.statusCode, 422)
})
