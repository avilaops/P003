import assert from "node:assert/strict"
import test from "node:test"

import { buildApp } from "../src/app.js"
import type { DatabaseClient, DatabasePool } from "../src/platform/database.js"

const tenant = "11111111-1111-4111-8111-111111111111"
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

test("registration lists preserve tenant, permissions, pagination and public field names", async () => {
  const client: DatabaseClient = {
    async query<T extends Record<string, unknown>>(sql: string) {
      if (sql.includes("FROM tenants tenant")) return { rows: [{ tenant_id: tenant, permissions: ["catalog.parties.read", "catalog.parties.manage", "catalog.products.read", "catalog.products.manage", "catalog.categories.read", "catalog.categories.manage"] }] as unknown as T[] }
      if (sql.startsWith("SELECT count(*)")) return { rows: [{ total: "1" }] as unknown as T[] }
      if (sql.includes("FROM parties")) return { rows: [{ id, revision: "2", person_type: "juridica", legal_name: "Cliente", trade_name: null, tax_id: "04252011000110", email: "cliente@example.test", phone: null, is_customer: true, is_supplier: false, status: "active", fiscal: null, addresses: [], contacts: [] }] as unknown as T[] }
      if (sql.includes("FROM products")) return { rows: [{ id, revision: "3", sku: "LD-001", name: "Equipamento", unit: "UN", ncm: null, cest: null, price_cents: "19990", status: "active", category_id: null, structure_colors: [], swing_arm_colors: [], finishing_palette: "", upholstery_colors: [], plate_holder_colors: [], plate_holder_types: [], plate_holder_type: "", main_media_id: null, upholstery_configurable: true, has_photo: false, photo_data_url: null }] as unknown as T[] }
      if (sql.includes("FROM registration_settings")) return { rows: [{ data: { upholsteryConfigurable: true } }] as unknown as T[] }
      if (sql.includes("FROM product_categories")) return { rows: [{ id, revision: "1", code: "FORCA", name: "Força", status: "active", notes: null, parent_id: null, sort_order: 10 }] as unknown as T[] }
      return { rows: [] as T[] }
    }, release() {},
  }
  const pool: DatabasePool = { async connect() { return client } }
  const app = buildApp({ pool, userinfoUrl: "http://auth.test/oauth/userinfo", fetchAuth: async () => Response.json({ sub: "subject-1", email: "user@example.test" }) })
  const headers = { authorization: "Bearer valid", "x-tenant-id": tenant }

  const parties = await app.inject({ method: "GET", url: "/api/v1/parties?q=cli&limit=25", headers })
  assert.equal(parties.statusCode, 200, parties.body)
  assert.deepEqual(parties.json(), { tenantId: tenant, canEdit: true, data: [{ id, revision: 2, personType: "juridica", legalName: "Cliente", tradeName: null, taxId: "04252011000110", email: "cliente@example.test", phone: null, isCustomer: true, isSupplier: false, status: "active", fiscal: null, addresses: [], contacts: [] }], total: 1, offset: 0, limit: 25 })

  const products = await app.inject({ method: "GET", url: "/api/v1/products?status=active", headers })
  assert.equal(products.statusCode, 200, products.body)
  assert.equal(products.json().data[0].basePrice, "199.90")
  assert.equal(products.json().data[0].sku, "LD-001")
  assert.equal(products.json().canEdit, true)

  const categories = await app.inject({ method: "GET", url: "/api/v1/product-categories", headers })
  assert.equal(categories.statusCode, 200, categories.body)
  assert.deepEqual(categories.json().data[0], { id, revision: 1, code: "FORCA", name: "Força", status: "active", notes: null, parentId: null, sortOrder: 10 })

  const invalid = await app.inject({ method: "GET", url: "/api/v1/products?limit=101", headers })
  assert.equal(invalid.statusCode, 422)
})

test("reference writes require command and revision headers and preserve optimistic updates", async () => {
  let revision = 1
  let exists = false
  let writes = 0
  const client: DatabaseClient = {
    async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
      if (sql.includes("FROM tenants tenant")) return { rows: [{ tenant_id: tenant, permissions: ["catalog.categories.read", "catalog.categories.manage"] }] as unknown as T[] }
      if (sql.includes("FROM domain_commands")) return { rows: [] as T[] }
      if (sql.startsWith("SELECT id,revision,code")) return { rows: exists ? [{ id, revision: String(revision), code: "FORCA", name: values.length ? "Força" : "Força", status: "active", notes: null, parent_id: null, sort_order: 10 }] as unknown as T[] : [] as T[] }
      if (sql.startsWith("INSERT INTO product_categories")) { exists = true; writes += 1 }
      if (sql.startsWith("UPDATE product_categories")) { revision += 1; writes += 1; return { rows: [{ affected: 1 }] as unknown as T[] } }
      return { rows: [] as T[] }
    }, release() {},
  }
  const pool: DatabasePool = { async connect() { return client } }
  const app = buildApp({ pool, userinfoUrl: "http://auth.test/oauth/userinfo", fetchAuth: async () => Response.json({ sub: "subject-1", email: "user@example.test" }) })
  const headers = { authorization: "Bearer valid", "x-tenant-id": tenant, "idempotency-key": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }
  const payload = { code: "FORCA", name: "Força", status: "active", notes: null, parentId: null, sortOrder: 10 }

  const created = await app.inject({ method: "POST", url: "/api/v1/product-categories", headers, payload })
  assert.equal(created.statusCode, 201, created.body)
  assert.equal(created.headers.etag, '"1"')
  const updated = await app.inject({ method: "PUT", url: `/api/v1/product-categories/${id}`, headers: { ...headers, "if-match": '"1"' }, payload: { ...payload, name: "Força livre" } })
  assert.equal(updated.statusCode, 200, updated.body)
  assert.equal(updated.headers.etag, '"2"')
  const stale = await app.inject({ method: "PUT", url: `/api/v1/product-categories/${id}`, headers: { ...headers, "if-match": '"1"' }, payload })
  assert.equal(stale.statusCode, 412)
  assert.equal(writes, 2)
})
