import assert from "node:assert/strict"
import test from "node:test"

import { buildApp } from "../src/app.js"
import type { DatabaseClient, DatabasePool } from "../src/platform/database.js"

const tenant = "11111111-1111-4111-8111-111111111111"
const ownerKey = "329d25bc9f344d27444906b624c3a801038a8ac62878991772519fee01a8969a"

test("preferences preserve Rust defaults, ETag, owner binding and audited revision updates", async () => {
  let stored: { revision: number; product_page_size: number; dashboard_layout: unknown } | undefined
  let auditWrites = 0
  const client: DatabaseClient = {
    async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
      if (sql.includes("FROM tenants tenant")) return { rows: [{ tenant_id: tenant, permissions: [] }] as unknown as T[] }
      if (sql.startsWith("SELECT revision,product_page_size")) return { rows: (stored ? [stored] : []) as unknown as T[] }
      if (sql.startsWith("INSERT INTO personal_preferences")) {
        stored = { revision: values[3] as number, product_page_size: values[2] as number, dashboard_layout: values[4] }
      }
      if (sql.startsWith("INSERT INTO audit_log")) auditWrites += 1
      return { rows: [] as T[] }
    },
    release() {},
  }
  const pool: DatabasePool = { async connect() { return client } }
  const app = buildApp({
    pool,
    userinfoUrl: "http://auth.test/oauth/userinfo",
    fetchAuth: async () => Response.json({ sub: "subject-1", email: "user@example.test", name: "Usuário", email_verified: true }),
  })
  const headers = { authorization: "Bearer valid", "x-tenant-id": tenant }

  const initial = await app.inject({ method: "GET", url: "/api/v1/preferences", headers })
  assert.equal(initial.statusCode, 200)
  assert.equal(initial.headers.etag, '"1"')
  assert.deepEqual(initial.json(), {
    ownerKey,
    tenantId: tenant,
    revision: 1,
    data: {
      productPageSize: 25,
      dashboardLayout: {
        favoritePaths: ["/vendas/pedidos", "/compras/pedidos", "/cadastros/clientes-fornecedores", "/cadastros/produtos", "/financeiro/contas-receber"],
        charts: ["Ticket médio", "Valor faturado"],
        period: "6M",
      },
    },
  })

  const updated = await app.inject({
    method: "PUT",
    url: "/api/v1/preferences",
    headers: { ...headers, "if-match": '"1"' },
    payload: {
      ownerKey,
      productPageSize: 50,
      dashboardLayout: { favoritePaths: ["/vendas/pedidos"], charts: ["Pedidos de venda"], period: "30D" },
    },
  })
  assert.equal(updated.statusCode, 200, updated.body)
  assert.equal(updated.headers.etag, '"2"')
  assert.equal(updated.json().revision, 2)
  assert.equal(updated.json().data.productPageSize, 50)
  assert.equal(auditWrites, 1)

  const stale = await app.inject({
    method: "PUT",
    url: "/api/v1/preferences",
    headers: { ...headers, "if-match": '"1"' },
    payload: { productPageSize: 10 },
  })
  assert.equal(stale.statusCode, 412)
  assert.equal(stale.json().type, "https://erp.avilaops.com/problems/revision_conflict")
  assert.equal(auditWrites, 1)

  const wrongOwner = await app.inject({
    method: "PUT",
    url: "/api/v1/preferences",
    headers: { ...headers, "if-match": '"2"' },
    payload: { ownerKey: "wrong", productPageSize: 25, dashboardLayout: { favoritePaths: [], charts: [], period: "7D" } },
  })
  assert.equal(wrongOwner.statusCode, 409)
  assert.equal(wrongOwner.json().type, "https://erp.avilaops.com/problems/domain_conflict")

  const invalid = await app.inject({
    method: "PUT",
    url: "/api/v1/preferences",
    headers: { ...headers, "if-match": '"2"' },
    payload: { productPageSize: 20, unknown: true },
  })
  assert.equal(invalid.statusCode, 422)

  const missingRevision = await app.inject({ method: "PUT", url: "/api/v1/preferences", headers, payload: { productPageSize: 25 } })
  assert.equal(missingRevision.statusCode, 428)
  assert.equal(auditWrites, 1)
})
