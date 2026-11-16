import assert from "node:assert/strict"
import test from "node:test"
import { buildApp } from "../src/app.js"

test("API authentication precedes body parsing and valid requests authenticate once", async () => {
  let calls = 0, connections = 0
  const app = buildApp({ pool: { async connect() { connections++; throw new Error("No business connection expected") } }, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async () => { calls++; return Response.json({ sub: "subject-1", email: "user@example.test" }) } })
  const unauthenticated = await app.inject({ method: "PUT", url: "/api/v1/preferences", headers: { "content-type": "application/json", "if-match": '"1"' }, payload: "{" })
  assert.equal(unauthenticated.statusCode, 401, unauthenticated.body)
  assert.match(String(unauthenticated.headers["x-request-id"]), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  assert.equal(calls, 0)
  const malformed = await app.inject({ method: "PUT", url: "/api/v1/preferences", headers: { authorization: "Bearer valid", "content-type": "application/json", "if-match": '"1"' }, payload: "{" })
  assert.equal(malformed.statusCode, 422, malformed.body)
  assert.equal(malformed.headers["content-type"], "application/problem+json; charset=utf-8")
  assert.equal(calls, 1)
  assert.equal(connections, 0)
  for (const payload of ['{"__proto__":{}}', '{"constructor":{"prototype":{}}}', '{"productPageSize":1e400}']) {
    const invalid = await app.inject({ method: "PUT", url: "/api/v1/preferences", headers: { authorization: "Bearer valid", "content-type": "application/json", "if-match": '"1"' }, payload })
    assert.equal(invalid.statusCode, 422, invalid.body)
  }
  assert.equal(connections, 0)
  const noTenant = await app.inject({ method: "GET", url: "/api/v1/preferences", headers: { authorization: "Bearer valid" } })
  assert.equal(noTenant.statusCode, 400, noTenant.body)
  assert.equal(calls, 5, "Pre-authenticated requests must not repeat userinfo lookup in the handler")
  assert.equal((await app.inject({ method: "GET", url: "/health/live" })).statusCode, 200)
  const tracked = await app.inject({ method: "GET", url: "/health/live", headers: { "x-request-id": "upstream-request" } })
  assert.equal(tracked.headers["x-request-id"], "upstream-request")
  await app.close()
})
