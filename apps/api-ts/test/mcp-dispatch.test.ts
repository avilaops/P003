import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { buildApp, type AppDependencies } from "../src/app.js"
import { authorizeRequest } from "../src/platform/access.js"
import type { DatabaseClient, DatabasePool } from "../src/platform/database.js"

const tenant = "11111111-1111-4111-8111-111111111111"
const resource = "https://erp.avilaops.com/mcp"
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

function fixture() {
  let authCalls = 0
  const credentials = new Map([
    [digest("mcp_at_reader"), { subject: "reader", email: "reader@example.test", name: "Reader", verified_email: true, scope: "erp.read" }],
    [digest("mcp_at_writer"), { subject: "writer", email: "writer@example.test", name: "Writer", verified_email: true, scope: "erp.read erp.write" }],
  ])
  const pool: DatabasePool = { async connect() {
    const client: DatabaseClient = {
      async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        if (sql.includes("mcp_oauth_tokens")) return { rows: (credentials.has(String(values?.[0])) ? [credentials.get(String(values?.[0]))] : []) as unknown as T[] }
        if (sql.includes("FROM tenants tenant")) return { rows: [{ tenant_id: tenant, permissions: [] }] as unknown as T[] }
        return { rows: [] as T[] }
      },
      release() {},
    }
    return client
  } }
  const dependencies: AppDependencies & { mcpResource: string } = {
    pool, userinfoUrl: "http://auth.test/userinfo", mcpResource: resource,
    fetchAuth: async () => { authCalls += 1; return new Response(null, { status: 401 }) },
  }
  const app = buildApp(dependencies)
  app.get("/api/v1/mcp-test-context", request => authorizeRequest(request, dependencies, async context => ({ subject: context.identity.subject, tenantId: context.tenantId, requestId: request.headers["x-request-id"] })))
  app.post("/api/v1/mcp-test-context", request => authorizeRequest(request, dependencies, async context => ({ subject: context.identity.subject, tenantId: context.tenantId, body: request.body, revision: request.headers["if-match"], key: request.headers["idempotency-key"] })))
  const envelope = (method = "GET", path = "/api/v1/mcp-test-context") => ({ method, resource: path, headers: { "x-tenant-id": tenant, "x-request-id": "mcp-request-fixture" } as Record<string, string> })
  const dispatch = (token: string, payload: object) => app.inject({ method: "POST", url: "/internal/mcp/dispatch", headers: { authorization: `Bearer ${token}` }, payload })
  return { app, dependencies, envelope, dispatch, authCalls: () => authCalls }
}

test("private MCP ingress rejects invalid credentials before business access", async () => {
  const f = fixture()
  try {
    for (const token of ["invalid", "mcp_at_missing"]) {
      const response = await f.dispatch(token, f.envelope())
      assert.equal(response.statusCode, 401, response.body)
    }
    assert.equal(f.authCalls(), 0)
  } finally { await f.app.close() }
})

test("MCP ingress preserves identity and request ID without treating its token as an Auth token", async () => {
  const f = fixture()
  try {
    const response = await f.dispatch("mcp_at_reader", f.envelope())
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json(), { subject: "reader", tenantId: tenant, requestId: "mcp-request-fixture" })
    assert.equal(response.headers["x-erp-backend"], "typescript")
    assert.equal(f.authCalls(), 0)
    const direct = await f.app.inject({ method: "GET", url: "/api/v1/mcp-test-context", headers: { authorization: "Bearer mcp_at_reader", "x-tenant-id": tenant, "x-auth-subject": "reader" } })
    assert.equal(direct.statusCode, 401, direct.body)
    assert.equal(f.authCalls(), 1)
  } finally { await f.app.close() }
})

test("read scope cannot write; write dispatch preserves payload, revision and command", async () => {
  const f = fixture()
  try {
    const payload = { ...f.envelope("POST"), headers: { ...f.envelope().headers, "if-match": '"3"', "idempotency-key": "22222222-2222-4222-8222-222222222222", "content-type": "application/json" }, body: Buffer.from('{"value":7}').toString("base64") }
    assert.equal((await f.dispatch("mcp_at_reader", payload)).statusCode, 403)
    const response = await f.dispatch("mcp_at_writer", payload)
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json(), { subject: "writer", tenantId: tenant, body: { value: 7 }, revision: '"3"', key: payload.headers["idempotency-key"] })
  } finally { await f.app.close() }
})

test("private dispatch rejects arbitrary origins, recursive paths, forged identity headers and invalid base64", async () => {
  const f = fixture()
  try {
    for (const path of ["http://[invalid", "https://outside.test/api/v1/mcp-test-context", "//outside.test/api/v1/mcp-test-context", "/internal/mcp/dispatch", "/api/v1/../health/live", "/api/v1/missing"]) {
      const response = await f.dispatch("mcp_at_reader", f.envelope("GET", path))
      assert.ok([400, 404, 422].includes(response.statusCode), response.body)
    }
    for (const header of ["authorization", "host", "x-auth-subject"]) {
      const response = await f.dispatch("mcp_at_reader", { ...f.envelope(), headers: { ...f.envelope().headers, [header]: "forged" } })
      assert.equal(response.statusCode, 422, response.body)
    }
    assert.equal((await f.dispatch("mcp_at_writer", { ...f.envelope("POST"), body: "not base64!" })).statusCode, 422)
  } finally { await f.app.close() }
})

test("concurrent MCP dispatches retain distinct identities and cannot lend one to an ordinary request", { timeout: 3000 }, async () => {
  const f = fixture()
  let entered = 0
  let release!: () => void
  let bothEntered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { bothEntered = resolve })
  f.app.get("/api/v1/mcp-concurrent", request => authorizeRequest(request, f.dependencies, async context => {
    entered += 1
    if (entered === 2) bothEntered()
    await gate
    return { subject: context.identity.subject, tenantId: context.tenantId }
  }))
  try {
    const first = f.dispatch("mcp_at_reader", f.envelope("GET", "/api/v1/mcp-concurrent"))
    const second = f.dispatch("mcp_at_writer", f.envelope("GET", "/api/v1/mcp-concurrent"))
    // inject() is a lazy thenable; begin both requests before awaiting the barrier.
    const pending = Promise.all([first, second])
    await ready
    const ordinary = await f.app.inject({ method: "GET", url: "/api/v1/mcp-test-context", headers: { authorization: "Bearer invalid", "x-tenant-id": tenant, "x-auth-subject": "writer" } })
    assert.equal(ordinary.statusCode, 401)
    release()
    const results = await pending
    assert.deepEqual(results.map(response => response.json()), [{ subject: "reader", tenantId: tenant }, { subject: "writer", tenantId: tenant }])
    assert.equal(f.authCalls(), 1)
  } finally { release(); await f.app.close() }
})
