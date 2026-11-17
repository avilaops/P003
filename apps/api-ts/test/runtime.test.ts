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
  assert.equal(loadConfiguration({ ...environment, ERP_FISCAL_ENGINE_URL: "http://127.0.0.1:8091" }).fiscalEngine, undefined)
  assert.equal(loadConfiguration({ ...environment, ERP_FISCAL_ENGINE_URL: "http://127.0.0.1:8091", NFSE_ISSUANCE_ENABLED: "true" }).fiscalEngine?.url, "http://127.0.0.1:8091")
  assert.throws(() => loadConfiguration({ DATABASE_URL: environment.DATABASE_URL, AUTH_ISSUER: environment.AUTH_ISSUER, NFSE_ISSUANCE_ENABLED: "true" }))
  assert.throws(() => loadConfiguration(environment))
  for (const url of ["https://127.0.0.1:8091", "http://engine.internal:8091", "http://user:secret@127.0.0.1:8091", "http://127.0.0.1:8091/path"]) {
    assert.throws(() => loadConfiguration({ ...environment, ERP_FISCAL_ENGINE_URL: url }))
  }
})
