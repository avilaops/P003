import assert from "node:assert/strict"
import test from "node:test"
import type { RunCreateBody, RunSummary } from "browser-use-sdk/v4"
import { buildApp } from "../src/app.js"
import { BROWSER_USE_PERMISSION, type BrowserUseDependencies } from "../src/modules/browser-use/routes.js"
import type { BrowserUseRuns } from "../src/platform/browser-use.js"
import type { DatabaseClient, DatabasePool } from "../src/platform/database.js"

const tenant = "11111111-1111-4111-8111-111111111111"
const runId = "00000000-0000-4000-8000-000000000001"
const url = "/api/v1/integrations/browser-use/runs"
const headers = { authorization: "Bearer valid", "x-tenant-id": tenant, "content-type": "application/json" }

function fakePool(permissions: string[]) {
  const statements: string[] = []
  let released = 0
  const client: DatabaseClient = {
    async query<T extends Record<string, unknown>>(sql: string) {
      statements.push(sql)
      if (sql.includes("permissions")) return { rows: [{ tenant_id: tenant, permissions }] as unknown as T[] }
      return { rows: [] as T[] }
    },
    release() { released++ },
  }
  const pool = { async connect() { return client } } as unknown as DatabasePool
  return { pool, statements, released: () => released }
}

function completed(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: runId, task: "t", title: "t", model: "bu-4.0", contextLimit: 0, status: "completed", result: "Resultado",
    error: null, sessionId: "00000000-0000-4000-8000-000000000002", workspaceId: null, totalInputTokens: 1, totalOutputTokens: 1,
    totalCostUsd: "0.03", createdAt: "2026-11-18T00:00:00Z", updatedAt: "2026-11-18T00:00:05Z", ...overrides,
  } as RunSummary
}

function fakeRuns(wait: () => Promise<RunSummary> = async () => completed()) {
  const created: RunCreateBody[] = [], cancelled: string[] = []
  const runs = {
    async create(body: RunCreateBody) { created.push(body); return { id: runId, status: "queued" } },
    async waitForCompletion() { return wait() },
    async cancel(id: string) { cancelled.push(id); return completed({ status: "cancelled" }) },
  } as unknown as BrowserUseRuns
  return { runs, created, cancelled }
}

function app(permissions: string[], browserUse?: BrowserUseDependencies) {
  const database = fakePool(permissions)
  const instance = buildApp({
    pool: database.pool,
    userinfoUrl: "http://auth.test/userinfo",
    fetchAuth: async () => Response.json({ sub: "subject-1", email: "admin@example.test", email_verified: true }),
    ...(browserUse ? { browserUse } : {}),
  })
  return { instance, database }
}

test("company administrators run a capped task and get the validated result", async () => {
  const fake = fakeRuns()
  const { instance, database } = app([BROWSER_USE_PERMISSION], { runs: fake.runs })
  const response = await instance.inject({ method: "POST", url, headers, payload: JSON.stringify({ task: " Encontre a manchete principal " }) })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.headers["cache-control"], "no-store")
  assert.deepEqual(response.json(), { runId, sessionId: "00000000-0000-4000-8000-000000000002", result: "Resultado", totalCostUsd: "0.03" })
  assert.deepEqual(fake.created, [{ task: "Encontre a manchete principal", maxCostUsd: 1 }])
  assert.equal(database.statements.some(sql => sql.includes("FOR UPDATE")), false, "Permission check must not lock the tenant during a long run")
  assert.equal(database.released(), 1)
  await instance.close()
})

test("an explicit model is forwarded unchanged", async () => {
  const fake = fakeRuns()
  const { instance } = app([BROWSER_USE_PERMISSION], { runs: fake.runs })
  const response = await instance.inject({ method: "POST", url, headers, payload: JSON.stringify({ task: "t", model: "bu-ultrafast" }) })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(fake.created[0]?.model, "bu-ultrafast")
  await instance.close()
})

test("users without the company permission cannot start runs", async () => {
  const fake = fakeRuns()
  const { instance } = app(["sales.orders.read"], { runs: fake.runs })
  const response = await instance.inject({ method: "POST", url, headers, payload: JSON.stringify({ task: "t" }) })
  assert.equal(response.statusCode, 403, response.body)
  assert.equal(fake.created.length, 0)
  await instance.close()
})

test("unauthenticated requests are rejected before any run", async () => {
  const fake = fakeRuns()
  const { instance } = app([BROWSER_USE_PERMISSION], { runs: fake.runs })
  const response = await instance.inject({ method: "POST", url, headers: { "x-tenant-id": tenant, "content-type": "application/json" }, payload: JSON.stringify({ task: "t" }) })
  assert.equal(response.statusCode, 401, response.body)
  assert.equal(fake.created.length, 0)
  await instance.close()
})

test("invalid bodies are rejected without spending", async () => {
  const fake = fakeRuns()
  const { instance } = app([BROWSER_USE_PERMISSION], { runs: fake.runs })
  for (const payload of [{ task: "   " }, { task: "t", extra: true }, { task: "x".repeat(4_001) }, {}]) {
    const response = await instance.inject({ method: "POST", url, headers, payload: JSON.stringify(payload) })
    assert.equal(response.statusCode, 422, response.body)
  }
  assert.equal(fake.created.length, 0)
  await instance.close()
})

test("returns 503 when the integration is not configured", async () => {
  const { instance } = app([BROWSER_USE_PERMISSION])
  const response = await instance.inject({ method: "POST", url, headers, payload: JSON.stringify({ task: "t" }) })
  assert.equal(response.statusCode, 503, response.body)
  assert.equal(response.json().type, "https://erp.avilaops.com/problems/integration_unavailable")
  await instance.close()
})

test("maps failed runs to 502 and abandoned runs to 504 after cancelling", async () => {
  const failed = fakeRuns(async () => completed({ status: "failed", result: null, error: "blocked" }))
  const first = app([BROWSER_USE_PERMISSION], { runs: failed.runs })
  const failure = await first.instance.inject({ method: "POST", url, headers, payload: JSON.stringify({ task: "t" }) })
  assert.equal(failure.statusCode, 502, failure.body)
  assert.equal(failure.json().type, "https://erp.avilaops.com/problems/integration_failed")
  assert.doesNotMatch(failure.body, /blocked/, "Upstream error text is not echoed to the client")
  await first.instance.close()

  const slow = fakeRuns(async () => { throw new Error("timed out") })
  const second = app([BROWSER_USE_PERMISSION], { runs: slow.runs, timeoutMs: 5 })
  const timeout = await second.instance.inject({ method: "POST", url, headers, payload: JSON.stringify({ task: "t" }) })
  assert.equal(timeout.statusCode, 504, timeout.body)
  assert.deepEqual(slow.cancelled, [runId])
  await second.instance.close()
})
