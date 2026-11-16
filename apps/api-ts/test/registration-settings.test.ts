import assert from "node:assert/strict"
import test from "node:test"
import { buildApp } from "../src/app.js"
import type { DatabaseClient } from "../src/platform/database.js"

const tenant = "11111111-1111-4111-8111-111111111111"
test("registration settings preserve defaults, company permissions, validation and revisions", async () => {
  const stored = new Map<string, { revision: number; data: unknown }>()
  let permissions = ["catalog.products.read"], audits = 0
  const client: DatabaseClient = { async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
    const rows = (value: Record<string, unknown>[]) => ({ rows: value as T[] })
    if (sql.includes("FROM tenants tenant")) return rows([{ tenant_id: tenant, permissions }])
    if (sql.includes("FROM registration_settings")) return rows(stored.has(String(values[1])) ? [stored.get(String(values[1]))!] : [])
    if (sql.startsWith("INSERT INTO registration_settings")) stored.set(String(values[1]), { data: values[2], revision: Number(values[3]) })
    if (sql.startsWith("INSERT INTO audit_log")) audits++
    return rows([])
  }, release() {} }
  const app = buildApp({ pool: { async connect() { return client } }, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async () => Response.json({ sub: "editor", email: "editor@example.test" }) })
  const headers = { authorization: "Bearer editor", "x-tenant-id": tenant }
  const get = await app.inject({ method: "GET", url: "/api/v1/registration-settings/products", headers })
  assert.equal(get.statusCode, 200, get.body)
  assert.equal(get.headers.etag, '"1"')
  assert.deepEqual(get.json(), { tenantId: tenant, revision: 1, canEdit: false, data: { requireNcm: false, requireCest: false } })
  const input = { requireNcm: true, requireCest: false }
  assert.equal((await app.inject({ method: "PUT", url: "/api/v1/registration-settings/products", headers: { ...headers, "if-match": '"1"' }, payload: input })).statusCode, 403)
  permissions = ["platform.company.manage"]
  const changed = await app.inject({ method: "PUT", url: "/api/v1/registration-settings/products", headers: { ...headers, "if-match": '"1"' }, payload: input })
  assert.equal(changed.statusCode, 200, changed.body)
  assert.equal(changed.headers.etag, '"2"')
  assert.equal(audits, 1)
  assert.equal((await app.inject({ method: "PUT", url: "/api/v1/registration-settings/products", headers: { ...headers, "if-match": '"1"' }, payload: input })).statusCode, 412)
  assert.equal((await app.inject({ method: "PUT", url: "/api/v1/registration-settings/products", headers, payload: input })).statusCode, 428)
  for (const [section, payload] of [["products", { ...input, admin: true }], ["contact-types", { labels: ["Financeiro", " financeiro "] }], ["tax-profiles", { profiles: [{ name: "Importados", operationNature: "Venda", pisRate: "100", cofinsRate: "7.6", ibsCbsCst: "000", classCode: "000001", active: true }] }]] as const) {
    assert.equal((await app.inject({ method: "PUT", url: `/api/v1/registration-settings/${section}`, headers: { ...headers, "if-match": '"1"' }, payload })).statusCode, 422)
  }
  const profile = { name: "Importados", operationNature: "Venda", pisRate: "1.65", cofinsRate: "7.6", ibsCbsCst: "000", classCode: "000001", active: true }
  const taxes = await app.inject({ method: "PUT", url: "/api/v1/registration-settings/tax-profiles", headers: { ...headers, "if-match": '"1"' }, payload: { profiles: [profile] } })
  assert.equal(taxes.statusCode, 200, taxes.body)
  assert.deepEqual(taxes.json().data.profiles[0], { ...profile, pisRate: "1.6500", cofinsRate: "7.6000" })
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/registration-settings/unknown", headers })).statusCode, 404)
  await app.close()
})
