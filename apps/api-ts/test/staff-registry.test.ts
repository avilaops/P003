import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import type { LookupInput, LookupReply, RegistryProvider } from "../src/modules/registry-lookup/model.js"
import { RegistryClient } from "../src/modules/registry-lookup/client.js"
import { databaseTestOptions, withTestContext } from "./support/test-context.js"

// Funcionários (staff.rs) e consulta cadastral (registry_lookup). A consulta externa é um stub nos testes de rota.
// `user` administra a empresa A; `denied` só consulta funcionários; `outsider` administra apenas a empresa B.
const CNPJ = "04252011000110"
function reply(input: LookupInput, tenantId: string): LookupReply {
  return { tenantId, kind: input.kind, value: input.value, status: "found", data: { fields: { legalName: "Empresa sintética", personType: "juridica" }, stateRegistrations: [], genericPostalCode: false, taxpayerStatus: "unknown" }, source: "BrasilAPI", sourceUpdatedAt: null, fetchedAt: "2026-01-01T00:00:00.000Z", expiresAt: null, cached: false, attempts: [{ source: "BrasilAPI", outcome: "found" }], warnings: [] }
}

test("funcionários", databaseTestOptions, async t => {
  await withTestContext({}, async ctx => {
    await ctx.seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT r.id,p.code FROM roles r CROSS JOIN permissions p WHERE r.code='user' AND r.tenant_id=$1 ON CONFLICT DO NOTHING", [ctx.tenant])
    await ctx.grant("denied", "catalog.staff.read")
    const user = ctx.as("user"), denied = ctx.as("denied"), outsider = ctx.as("outsider"), anonymous = ctx.as("anonymous")
    const input = { name: " Maria Souza ", code: "mar-01", jobTitle: "Vendedora", email: "maria@example.test", phone: null, isEmployee: true, isSeller: true, status: "active", profile: { cpf: "529.982.247-25", admissionDate: "2026-01-10" } }
    let staff = ""

    await t.test("GET /api/v1/staff + POST /api/v1/staff + GET /api/v1/staff/{id} + PUT /api/v1/staff/{id} [negado] sem token, de outra empresa e sem permissão de gerenciar", async () => {
      const id = randomUUID()
      for (const [method, url] of [["get", "/api/v1/staff"], ["post", "/api/v1/staff"], ["get", `/api/v1/staff/${id}`], ["put", `/api/v1/staff/${id}`]] as const) {
        assert.equal((await anonymous[method](url, { body: input, revision: 1 })).statusCode, 401, url)
        assert.equal((await outsider[method](url, { body: input, revision: 1 })).statusCode, 403, url)
      }
      assert.equal((await denied.post("/api/v1/staff", { body: input })).statusCode, 403)
      assert.equal((await denied.put(`/api/v1/staff/${id}`, { body: input, revision: 1 })).statusCode, 403)
    })

    await t.test("POST /api/v1/staff [sucesso] cria com Idempotency-Key, valida CPF e datas e recusa código repetido", async () => {
      assert.equal((await ctx.app.inject({ method: "POST", url: "/api/v1/staff", headers: { authorization: "Bearer user", "x-tenant-id": ctx.tenant }, payload: input })).statusCode, 428)
      for (const body of [{ ...input, isEmployee: false, isSeller: false }, { ...input, extra: 1 }, { ...input, code: "a b" }, { ...input, profile: { cpf: "111.111.111-11" } }, { ...input, profile: { admissionDate: "2026-02-30" } }, { ...input, profile: { photo: "data:text/plain;base64,AAAA" } }]) {
        assert.equal((await user.post("/api/v1/staff", { body })).statusCode, 422, JSON.stringify(body))
      }
      const key = randomUUID()
      const created = await user.post("/api/v1/staff", { body: input, idempotencyKey: key })
      assert.equal(created.statusCode, 201, created.body)
      assert.equal(created.headers.etag, '"1"')
      staff = created.json().data.id
      assert.deepEqual([created.json().data.name, created.json().data.code, created.json().data.profile.cpf, created.json().data.profile.rg], ["Maria Souza", "MAR-01", "529.982.247-25", null])
      const replay = await user.post("/api/v1/staff", { body: input, idempotencyKey: key })
      assert.deepEqual([replay.statusCode, replay.json()], [201, created.json()])
      assert.equal((await user.post("/api/v1/staff", { body: { ...input, name: "Outra" }, idempotencyKey: key })).statusCode, 409)
      assert.equal((await user.post("/api/v1/staff", { body: input })).statusCode, 409, "código repetido")
      assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM staff WHERE code='MAR-01'")).rows[0].n, 1)
    })

    await t.test("GET /api/v1/staff + GET /api/v1/staff/{id} [sucesso] lista com filtros e detalha só na empresa", async () => {
      const list = await denied.get("/api/v1/staff", { query: { q: "mar", role: "seller", limit: 10 } })
      assert.equal(list.statusCode, 200, list.body)
      assert.deepEqual([list.json().total, list.json().canEdit, list.json().data[0].id], [1, false, staff])
      assert.equal((await denied.get("/api/v1/staff", { query: { limit: 0 } })).statusCode, 422)
      assert.equal((await denied.get("/api/v1/staff", { query: { role: "outro" } })).statusCode, 422)
      assert.equal((await denied.get(`/api/v1/staff/${staff}`)).headers.etag, '"1"')
      assert.equal((await outsider.get("/api/v1/staff", { tenant: ctx.otherTenant })).json().total, 0)
      assert.equal((await outsider.get(`/api/v1/staff/${staff}`, { tenant: ctx.otherTenant })).statusCode, 404)
    })

    await t.test("PUT /api/v1/staff/{id} [sucesso] altera com If-Match, preserva perfil omitido e exige aprovação para desligar com folha", async () => {
      const url = `/api/v1/staff/${staff}`
      assert.equal((await user.put(url, { body: input })).statusCode, 428)
      assert.equal((await user.put(url, { body: input, headers: { "if-match": "1" } })).statusCode, 400)
      assert.equal((await user.put(url, { body: { ...input, status: "x" }, revision: 1 })).statusCode, 422)
      assert.equal((await user.put(url, { body: input, revision: 7 })).statusCode, 412)
      assert.equal((await outsider.put(url, { body: input, revision: 1, tenant: ctx.otherTenant })).statusCode, 404)
      const { profile: _profile, ...withoutProfile } = input
      const updated = await user.put(url, { body: { ...withoutProfile, jobTitle: "Gerente" }, revision: 1 })
      assert.equal(updated.statusCode, 200, updated.body)
      assert.equal(updated.headers.etag, '"2"')
      assert.equal(updated.json().data.profile.cpf, "529.982.247-25", "perfil omitido preservado")
      assert.equal((await user.put(url, { body: input, revision: 1 })).statusCode, 412, "revisão consumida")
      await ctx.seed.query("INSERT INTO staff_payroll_profiles(tenant_id,staff_id,settings) VALUES($1,$2,'{\"recurring\":true}')", [ctx.tenant, staff])
      await ctx.grant("denied", "catalog.staff.manage")
      assert.equal((await denied.put(url, { body: { ...input, status: "archived" }, revision: 2 })).statusCode, 403, "desligar com folha exige finance.staff.approve")
      const archived = await user.put(url, { body: { ...input, status: "archived" }, revision: 2 })
      assert.equal(archived.statusCode, 200, archived.body)
      assert.equal((await ctx.seed.query("SELECT settings->>'recurring' AS recurring FROM staff_payroll_profiles WHERE staff_id=$1", [staff])).rows[0].recurring, "false")
      const evidence = await ctx.seed.query("SELECT (SELECT count(*)::int FROM audit_log WHERE entity_id=$1) AS audits,(SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$1) AS events", [staff])
      assert.deepEqual(evidence.rows[0], { audits: 4, events: 4 })
    })
  })
})

test("consulta cadastral", databaseTestOptions, async t => {
  const lookups: string[] = []
  const provider: RegistryProvider = {
    async lookup(tenant, input) { lookups.push(`tenant:${tenant}:${input.kind}`); return reply(input, tenant) },
    async lookupRegistration(subject, input) { lookups.push(`registration:${subject}`); return reply(input, "00000000-0000-0000-0000-000000000000") },
  }
  await withTestContext({ permissions: ["platform.company.read"], dependencies: { registryLookup: { provider } } }, async ctx => {
    const user = ctx.as("user"), outsider = ctx.as("outsider"), anonymous = ctx.as("anonymous")
    const body = { kind: "cnpj", context: "company", value: "04.252.011/0001-10" }
    const registration = (token: string | undefined, payload: unknown) => ctx.app.inject({ method: "POST", url: "/api/v1/company-registration/lookup", headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as object })

    await t.test("POST /api/v1/registry-lookups [negado] sem token, de outra empresa e sem permissão do contexto", async () => {
      assert.equal((await anonymous.post("/api/v1/registry-lookups", { body })).statusCode, 401)
      assert.equal((await outsider.post("/api/v1/registry-lookups", { body })).statusCode, 403)
      assert.equal((await ctx.as("denied").post("/api/v1/registry-lookups", { body })).statusCode, 403)
      assert.equal((await user.post("/api/v1/registry-lookups", { body: { ...body, context: "party" } })).statusCode, 403, "cadastro de pessoas exige catalog.parties.read")
    })

    await t.test("POST /api/v1/registry-lookups [sucesso] valida antes de consultar e responde no escopo da empresa", async () => {
      for (const payload of [{ ...body, value: "12345678000100" }, { ...body, value: "x".repeat(40) }, { ...body, kind: "cep", value: "1234" }, { ...body, kind: "ie" }, { ...body, extra: 1 }]) {
        assert.equal((await user.post("/api/v1/registry-lookups", { body: payload })).statusCode, 422, JSON.stringify(payload))
      }
      assert.equal(lookups.length, 0, "entrada inválida nunca chega ao provedor")
      const found = await user.post("/api/v1/registry-lookups", { body })
      assert.equal(found.statusCode, 200, found.body)
      assert.deepEqual([found.json().tenantId, found.json().value, found.json().status], [ctx.tenant, CNPJ, "found"])
      assert.equal((await user.post("/api/v1/registry-lookups", { body: { kind: "cep", context: "company", value: "01001-000" } })).json().value, "01001000")
    })

    await t.test("POST /api/v1/company-registration/lookup [negado] sem token ou com entrada inválida", async () => {
      assert.equal((await registration(undefined, { value: CNPJ })).statusCode, 401)
      assert.equal((await registration("invalido", { value: CNPJ })).statusCode, 401)
      assert.equal((await registration("outsider", { value: "123" })).statusCode, 422)
      assert.equal((await registration("outsider", { value: CNPJ, kind: "cep" })).statusCode, 422)
    })

    await t.test("POST /api/v1/company-registration/lookup [sucesso] consulta de cadastro sem empresa ativa e sem dados internos", async () => {
      const signUp = await registration("outsider", { value: CNPJ })
      assert.equal(signUp.statusCode, 200, signUp.body)
      assert.deepEqual(Object.keys(signUp.json()).sort(), ["data", "expiresAt", "fetchedAt", "source", "sourceUpdatedAt", "status", "value", "warnings"])
      assert.equal(lookups.at(-1), "registration:outsider")
    })
  })
})

test("consulta cadastral: indisponibilidade responde 409 com mensagem clara", async () => {
  const { buildApp } = await import("../src/app.js")
  const app = buildApp({ pool: { async connect() { throw Error("sem banco") } }, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async () => Response.json({ sub: "user", email: "user@example.test" }), registryLookup: { provider: null } })
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/company-registration/lookup", headers: { authorization: "Bearer user" }, payload: { value: CNPJ } })
    assert.equal(response.statusCode, 409)
    assert.match(response.json().title, /indisponível/)
  } finally { await app.close() }
})

test("registry client: fallback, malformed data, caching per scope, quotas and unsupported IE", async () => {
  const calls: string[] = []
  const brasil = { cnpj: CNPJ, razao_social: "Empresa sintética", uf: "SP", municipio: "São Paulo", cep: "01001000", codigo_municipio_ibge: 3550308, situacao_cadastral: 2, descricao_situacao_cadastral: "ATIVA", opcao_pelo_simples: true, codigo_porte: 1, ddd_telefone_1: "(11) 3333-4444", cnae_fiscal: 6201501 }
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes("viacep")) return Response.json({ cep: "00000000", uf: "SP", localidade: "Outra" })
    if (url.includes("/cep/")) return Response.json({ cep: "01001000", state: "SP", city: "São Paulo", street: "Praça da Sé", neighborhood: "Sé" })
    if (url.includes("/cnpj/v1/")) return Response.json(brasil)
    return new Response("", { status: 404 })
  }) as typeof fetch
  const client = new RegistryClient({ cnpjWsEnabled: false, fetcher })
  const cep: LookupInput = { kind: "cep", context: "party", value: "01001000", state: null }
  const first = await client.lookup("a", cep)
  assert.deepEqual([first.status, first.source, first.attempts.map(item => item.outcome), first.cached], ["found", "BrasilAPI", ["malformed_response", "found"], false])
  assert.equal((await client.lookup("a", cep)).cached, true)
  assert.equal((await client.lookup("b", cep)).cached, false, "the cache is never shared between companies")
  assert.equal(calls.filter(url => url.includes("/cep/")).length, 2)

  const company = await client.lookup("a", { kind: "cnpj", context: "company", value: CNPJ, state: null })
  assert.equal(company.status, "found")
  assert.deepEqual(company.data?.fields, { cnae: "6201501", companySize: "micro", legalName: "Empresa sintética", municipalityCode: "3550308", personType: "juridica", phone: "1133334444", postalCode: "01001000", registrationStatus: "ATIVA", registrationStatusCode: "2", state: "SP", city: "São Paulo", taxRegime: "simples" })
  assert.equal(company.data?.taxpayerStatus, "unknown")
  const identity = await new RegistryClient({ cnpjWsEnabled: false, fetcher: (async () => Response.json({ ...brasil, cnpj: "11222333000181" })) as typeof fetch }).lookup("a", { kind: "cnpj", context: "company", value: CNPJ, state: null })
  assert.deepEqual([identity.status, identity.attempts[0]?.outcome], ["unavailable", "malformed_response"], "a record for another identifier is rejected")
  const down = await new RegistryClient({ cnpjWsEnabled: false, fetcher: (async () => { throw Error("offline") }) as typeof fetch }).lookup("a", cep)
  assert.deepEqual([down.status, down.attempts.map(item => item.outcome)], ["unavailable", ["unavailable", "unavailable"]])
  const absent = await new RegistryClient({ cnpjWsEnabled: false, fetcher: (async () => new Response("", { status: 404 })) as typeof fetch }).lookup("a", cep)
  assert.equal(absent.status, "not_found")
  const ie = await client.lookup("a", { kind: "ie", context: "company", value: CNPJ, state: "SP" })
  assert.equal(ie.status, "unsupported")
  const limited = new RegistryClient({ cnpjWsEnabled: false, fetcher })
  const replies = await Promise.all(Array.from({ length: 21 }, (_, index) => limited.lookup("same", { ...cep, value: `0100100${index % 10}` })))
  assert.ok(replies.some(item => item.warnings.some(warning => warning.startsWith("Limite de consultas"))), "a company is limited to 20 lookups per minute")
  const registration = await client.lookupRegistration("subject", { kind: "cnpj", context: "company", value: CNPJ, state: null })
  assert.equal(registration.tenantId, "00000000-0000-0000-0000-000000000000")
})
