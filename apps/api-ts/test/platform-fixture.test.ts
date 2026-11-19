import assert from "node:assert/strict"
import test from "node:test"
import { platformFixture } from "./platform-fixture.js"

test("fixture da plataforma: identidades, empresas e 401", { skip: !process.env.API_TS_TEST_ADMIN_URL }, async () => {
  const f = await platformFixture({ adminPermissions: ["system.custom_fields.read"] })
  try {
    assert.equal((await f.call({ method: "GET", url: "/api/v1/me", token: null })).statusCode, 401)
    assert.equal((await f.call({ method: "GET", url: "/api/v1/me" })).statusCode, 200)
    assert.equal((await f.call({ method: "GET", url: "/api/v1/me", token: "other" })).statusCode, 403)
  } finally { await f.close() }
})
