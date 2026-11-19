import assert from "node:assert/strict"
import test from "node:test"
import { buildApp } from "../src/app.js"
import { loadConfiguration } from "../src/platform/config.js"

test("runtime uses the configured userinfo URL and keeps its private listener defaults", () => {
  const environment = { DATABASE_URL: "postgresql://app@localhost/test", AUTH_ISSUER: "https://auth.example.test", AUTH_USERINFO_URL: "https://auth.example.test/custom/userinfo" }
  const config = loadConfiguration(environment)
  assert.equal(config.userinfoUrl, environment.AUTH_USERINFO_URL)
  assert.equal(config.host, "127.0.0.1")
  assert.equal(config.port, 8081)
  assert.equal(loadConfiguration({ DATABASE_URL: environment.DATABASE_URL, AUTH_ISSUER: environment.AUTH_ISSUER }).userinfoUrl, "https://auth.example.test/oauth/userinfo")
  assert.throws(() => loadConfiguration({ ...environment, AUTH_USERINFO_URL: "https://foreign.example.test/userinfo" }))
  assert.throws(() => loadConfiguration({ ...environment, AUTH_USERINFO_URL: "https://user:secret@auth.example.test/userinfo" }))
})

test("readiness checks the real database, releases its connection and exposes no internal failure", async () => {
  let failure = false, released = 0, authCalls = 0
  const app = buildApp({ pool: { async connect() { return { async query(sql) { assert.equal(sql, "SELECT 1"); if (failure) throw Error("private database detail"); return { rows: [] } }, release() { released++ } } } }, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async () => { authCalls++; throw Error("Unexpected auth") } })
  try {
    const ready = await app.inject({ method: "GET", url: "/health/ready" })
    assert.equal(ready.statusCode, 200)
    assert.deepEqual(ready.json(), { status: "ready" })
    failure = true
    const unavailable = await app.inject({ method: "GET", url: "/health/ready" })
    assert.equal(unavailable.statusCode, 503)
    assert.equal(unavailable.body.includes("private database detail"), false)
    assert.equal(released, 2)
    assert.equal(authCalls, 0)
    assert.match(unavailable.headers["cache-control"]!, /no-store/)
  } finally { await app.close() }
})

test("MCP resource uses the validated ERP origin without credentials, path or insecure remote transport", () => {
  const environment = { DATABASE_URL: "postgresql://app@localhost/test", AUTH_ISSUER: "https://auth.example.test" }
  assert.equal(loadConfiguration(environment).mcpResource, "https://erp.avilaops.com/mcp")
  assert.equal(loadConfiguration({ ...environment, ERP_MCP_ORIGIN: "http://127.0.0.1:3333" }).mcpResource, "http://127.0.0.1:3333/mcp")
  for (const origin of ["https://user:secret@erp.example.test", "https://erp.example.test/path", "https://erp.example.test?query=1", "https://erp.example.test#fragment", "http://outside.example.test"]) {
    assert.throws(() => loadConfiguration({ ...environment, ERP_MCP_ORIGIN: origin }))
  }
})

test("fiscal credentials are complete and can only be sent to the loopback engine", () => {
  const environment = { DATABASE_URL: "postgresql://app@localhost/test", AUTH_ISSUER: "https://auth.example.test", ERP_FISCAL_ENGINE_TOKEN: "x".repeat(24), FISCAL_A1_KEYRING: "{}" }
  assert.deepEqual(loadConfiguration({ ...environment, ERP_FISCAL_ENGINE_URL: "http://127.0.0.1:8091" }).fiscalEngine, { url: "http://127.0.0.1:8091", token: "x".repeat(24), keyring: "{}", automaticEnabled: false })
  assert.equal(loadConfiguration({ ...environment, ERP_FISCAL_ENGINE_URL: "http://127.0.0.1:8091", NFSE_ISSUANCE_ENABLED: "true" }).fiscalEngine?.automaticEnabled, true)
  assert.throws(() => loadConfiguration({ DATABASE_URL: environment.DATABASE_URL, AUTH_ISSUER: environment.AUTH_ISSUER, NFSE_ISSUANCE_ENABLED: "true" }))
  assert.throws(() => loadConfiguration(environment))
  for (const url of ["https://127.0.0.1:8091", "http://engine.internal:8091", "http://user:secret@127.0.0.1:8091", "http://127.0.0.1:8091/path"]) {
    assert.throws(() => loadConfiguration({ ...environment, ERP_FISCAL_ENGINE_URL: url }))
  }
})

test("Browser Use stays disabled unless its server-side key is configured", () => {
  const environment = { DATABASE_URL: "postgres://erp:erp@127.0.0.1:5432/erp", AUTH_ISSUER: "https://auth.example.test" }
  assert.equal("browserUseApiKey" in loadConfiguration(environment), false)
  assert.equal("browserUseApiKey" in loadConfiguration({ ...environment, BROWSER_USE_API_KEY: "   " }), false)
  assert.equal(loadConfiguration({ ...environment, BROWSER_USE_API_KEY: " bu_test_key " }).browserUseApiKey, "bu_test_key")
})

test("rota ainda não portada responde 404 claro sem autenticar nem consultar o banco", async () => {
  let authCalls = 0, connections = 0
  const app = buildApp({ pool: { async connect() { connections++; throw Error("Unexpected database") } }, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async () => { authCalls++; throw Error("Unexpected auth") } })
  try {
    for (const method of ["GET", "POST"] as const) {
      const response = await app.inject({ method, url: "/api/v1/staff?secret=1" })
      assert.equal(response.statusCode, 404)
      assert.match(response.headers["content-type"] as string, /^application\/problem\+json/)
      assert.deepEqual(response.json(), { type: "https://erp.avilaops.com/problems/route_not_ported", title: "Rota inexistente ou ainda não portada para a API TypeScript", status: 404, error: "route_not_ported", path: "/api/v1/staff" })
    }
    assert.equal(authCalls + connections, 0)
  } finally { await app.close() }
})
