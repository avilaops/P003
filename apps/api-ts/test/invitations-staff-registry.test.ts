import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { Pool } from "pg"

import { buildApp, type AppDependencies } from "../src/app.js"
import { PgClientAdapter, type DatabasePool } from "../src/platform/database.js"
import type { InvitationDelivery } from "../src/modules/invitations/delivery.js"
import { RegistryClient } from "../src/modules/registry-lookup/client.js"
import type { LookupInput, LookupReply, RegistryProvider } from "../src/modules/registry-lookup/model.js"

const CNPJ = "04252011000110"
const readerPermissions = ["catalog.staff.read", "platform.users.read"]
const adminPermissions = [...readerPermissions, "catalog.staff.manage", "platform.users.manage", "platform.roles.read", "platform.company.read", "catalog.parties.read"]

function reply(input: LookupInput, tenantId: string): LookupReply {
  return { tenantId, kind: input.kind, value: input.value, status: "found", data: { fields: { legalName: "Empresa sintética", personType: "juridica" }, stateRegistrations: [], genericPostalCode: false, taxpayerStatus: "unknown" }, source: "BrasilAPI", sourceUpdatedAt: null, fetchedAt: "2026-01-01T00:00:00.000Z", expiresAt: null, cached: false, attempts: [{ source: "BrasilAPI", outcome: "found" }], warnings: [] }
}

test("PostgreSQL: staff, invitations and registry lookups enforce permissions, revisions, idempotency and tenant isolation", { skip: !process.env.API_TS_TEST_ADMIN_URL }, async () => {
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL!)
  const suffix = randomUUID().replaceAll("-", ""), database = `api_ts_test_${suffix}`, role = `api_ts_role_${suffix}`
  const admin = new Pool({ connectionString: url.toString() })
  await admin.query(`CREATE DATABASE ${database}`)
  url.pathname = `/${database}`
  const seed = new Pool({ connectionString: url.toString() }), connections = new Pool({ connectionString: url.toString() })
  const apps: ReturnType<typeof buildApp>[] = []
  try {
    const directory = new URL("../../../migrations/", import.meta.url)
    for (const file of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) await seed.query(await readFile(new URL(file, directory), "utf8"))
    await seed.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`)
    const [tenantA, tenantB] = [randomUUID(), randomUUID()]
    await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa A','04252011000110'),($2,'Empresa B','52998224725')", [tenantA, tenantB])
    await seed.query("INSERT INTO permissions(code,description) SELECT unnest($1::text[]),'teste' ON CONFLICT DO NOTHING", [[...adminPermissions, "finance.staff.approve", "sales.orders.read"]])
    async function member(tenant: string, subject: string, permissions: string[], code = subject) {
      const identity = randomUUID(), membership = randomUUID(), roleId = randomUUID()
      await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,$2,$3,$2)", [identity, subject, `${subject}@example.test`])
      await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [membership, tenant, identity])
      await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,$3,$3)", [roleId, tenant, code])
      await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, roleId])
      await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])", [roleId, permissions])
      return roleId
    }
    await member(tenantA, "admin", [...adminPermissions, "sales.orders.read"])
    await member(tenantA, "reader", readerPermissions)
    await member(tenantA, "approver", [...adminPermissions, "finance.staff.approve"], "approver")
    await member(tenantB, "bob", [...adminPermissions, "sales.orders.read"])
    const viewerRole = randomUUID()
    await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'vendas','Vendas')", [viewerRole, tenantA])
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'sales.orders.read')", [viewerRole])
    const foreignRole = randomUUID()
    await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'externo','Externo')", [foreignRole, tenantB])
    // Set after seeding: the application role cannot bypass RLS.
    const pool: DatabasePool = { async connect() { const client = await connections.connect(); await client.query(`SET ROLE ${role}`); return new PgClientAdapter(client) } }

    const sent: { email: string; company: string }[] = []
    const delivery: InvitationDelivery = { async send(invitation, company) { sent.push({ email: invitation.email, company }); return "sent" } }
    const lookups: string[] = []
    const registry: RegistryProvider = {
      async lookup(tenant, input) { lookups.push(`tenant:${tenant}:${input.kind}:${input.value}`); return reply(input, tenant) },
      async lookupRegistration(subject, input) { lookups.push(`registration:${subject}`); return reply(input, "00000000-0000-0000-0000-000000000000") },
    }
    const dependencies = { pool, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async (_url: unknown, init?: RequestInit) => {
      const token = new Headers(init?.headers).get("authorization")!.slice(7)
      return token === "bad" ? new Response("{}", { status: 401 }) : Response.json({ sub: token, email: `${token}@example.test`, email_verified: true })
    }, invitationDelivery: delivery, registry }
    const build = (extra: object = {}) => { const app = buildApp({ ...dependencies, ...extra } as AppDependencies); apps.push(app); return app }
    const app = build()
    const headers = (token: string, tenant = tenantA, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, "x-tenant-id": tenant, ...extra })
    const key = () => ({ "idempotency-key": randomUUID() })

    // ---- staff
    const staffInput = { name: " Maria Souza ", code: "mar-01", jobTitle: "Vendedora", email: "maria@example.test", phone: null, isEmployee: true, isSeller: true, status: "active", profile: { cpf: "529.982.247-25", admissionDate: "2026-01-10" } }
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/staff", headers: { "x-tenant-id": tenantA } })).statusCode, 401)
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/staff", headers: headers("reader", tenantA, key()), payload: staffInput })).statusCode, 403)
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/staff", headers: headers("admin"), payload: staffInput })).statusCode, 428)
    for (const payload of [{ ...staffInput, isEmployee: false, isSeller: false }, { ...staffInput, extra: 1 }, { ...staffInput, code: "a b" }, { ...staffInput, profile: { cpf: "111.111.111-11" } }, { ...staffInput, profile: { admissionDate: "2026-02-30" } }, { ...staffInput, profile: { photo: "data:text/plain;base64,AAAA" } }]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/v1/staff", headers: headers("admin", tenantA, key()), payload })).statusCode, 422, JSON.stringify(payload))
    }
    const staffKey = randomUUID()
    const created = await app.inject({ method: "POST", url: "/api/v1/staff", headers: headers("admin", tenantA, { "idempotency-key": staffKey }), payload: staffInput })
    assert.equal(created.statusCode, 201, created.body)
    assert.equal(created.headers.etag, '"1"')
    const staff = created.json().data
    assert.equal(staff.name, "Maria Souza")
    assert.equal(staff.code, "MAR-01")
    assert.equal(staff.profile.cpf, "529.982.247-25")
    assert.equal(staff.profile.rg, null)
    const replay = await app.inject({ method: "POST", url: "/api/v1/staff", headers: headers("admin", tenantA, { "idempotency-key": staffKey }), payload: staffInput })
    assert.equal(replay.statusCode, 201)
    assert.deepEqual(replay.json(), created.json())
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/staff", headers: headers("admin", tenantA, { "idempotency-key": staffKey }), payload: { ...staffInput, name: "Outra" } })).statusCode, 409)
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/staff", headers: headers("admin", tenantA, key()), payload: staffInput })).statusCode, 409, "duplicate code")
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM staff WHERE code='MAR-01'")).rows[0].n, 1)

    const list = await app.inject({ method: "GET", url: "/api/v1/staff?q=mar&role=seller&limit=10", headers: headers("reader") })
    assert.equal(list.statusCode, 200, list.body)
    assert.deepEqual([list.json().total, list.json().canEdit, list.json().data[0].id], [1, false, staff.id])
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/staff?limit=0", headers: headers("reader") })).statusCode, 422)
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/staff?role=other", headers: headers("reader") })).statusCode, 422)
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/staff/${staff.id}`, headers: headers("reader") })).headers.etag, '"1"')
    // Tenant isolation: another company sees neither the list entry nor the detail, and cannot use this tenant's header.
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/staff", headers: headers("bob", tenantB) })).json().total, 0)
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/staff/${staff.id}`, headers: headers("bob", tenantB) })).statusCode, 404)
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/staff/${staff.id}`, headers: headers("bob", tenantA) })).statusCode, 403)
    assert.equal((await app.inject({ method: "PUT", url: `/api/v1/staff/${staff.id}`, headers: headers("bob", tenantB, { "if-match": '"1"' }), payload: staffInput })).statusCode, 404)

    const put = (token: string, match: string | undefined, payload: object) => app.inject({ method: "PUT", url: `/api/v1/staff/${staff.id}`, headers: headers(token, tenantA, match ? { "if-match": match } : {}), payload })
    assert.equal((await put("admin", undefined, staffInput)).statusCode, 428)
    assert.equal((await put("admin", "1", staffInput)).statusCode, 400)
    assert.equal((await put("reader", '"1"', staffInput)).statusCode, 403)
    assert.equal((await put("admin", '"1"', { ...staffInput, status: "x" })).statusCode, 422)
    assert.equal((await put("admin", '"7"', staffInput)).statusCode, 412)
    const updated = await put("admin", '"1"', { ...staffInput, jobTitle: "Gerente", profile: undefined })
    assert.equal(updated.statusCode, 200, updated.body)
    assert.equal(updated.headers.etag, '"2"')
    assert.equal(updated.json().data.profile.cpf, "529.982.247-25", "omitted profile is preserved")
    assert.equal((await put("admin", '"1"', staffInput)).statusCode, 412, "a consumed revision cannot be reused")

    // Dismissal stops payroll and needs the payroll approval right.
    await seed.query("INSERT INTO staff_payroll_profiles(tenant_id,staff_id,settings) VALUES($1,$2,'{\"recurring\":true}')", [tenantA, staff.id])
    assert.equal((await put("admin", '"2"', { ...staffInput, status: "archived" })).statusCode, 403)
    const archived = await put("approver", '"2"', { ...staffInput, status: "archived" })
    assert.equal(archived.statusCode, 200, archived.body)
    assert.equal((await seed.query("SELECT settings->>'recurring' AS recurring FROM staff_payroll_profiles WHERE staff_id=$1", [staff.id])).rows[0].recurring, "false")
    const staffEvidence = await seed.query("SELECT (SELECT count(*)::int FROM audit_log WHERE entity_id=$1) AS audits,(SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$1) AS events", [staff.id])
    assert.deepEqual(staffEvidence.rows[0], { audits: 4, events: 4 })

    // ---- invitations
    const invite = { name: "Novo Usuário", email: " Novo@Example.Test ", roleIds: [viewerRole], manageUsers: false }
    const post = (token: string, payload: unknown, headerSet: Record<string, string> = key(), tenant = tenantA) => app.inject({ method: "POST", url: "/api/v1/invitations", headers: headers(token, tenant, headerSet), payload: payload as object })
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/invitations", headers: { "x-tenant-id": tenantA } })).statusCode, 401)
    assert.equal((await post("reader", invite)).statusCode, 403)
    assert.equal((await post("admin", invite, {})).statusCode, 428)
    assert.equal((await post("admin", invite, { "idempotency-key": "nope" })).statusCode, 422)
    for (const payload of [{ ...invite, email: "sem-arroba" }, { ...invite, name: "  " }, { ...invite, roleIds: [], manageUsers: false }, { ...invite, extra: true }, { ...invite, roleIds: ["x"] }]) assert.equal((await post("admin", payload)).statusCode, 422, JSON.stringify(payload))
    assert.equal((await post("admin", { ...invite, roleIds: [foreignRole] })).statusCode, 404, "a role of another company is not visible")
    const inviteKey = randomUUID()
    const first = await post("admin", invite, { "idempotency-key": inviteKey })
    assert.equal(first.statusCode, 200, first.body)
    assert.deepEqual([first.json().delivery, first.json().status, first.json().email, first.json().roles], ["sent", "pending", "novo@example.test", ["Vendas"]])
    assert.equal((await post("admin", invite, { "idempotency-key": inviteKey })).json().id, first.json().id)
    assert.equal(sent.length, 1, "an idempotent replay does not send another e-mail")
    assert.equal((await post("admin", { ...invite, name: "Outro nome" }, { "idempotency-key": inviteKey })).statusCode, 409)
    assert.equal((await post("admin", invite)).statusCode, 409, "e-mail already invited")
    assert.equal((await post("admin", { ...invite, email: "admin@example.test" })).statusCode, 409, "e-mail already has access")
    const manager = await post("admin", { name: "Gestor", email: "gestor@example.test", roleIds: [], manageUsers: true })
    assert.equal(manager.statusCode, 200, manager.body)
    assert.deepEqual(manager.json().roles, ["Gestor de usuários"])
    const listInvitations = await app.inject({ method: "GET", url: "/api/v1/invitations", headers: headers("reader") })
    assert.equal(listInvitations.statusCode, 200)
    assert.deepEqual([listInvitations.json().data.length, listInvitations.json().enabled], [2, true])
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/invitations", headers: headers("bob", tenantB) })).json().data.length, 0)
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/invitations", headers: headers("bob", tenantA) })).statusCode, 403)

    const action = (token: string, id: string, name: "resend" | "revoke", extra: Record<string, string> = {}, tenant = tenantA) => app.inject({ method: "POST", url: `/api/v1/invitations/${id}/${name}`, headers: headers(token, tenant, extra) })
    const invitationId = first.json().id as string
    assert.equal((await action("reader", invitationId, "resend", key())).statusCode, 403)
    assert.equal((await action("admin", invitationId, "resend")).statusCode, 428)
    assert.equal((await action("admin", invitationId, "resend", key())).statusCode, 409, "one minute between sends")
    assert.equal((await action("bob", invitationId, "resend", key(), tenantB)).statusCode, 404)
    assert.equal((await action("bob", invitationId, "revoke", {}, tenantB)).statusCode, 404)
    await seed.query("UPDATE user_invitations SET last_delivery_at = now() - interval '2 minutes' WHERE id=$1", [invitationId])
    const resendKey = randomUUID()
    const resent = await action("admin", invitationId, "resend", { "idempotency-key": resendKey })
    assert.equal(resent.statusCode, 200, resent.body)
    assert.equal(sent.length, 3)
    assert.equal((await action("admin", invitationId, "resend", { "idempotency-key": resendKey })).statusCode, 200)
    assert.equal(sent.length, 3, "repeating the resend key does not send again")
    assert.equal((await action("reader", invitationId, "revoke")).statusCode, 403)
    const revoked = await action("admin", invitationId, "revoke")
    assert.equal(revoked.json().status, "revoked")
    assert.equal((await action("admin", invitationId, "resend", key())).statusCode, 409, "a revoked invitation cannot be resent")
    await seed.query("UPDATE user_invitations SET status='accepted' WHERE id=$1", [manager.json().id])
    assert.equal((await action("admin", manager.json().id, "revoke")).statusCode, 409)
    assert.equal((await action("admin", randomUUID(), "revoke")).statusCode, 404)
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_type='user_invitation'")).rows[0].n, 4)
    const unconfigured = build({ invitationDelivery: null })
    assert.equal((await unconfigured.inject({ method: "POST", url: "/api/v1/invitations", headers: headers("admin", tenantA, key()), payload: invite })).statusCode, 409)
    assert.equal((await unconfigured.inject({ method: "GET", url: "/api/v1/invitations", headers: headers("admin") })).json().enabled, false)

    // ---- registry lookups
    const lookup = (token: string, payload: unknown, tenant = tenantA) => app.inject({ method: "POST", url: "/api/v1/registry-lookups", headers: headers(token, tenant), payload: payload as object })
    const body = { kind: "cnpj", context: "company", value: "04.252.011/0001-10" }
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/registry-lookups", headers: { "x-tenant-id": tenantA }, payload: body })).statusCode, 401)
    assert.equal((await lookup("reader", body)).statusCode, 403)
    assert.equal((await lookup("reader", { ...body, context: "party" })).statusCode, 403)
    assert.equal((await lookup("bob", body, tenantA)).statusCode, 403)
    for (const payload of [{ ...body, value: "12345678000100" }, { ...body, value: "x".repeat(40) }, { ...body, kind: "cep", value: "1234" }, { ...body, kind: "ie" }, { ...body, extra: 1 }]) assert.equal((await lookup("admin", payload)).statusCode, 422, JSON.stringify(payload))
    assert.equal(lookups.length, 0, "invalid requests never reach a provider")
    const found = await lookup("admin", body)
    assert.equal(found.statusCode, 200, found.body)
    assert.deepEqual([found.json().tenantId, found.json().value, found.json().status], [tenantA, CNPJ, "found"])
    assert.equal((await lookup("admin", { kind: "cep", context: "company", value: "01001-000" })).json().value, "01001000")
    assert.equal((await build({ registry: null }).inject({ method: "POST", url: "/api/v1/registry-lookups", headers: headers("admin"), payload: body })).statusCode, 409)

    const registration = (token: string | undefined, payload: unknown) => app.inject({ method: "POST", url: "/api/v1/company-registration/lookup", headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as object })
    assert.equal((await registration(undefined, { value: CNPJ })).statusCode, 401)
    assert.equal((await registration("bad", { value: CNPJ })).statusCode, 401)
    assert.equal((await registration("outsider", { value: "123" })).statusCode, 422)
    assert.equal((await registration("outsider", { value: CNPJ, kind: "cep" })).statusCode, 422)
    const signUp = await registration("outsider", { value: CNPJ })
    assert.equal(signUp.statusCode, 200, signUp.body)
    assert.deepEqual(Object.keys(signUp.json()).sort(), ["data", "expiresAt", "fetchedAt", "source", "sourceUpdatedAt", "status", "value", "warnings"])
    assert.equal(lookups.at(-1), "registration:outsider")
    assert.equal((await build({ registry: null }).inject({ method: "POST", url: "/api/v1/company-registration/lookup", headers: { authorization: "Bearer outsider" }, payload: { value: CNPJ } })).statusCode, 409)
  } finally {
    for (const app of apps) await app.close()
    await connections.end(); await seed.end()
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
    await admin.query(`DROP ROLE IF EXISTS ${role}`)
    await admin.end()
  }
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
