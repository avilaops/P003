import assert from "node:assert/strict"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import test from "node:test"

import type { AuthorizedContext } from "../src/platform/access.js"
import type { DatabaseClient } from "../src/platform/database.js"
import type { OutgoingNfseEngine } from "../src/modules/outgoing-nfse/engine-client.js"
import { finishIssuance, startIssuance } from "../src/modules/outgoing-nfse/service.js"
import { FiscalCertificateVault } from "../src/modules/outgoing-nfse/certificate-vault.js"
import { buildApp } from "../src/app.js"

const tenant = "11111111-1111-4111-8111-111111111111"
const issuance = "22222222-2222-4222-8222-222222222222"
const input = {
  externalId: "invoice-2026-0001", environment: "homologation", competenceDate: "2026-11-17", amount: "1234.56",
  serviceCode: "010701", description: "Consultoria em tecnologia",
  customer: { name: "Cliente", taxId: "52998224725", email: "financeiro@example.test" },
} as const

test("outgoing NFS-e start binds tenant, stores command before transport and finalizes uncertainty without XML", async () => {
  const statements: string[] = []
  const client: DatabaseClient = {
    async query<T extends Record<string, unknown>>(sql: string) {
      statements.push(sql)
      if (sql.startsWith("SELECT scope,request,result")) return { rows: [] }
      if (sql.startsWith("SELECT tax_id,legal_name")) return { rows: [{ tax_id: "04252011000110", legal_name: "Ávila Ops" }] as unknown as T[] }
      if (sql.startsWith("INSERT INTO fiscal_outgoing_nfse_sequences")) return { rows: [{ number: "1" }] as unknown as T[] }
      if (sql.startsWith("SELECT external_id,status,revision")) return { rows: [{ external_id: input.externalId, status: "processing", revision: "1" }] as unknown as T[] }
      return { rows: [] }
    },
    release() {},
  }
  const context: AuthorizedContext = {
    client, tenantId: tenant, authSubject: "service-app", permissions: ["fiscal.outgoing_nfse.issue"],
    identity: { subject: "service-app", email: "service@example.test", name: "Serviço", emailVerified: true },
  }
  const engine: OutgoingNfseEngine = {
    async prepare() { return { id: "DPS354340220425201100011000001000000000000001" } },
    async issue() { throw new Error("not called by start") },
    async consult() { throw new Error("not called") },
    async cancel() { throw new Error("not called") },
  }
  const started = await startIssuance(context, { "x-request-id": "request-1" }, "33333333-3333-4333-8333-333333333333", input, engine, async () => ({ issuerTaxId: "04252011000110", certificate: { pkcs12Base64: "AA==", password: "secret" } }))
  assert.equal(started.prepared?.id, "DPS354340220425201100011000001000000000000001")
  assert.ok(statements.some(sql => sql.startsWith("INSERT INTO domain_commands")), "command must commit before external transport")
  const body = await finishIssuance(context, { "x-request-id": "request-1" }, issuance, "33333333-3333-4333-8333-333333333333", { status: "uncertain", code: "timeout", reason: "Consulta obrigatória" })
  assert.equal(body.data.status, "uncertain")
  const update = statements.find(sql => sql.startsWith("UPDATE fiscal_outgoing_nfse_issuances"))
  assert.match(update ?? "", /xml=\$5/)
})

test("outgoing NFS-e replays the stored command and never prepares or transmits again", async () => {
  let prepared = 0
  const replayed = { tenantId: tenant, data: { id: issuance, externalId: input.externalId, status: "authorized", revision: 2, accessKey: "1".repeat(50) } }
  const client: DatabaseClient = {
    async query<T extends Record<string, unknown>>(sql: string) {
      if (sql.startsWith("SELECT scope,request,result")) return { rows: [{ scope: "fiscal.outgoing_nfse.issue", request: input, result: replayed }] as unknown as T[] }
      return { rows: [] }
    }, release() {},
  }
  const context = { client, tenantId: tenant, authSubject: "service-app", permissions: ["fiscal.outgoing_nfse.issue"], identity: { subject: "service-app", email: "service@example.test", name: "Serviço", emailVerified: true } }
  const engine = { async prepare() { prepared++; return {} }, async issue() { throw new Error() }, async consult() { throw new Error() }, async cancel() { throw new Error() } }
  const result = await startIssuance(context, {}, "33333333-3333-4333-8333-333333333333", input, engine, async () => { throw new Error("certificate must not load") })
  assert.deepEqual(result.replayed, replayed)
  assert.equal(prepared, 0)
})

test("TypeScript opens the existing Rust AES-GCM fiscal certificate envelope", async () => {
  const key = randomBytes(32), nonce = randomBytes(12), now = Math.floor(Date.now() / 1000)
  const metadata = {
    subject: "CN=Ávila", issuer: "CN=ICP", taxId: "04252011000110", fingerprint: "ab", serialNumber: "01",
    validFrom: now - 60, validUntil: now + 3600, validatedAt: now - 60, chainVerified: true, revocationChecked: false,
  }
  const aad = Buffer.from(`avila-erp:fiscal-a1:v1:${tenant}:1:${createHash("sha256").update(Buffer.from(JSON.stringify(metadata))).digest("hex")}`)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(aad)
  const plaintext = Buffer.from(JSON.stringify({ pkcs12: [1, 2, 3], password: "secret" }))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  const vault = new FiscalCertificateVault(JSON.stringify({ active: "key-1", keys: { "key-1": key.toString("base64") } }))
  const client: DatabaseClient = {
    async query<T extends Record<string, unknown>>() { return { rows: [{ tax_id: metadata.taxId, revision: "1", metadata, encryption_key_id: "key-1", nonce, ciphertext }] as unknown as T[] } }, release() {},
  }
  const result = await vault.material({ client, tenantId: tenant, authSubject: "service-app", permissions: [], identity: { subject: "service-app", email: "service@example.test", name: "Serviço", emailVerified: true } })
  assert.deepEqual(result, { issuerTaxId: metadata.taxId, certificate: { pkcs12Base64: "AQID", password: "secret" } })
})

test("private NFS-e HTTP command authenticates, authorizes, emits once and replays", async () => {
  let command: { scope: string; request: unknown; result: Record<string, unknown> } | undefined
  let savedIssuance = "", issueCalls = 0
  const client: DatabaseClient = {
    async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) {
      if (sql.includes("FROM tenants tenant") && sql.includes("permissions")) return { rows: [{ tenant_id: tenant, permissions: ["fiscal.outgoing_nfse.issue"] }] as unknown as T[] }
      if (sql.startsWith("SELECT scope,request,result")) return { rows: command ? [command] as unknown as T[] : [] }
      if (sql.startsWith("SELECT tax_id,legal_name")) return { rows: [{ tax_id: "04252011000110", legal_name: "Ávila Ops" }] as unknown as T[] }
      if (sql.startsWith("INSERT INTO fiscal_outgoing_nfse_sequences")) return { rows: [{ number: "1" }] as unknown as T[] }
      if (sql.startsWith("INSERT INTO fiscal_outgoing_nfse_issuances")) savedIssuance = String(values[1])
      if (sql.startsWith("INSERT INTO domain_commands")) command = { scope: String(values[3]), request: values[4], result: values[5] as Record<string, unknown> }
      if (sql.startsWith("SELECT external_id,status,revision")) return { rows: [{ external_id: input.externalId, status: "processing", revision: "1" }] as unknown as T[] }
      if (sql.startsWith("UPDATE domain_commands") && command) command.result = values[3] as Record<string, unknown>
      return { rows: [] }
    }, release() {},
  }
  const engine: OutgoingNfseEngine = {
    async prepare() { return { id: "DPS354340220425201100011000001000000000000001" } },
    async issue() { issueCalls++; return { status: "authorized", accessKey: "1".repeat(50), xml: "<?xml version=\"1.0\"?><NFSe/>", reason: "NFS-e autorizada." } },
    async consult() { throw new Error("not called") }, async cancel() { throw new Error("not called") },
  }
  const app = buildApp({
    pool: { async connect() { return client } }, userinfoUrl: "https://auth.example.test/oauth/userinfo",
    fetchAuth: async () => Response.json({ sub: "service-app", email: "service@example.test", email_verified: true }),
    outgoingNfse: { engine, async certificateProvider() { return { issuerTaxId: "04252011000110", certificate: { pkcs12Base64: "AQID", password: "secret" } } } },
  })
  const headers = { authorization: "Bearer service", "x-tenant-id": tenant, "idempotency-key": "33333333-3333-4333-8333-333333333333" }
  const first = await app.inject({ method: "POST", url: "/api/v1/integrations/nfse/issuances", headers, payload: input })
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json().data.id, savedIssuance)
  assert.equal(first.json().data.status, "authorized")
  const replayed = await app.inject({ method: "POST", url: "/api/v1/integrations/nfse/issuances", headers, payload: input })
  assert.equal(replayed.statusCode, 200, replayed.body)
  assert.equal(replayed.headers["idempotency-replayed"], "true")
  assert.equal(issueCalls, 1)
  await app.close()
})
