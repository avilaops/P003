import assert from "node:assert/strict"
import type { FastifyInstance } from "fastify"

export async function verifyAuthContract(app: FastifyInstance, tenant: string) {
  for (const token of ["auth-fixture-null-name", "auth-fixture-empty-name", "reader internal"]) {
    const response = await app.inject({ method: "GET", url: "/api/v1/orders", headers: { authorization: `Bearer ${token}`, "x-tenant-id": tenant } })
    assert.equal(response.statusCode, 200, `${token}: ${response.body}`)
  }
  for (const [authorization, status, code] of [["", 401, "invalid_token"], ["Bearer\treader", 401, "invalid_token"], ["Basic reader", 401, "invalid_token"], ["Bearer auth-fixture-created", 503, "auth_unavailable"], ["Bearer auth-fixture-denied", 401, "invalid_token"], ["Bearer auth-fixture-invalid", 503, "auth_unavailable"]] as const) {
    const response = await app.inject({ method: "GET", url: "/api/v1/orders", headers: { authorization, "x-tenant-id": tenant } })
    assert.equal(response.statusCode, status, response.body)
    assert.equal(response.json().type, `https://erp.avilaops.com/problems/${code}`)
  }
  const emptyTenant = await app.inject({ method: "GET", url: "/api/v1/orders", headers: { authorization: "Bearer reader", "x-tenant-id": "" } })
  assert.equal(emptyTenant.statusCode, 400)
  assert.equal(emptyTenant.json().type, "https://erp.avilaops.com/problems/invalid_tenant")
}
