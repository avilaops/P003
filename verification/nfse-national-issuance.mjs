import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

const required = name => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const origin = new URL(required("ERP_NFSE_VERIFY_API_URL"))
if (origin.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) || origin.pathname !== "/") {
  throw new Error("ERP_NFSE_VERIFY_API_URL must be a loopback HTTP origin")
}
const token = required("ERP_NFSE_VERIFY_TOKEN")
const tenant = required("ERP_NFSE_VERIFY_TENANT")
assert.match(tenant, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

const response = await fetch(new URL("/api/v1/integrations/nfse/issuances", origin), {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "x-tenant-id": tenant,
    "idempotency-key": randomUUID(),
    "content-type": "application/json",
  },
  body: JSON.stringify({
    externalId: `production-block-check-${Date.now()}`,
    environment: "production",
    competenceDate: "2026-11-17",
    amount: "1.00",
    serviceCode: "010701",
    description: "Verificação segura de bloqueio de produção",
    customer: { name: "Fixture sem transmissão", taxId: "52998224725" },
  }),
  signal: AbortSignal.timeout(10_000),
})
const body = await response.json()
assert.equal(response.status, 409, JSON.stringify(body))
assert.equal(body.type, "https://erp.avilaops.com/problems/nfse_production_disabled", JSON.stringify(body))
console.log(JSON.stringify({ status: "passed", check: "nfse_production_remains_blocked", tenant }))
