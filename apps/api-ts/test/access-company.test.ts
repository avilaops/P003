import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { Pool } from "pg"

import { buildApp } from "../src/app.js"
import { PgClientAdapter, type DatabasePool } from "../src/platform/database.js"

// Opt in with a disposable PostgreSQL administrator URL (API_TS_TEST_ADMIN_URL).
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=="
const company = (overrides: Record<string, unknown> = {}) => ({
  legalName: "Empresa Nova Ltda", tradeName: "Nova", personType: "juridica", taxId: "04.252.011/0001-10", taxRegime: "simples",
  segments: ["Comércio"], postalCode: "01001-000", state: "SP", city: "São Paulo", street: "Praça da Sé", number: "1", district: "Sé", ...overrides,
})

test("access, company and company selection: contract, permissions, revisions, idempotency and tenant isolation", { skip: !process.env.API_TS_TEST_ADMIN_URL }, async () => {
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL!)
  const suffix = randomUUID().replaceAll("-", ""), database = `api_ts_test_${suffix}`, role = `api_ts_role_${suffix}`
  const admin = new Pool({ connectionString: url.toString() })
  await admin.query(`CREATE DATABASE ${database}`)
  url.pathname = `/${database}`
  const seed = new Pool({ connectionString: url.toString() })
  const connections = new Pool({ connectionString: url.toString() })
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const directory = new URL("../../../migrations/", import.meta.url)
    for (const file of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) await seed.query(await readFile(new URL(file, directory), "utf8"))
    await seed.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    await seed.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`)

    const [tenantA, tenantB] = [randomUUID(), randomUUID()]
    await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa A','04252011000110'),($2,'Empresa B','52998224725')", [tenantA, tenantB])
    const people: Record<string, { identity: string; membership: string }> = {}
    for (const subject of ["editor", "reader", "outsider", "padmin"]) {
      people[subject] = { identity: randomUUID(), membership: randomUUID() }
      await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,$2,$3,$2)", [people[subject]!.identity, subject, `${subject}@example.test`])
    }
    const editorRole = randomUUID(), readerRole = randomUUID(), foreignRole = randomUUID()
    await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'editor','Editor'),($3,$2,'reader','Leitor'),($4,$5,'foreign','Papel de B')", [editorRole, tenantA, readerRole, foreignRole, tenantB])
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,code FROM permissions", [editorRole])
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'platform.users.read'),($1,'platform.roles.read'),($1,'platform.company.read')", [readerRole])
    const member = async (subject: string, tenant: string, roleId: string) => {
      const id = subject === "outsider" || tenant === tenantA ? people[subject]!.membership : randomUUID()
      await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [id, tenant, people[subject]!.identity])
      await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [id, roleId])
      return id
    }
    await member("editor", tenantA, editorRole)
    await member("reader", tenantA, readerRole)
    await member("outsider", tenantB, foreignRole)
    await seed.query("INSERT INTO platform_administrators(auth_subject,granted_by,reason) VALUES('padmin','test','teste')")

    const pool: DatabasePool = { async connect() {
      const client = await connections.connect()
      await client.query(`SET ROLE ${role}`)
      return new PgClientAdapter(client)
    } }
    app = buildApp({ pool, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async (_url, init) => {
      const token = new Headers(init?.headers).get("authorization")!.slice(7)
      if (token === "invalid") return new Response("{}", { status: 401 })
      return Response.json({ sub: token, email: `${token}@example.test`, name: token, email_verified: true })
    } })
    const call = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, as: string | undefined, options: { tenant?: string | null; match?: string; key?: string; payload?: unknown } = {}) => app!.inject({
      method, url: path, ...(options.payload === undefined ? {} : { payload: options.payload as object }),
      headers: {
        ...(as ? { authorization: `Bearer ${as}` } : {}),
        ...(options.tenant === null ? {} : { "x-tenant-id": options.tenant ?? tenantA }),
        ...(options.match ? { "if-match": options.match } : {}), ...(options.key ? { "idempotency-key": options.key } : {}),
      },
    })

    // ---- 401 / 403 / tenant header
    for (const [method, path] of [["GET", "/api/v1/roles"], ["GET", "/api/v1/users"], ["GET", "/api/v1/company"], ["GET", "/api/v1/companies"], ["POST", "/api/v1/company-selection"]] as const) {
      assert.equal((await call(method, path, undefined)).statusCode, 401, path)
      assert.equal((await call(method, path, "invalid")).statusCode, 401, path)
    }
    assert.equal((await call("GET", "/api/v1/roles", "editor", { tenant: null })).statusCode, 400)
    assert.equal((await call("GET", "/api/v1/roles", "editor", { tenant: "not-a-uuid" })).statusCode, 400)
    assert.equal((await call("GET", "/api/v1/roles", "outsider")).statusCode, 403, "member of another company only")
    assert.equal((await call("GET", "/api/v1/users", "outsider")).statusCode, 403)

    // ---- roles
    const roleInput = { code: "comercial", name: " Consulta comercial ", description: "Papel de teste", permissions: ["platform.company.read"] }
    const key = randomUUID()
    assert.equal((await call("POST", "/api/v1/roles", "editor", { payload: roleInput })).statusCode, 428)
    assert.equal((await call("POST", "/api/v1/roles", "editor", { key: "x", payload: roleInput })).statusCode, 422)
    assert.equal((await call("POST", "/api/v1/roles", "reader", { key, payload: roleInput })).statusCode, 403)
    for (const payload of [
      { ...roleInput, code: "Inválido" }, { ...roleInput, name: "  " }, { ...roleInput, extra: 1 },
      { ...roleInput, permissions: ["platform.company.read", "platform.company.read"] },
      { ...roleInput, permissions: ["platform.company.manage"] },
    ]) assert.equal((await call("POST", "/api/v1/roles", "editor", { key: randomUUID(), payload })).statusCode, 422, JSON.stringify(payload))
    assert.equal((await call("POST", "/api/v1/roles", "editor", { key: randomUUID(), payload: { ...roleInput, permissions: ["nao.existe"] } })).statusCode, 403, "outside the actor authority")
    const created = await call("POST", "/api/v1/roles", "editor", { key, payload: roleInput })
    assert.equal(created.statusCode, 201, created.body)
    assert.equal(created.headers.etag, '"1"')
    const roleId = created.json().id as string
    assert.equal(created.headers.location, `/api/v1/roles/${roleId}`)
    assert.deepEqual(created.json(), { id: roleId, code: "comercial", name: "Consulta comercial", description: "Papel de teste", revision: 1, permissions: ["platform.company.read"] })
    const replay = await call("POST", "/api/v1/roles", "editor", { key, payload: roleInput })
    assert.equal(replay.statusCode, 201)
    assert.equal(replay.headers["idempotency-replayed"], "true")
    assert.deepEqual(replay.json(), created.json())
    assert.equal((await call("POST", "/api/v1/roles", "editor", { key, payload: { ...roleInput, code: "outro" } })).statusCode, 409)
    assert.equal((await call("POST", "/api/v1/roles", "editor", { key: randomUUID(), payload: roleInput })).statusCode, 409, "duplicate code")
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM roles WHERE tenant_id=$1 AND code='comercial'", [tenantA])).rows[0].n, 1)
    // Authority ceiling: a reader-level role cannot grant what its holder lacks (reader lacks roles.manage).
    const list = await call("GET", "/api/v1/roles", "reader")
    assert.equal(list.statusCode, 200)
    assert.deepEqual(list.json().data.map((role: { code: string }) => role.code), ["comercial", "editor", "reader"].sort((a, b) => ({ comercial: "Consulta comercial", editor: "Editor", reader: "Leitor" }[a]!).localeCompare({ comercial: "Consulta comercial", editor: "Editor", reader: "Leitor" }[b]!)))
    assert.ok(!JSON.stringify(list.json()).includes(foreignRole), "roles of another tenant are invisible")
    const detail = await call("GET", `/api/v1/roles/${roleId}`, "reader")
    assert.equal(detail.statusCode, 200)
    assert.equal(detail.headers.etag, '"1"')
    assert.equal((await call("GET", `/api/v1/roles/${foreignRole}`, "editor")).statusCode, 404, "foreign role")
    assert.equal((await call("GET", "/api/v1/roles/not-a-uuid", "editor")).statusCode, 400)
    assert.equal((await call("PUT", `/api/v1/roles/${roleId}`, "editor", { payload: roleInput })).statusCode, 428)
    assert.equal((await call("PUT", `/api/v1/roles/${roleId}`, "editor", { match: "1", payload: roleInput })).statusCode, 400)
    assert.equal((await call("PUT", `/api/v1/roles/${roleId}`, "reader", { match: '"1"', payload: roleInput })).statusCode, 403)
    assert.equal((await call("PUT", `/api/v1/roles/${roleId}`, "editor", { match: '"9"', payload: roleInput })).statusCode, 412)
    assert.equal((await call("PUT", `/api/v1/roles/${roleId}`, "editor", { match: '"1"', payload: { ...roleInput, code: "BAD" } })).statusCode, 422)
    assert.equal((await call("PUT", `/api/v1/roles/${foreignRole}`, "editor", { match: '"1"', payload: roleInput })).statusCode, 404)
    const updated = await call("PUT", `/api/v1/roles/${roleId}`, "editor", { match: '"1"', payload: { ...roleInput, name: "Comercial", permissions: ["platform.company.read", "platform.users.read"] } })
    assert.equal(updated.statusCode, 200, updated.body)
    assert.equal(updated.headers.etag, '"2"')
    assert.deepEqual(updated.json().permissions, ["platform.company.read", "platform.users.read"])
    assert.equal((await call("PUT", `/api/v1/roles/${roleId}`, "editor", { match: '"1"', payload: roleInput })).statusCode, 412)
    const audits = await seed.query("SELECT action FROM audit_log WHERE entity_id=$1 ORDER BY at", [roleId]).catch(() => seed.query("SELECT action FROM audit_log WHERE entity_id=$1", [roleId]))
    assert.deepEqual(audits.rows.map(row => row.action).sort(), ["role.created", "role.updated"])
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id=$1", [roleId])).rows[0].n, 2)
    // The last administrator is protected: editor's role cannot lose user/role management.
    const stripped = await call("PUT", `/api/v1/roles/${editorRole}`, "editor", { match: '"1"', payload: { code: "editor", name: "Editor", description: "", permissions: ["platform.users.read", "platform.roles.read"] } })
    assert.equal(stripped.statusCode, 409, stripped.body)
    assert.equal((await call("DELETE", `/api/v1/roles/${roleId}`, "editor")).statusCode, 428)
    assert.equal((await call("DELETE", `/api/v1/roles/${roleId}`, "reader", { match: '"2"' })).statusCode, 403)
    assert.equal((await call("DELETE", `/api/v1/roles/${readerRole}`, "editor", { match: '"1"' })).statusCode, 409, "role in use")
    assert.equal((await call("DELETE", `/api/v1/roles/${roleId}`, "editor", { match: '"1"' })).statusCode, 412)
    assert.equal((await call("DELETE", `/api/v1/roles/${roleId}`, "editor", { match: '"2"' })).statusCode, 204)
    assert.equal((await call("GET", `/api/v1/roles/${roleId}`, "editor")).statusCode, 404)

    // ---- users
    const users = await call("GET", "/api/v1/users", "reader")
    assert.equal(users.statusCode, 200)
    assert.deepEqual(users.json().data.map((user: { name: string; status: string; roles: string[] }) => [user.name, user.status, user.roles]), [["editor", "active", ["Editor"]], ["reader", "active", ["Leitor"]]])
    const readerMembership = people.reader!.membership, editorMembership = people.editor!.membership
    const member1 = await call("GET", `/api/v1/users/${readerMembership}`, "reader")
    assert.equal(member1.statusCode, 200)
    assert.deepEqual(member1.json(), { id: readerMembership, name: "reader", email: "reader@example.test", status: "active", revision: 1, roleIds: [readerRole] })
    assert.equal(member1.headers.etag, '"1"')
    const memberB = (await seed.query("SELECT id FROM tenant_memberships WHERE tenant_id=$1", [tenantB])).rows[0].id as string
    assert.equal((await call("GET", `/api/v1/users/${memberB}`, "editor")).statusCode, 404, "membership of another tenant")
    const memberPath = `/api/v1/users/${readerMembership}`
    const memberInput = { status: "active", roleIds: [readerRole] }
    assert.equal((await call("PUT", memberPath, "editor", { payload: memberInput })).statusCode, 428)
    assert.equal((await call("PUT", memberPath, "reader", { match: '"1"', payload: memberInput })).statusCode, 403)
    assert.equal((await call("PUT", memberPath, "editor", { match: '"4"', payload: memberInput })).statusCode, 412)
    for (const payload of [{ status: "deleted", roleIds: [] }, { status: "active", roleIds: [readerRole, readerRole] }, { status: "active" }, { status: "active", roleIds: [], x: 1 }, { status: "pending", roleIds: [] }]) {
      const result = await call("PUT", memberPath, "editor", { match: '"1"', payload })
      assert.ok([422, 409].includes(result.statusCode), JSON.stringify(payload))
    }
    assert.equal((await call("PUT", memberPath, "editor", { match: '"1"', payload: { status: "active", roleIds: [foreignRole] } })).statusCode, 404, "role of another tenant")
    assert.equal((await call("PUT", `/api/v1/users/${editorMembership}`, "editor", { match: '"1"', payload: { status: "blocked", roleIds: [editorRole] } })).statusCode, 409, "self block")
    assert.equal((await call("PUT", `/api/v1/users/${editorMembership}`, "editor", { match: '"1"', payload: { status: "active", roleIds: [readerRole] } })).statusCode, 409, "last administrator")
    const blocked = await call("PUT", memberPath, "editor", { match: '"1"', payload: { status: "blocked", roleIds: [readerRole] } })
    assert.equal(blocked.statusCode, 200, blocked.body)
    assert.equal(blocked.json().status, "blocked")
    assert.equal(blocked.headers.etag, '"2"')
    assert.equal((await call("GET", "/api/v1/roles", "reader")).statusCode, 403, "blocked member loses access")
    assert.equal((await call("PUT", memberPath, "editor", { match: '"1"', payload: memberInput })).statusCode, 412)
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM audit_log WHERE action='membership.updated' AND entity_id=$1", [readerMembership])).rows[0].n, 1)
    await seed.query("UPDATE tenant_memberships SET status='invited' WHERE id=$1", [readerMembership])
    assert.equal((await call("PUT", memberPath, "editor", { match: '"2"', payload: { status: "active", roleIds: [readerRole] } })).statusCode, 409, "pending invitations depend on Auth")
    await seed.query("UPDATE tenant_memberships SET status='active' WHERE id=$1", [readerMembership])

    // ---- company
    const read = await call("GET", "/api/v1/company", "reader")
    assert.equal(read.statusCode, 200, read.body)
    assert.equal(read.headers.etag, '"0"')
    assert.equal(read.json().canEdit, false)
    assert.equal(read.json().tenantId, tenantA)
    assert.equal(read.json().data.legalName, "Empresa A")
    assert.equal((await call("GET", "/api/v1/company", "editor")).json().canEdit, true)
    assert.equal((await call("GET", "/api/v1/company", "outsider")).statusCode, 403)
    assert.equal((await call("PUT", "/api/v1/company", "editor", { payload: company() })).statusCode, 428)
    assert.equal((await call("PUT", "/api/v1/company", "editor", { match: "0", payload: company() })).statusCode, 400)
    assert.equal((await call("PUT", "/api/v1/company", "reader", { match: '"0"', payload: company() })).statusCode, 403)
    const invalidCompany = await call("PUT", "/api/v1/company", "editor", { match: '"0"', payload: company({ taxId: "123", postalCode: "1", segments: [] }) })
    assert.equal(invalidCompany.statusCode, 422)
    assert.deepEqual(invalidCompany.json().errors.map((error: { field: string }) => error.field), ["taxId", "segments", "postalCode"])
    assert.equal((await call("PUT", "/api/v1/company", "editor", { match: '"0"', payload: { ...company(), tenantId: tenantB } })).statusCode, 422, "unknown field")
    assert.equal((await call("PUT", "/api/v1/company", "editor", { match: '"0"', payload: company({ logoDataUrl: "https://example.test/logo.png" }) })).statusCode, 422)
    assert.equal((await call("PUT", "/api/v1/company", "editor", { match: '"3"', payload: company() })).statusCode, 412)
    assert.equal((await call("PUT", "/api/v1/company", "editor", { match: '"0"', payload: company({ taxId: "529.982.247-25", personType: "fisica" }) })).statusCode, 409, "tax id owned by another company")
    const saved = await call("PUT", "/api/v1/company", "editor", { match: '"0"', payload: company({ logoDataUrl: PNG, partnerName: "Sócia" }) })
    assert.equal(saved.statusCode, 200, saved.body)
    assert.equal(saved.headers.etag, '"1"')
    assert.equal(saved.json().data.taxId, "04252011000110")
    assert.equal(saved.json().data.postalCode, "01001000")
    assert.equal(saved.json().data.logoDataUrl, PNG)
    const omitted = await call("PUT", "/api/v1/company", "editor", { match: '"1"', payload: company({ tradeName: "Nova 2" }) })
    assert.equal(omitted.json().data.logoDataUrl, PNG, "omission preserves the logo")
    assert.equal(omitted.json().data.partnerName, "Sócia")
    const cleared = await call("PUT", "/api/v1/company", "editor", { match: '"2"', payload: company({ logoDataUrl: "" }) })
    assert.equal(cleared.json().data.logoDataUrl, "")
    assert.equal(cleared.json().revision, 3)
    assert.equal((await call("PUT", "/api/v1/company", "editor", { match: '"2"', payload: company() })).statusCode, 412)
    assert.equal((await seed.query("SELECT legal_name FROM tenants WHERE id=$1", [tenantB])).rows[0].legal_name, "Empresa B", "other tenant untouched")
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM audit_log WHERE action='company.updated' AND tenant_id=$1", [tenantA])).rows[0].n, 3)

    // ---- companies and company selection
    assert.deepEqual((await call("GET", "/api/v1/companies", "editor", { tenant: null })).json(), { data: [{ id: tenantA, legalName: "Empresa Nova Ltda", tradeName: "Nova", status: "active" }], platformAdministrator: false })
    assert.deepEqual((await call("GET", "/api/v1/companies", "outsider", { tenant: null })).json().data.map((item: { id: string }) => item.id), [tenantB])
    assert.equal((await call("GET", "/api/v1/companies", "padmin", { tenant: null })).json().data.length, 2)
    const newCompany = company({ legalName: "Terceira Ltda", taxId: "11222333000181" })
    const companyKey = randomUUID()
    assert.equal((await call("POST", "/api/v1/companies", "outsider", { tenant: null, payload: newCompany })).statusCode, 428)
    assert.equal((await call("POST", "/api/v1/companies", "outsider", { tenant: null, key: "x", payload: newCompany })).statusCode, 400)
    const badCompany = await call("POST", "/api/v1/companies", "outsider", { tenant: null, key: randomUUID(), payload: company({ taxId: "1" }) })
    assert.equal(badCompany.statusCode, 422)
    assert.equal(badCompany.json().errors[0].field, "taxId")
    const made = await call("POST", "/api/v1/companies", "outsider", { tenant: null, key: companyKey, payload: newCompany })
    assert.equal(made.statusCode, 201, made.body)
    const tenantC = made.json().tenantId as string
    assert.equal(made.json().revision, 1)
    const again = await call("POST", "/api/v1/companies", "outsider", { tenant: null, key: companyKey, payload: newCompany })
    assert.equal(again.statusCode, 201)
    assert.deepEqual(again.json(), made.json())
    assert.equal((await call("POST", "/api/v1/companies", "outsider", { tenant: null, key: companyKey, payload: company({ legalName: "Outra" }) })).statusCode, 409)
    assert.equal((await call("POST", "/api/v1/companies", "outsider", { tenant: null, key: randomUUID(), payload: newCompany })).statusCode, 409, "duplicate tax id")
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM tenants WHERE tax_id='11222333000181'")).rows[0].n, 1)
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM audit_log WHERE action='company.created' AND tenant_id=$1", [tenantC])).rows[0].n, 1)
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='company.created' AND tenant_id=$1", [tenantC])).rows[0].n, 1)
    const owned = await call("GET", "/api/v1/companies", "outsider", { tenant: null })
    assert.deepEqual(owned.json().data.map((item: { id: string }) => item.id).sort(), [tenantB, tenantC].sort())
    // Tenant switch: the new owner administers C but not A; the editor cannot enter C.
    assert.equal((await call("POST", "/api/v1/company-selection", "outsider", { tenant: tenantC })).statusCode, 204)
    assert.equal((await call("GET", "/api/v1/roles", "outsider", { tenant: tenantC })).json().data[0].code, "admin")
    assert.equal((await call("POST", "/api/v1/company-selection", "outsider", { tenant: tenantA })).statusCode, 403)
    assert.equal((await call("POST", "/api/v1/company-selection", "editor", { tenant: tenantC })).statusCode, 403)
    assert.equal((await call("GET", "/api/v1/company", "editor", { tenant: tenantC })).statusCode, 403)
    assert.equal((await call("POST", "/api/v1/company-selection", "editor", { tenant: tenantA })).statusCode, 204)
    assert.equal((await call("POST", "/api/v1/company-selection", "editor", { tenant: "bad" })).statusCode, 400)
    assert.equal((await call("POST", "/api/v1/company-selection", "padmin", { tenant: tenantB })).statusCode, 204)
    const selections = await seed.query("SELECT tenant_id,details FROM audit_log WHERE action='platform.tenant.selected' ORDER BY tenant_id")
    assert.equal(selections.rows.length, 3)
    assert.equal(selections.rows.find(row => row.tenant_id === tenantB)?.details.platformAdministrator, true)
  } finally {
    await app?.close()
    await connections.end()
    await seed.end()
    await admin.query(`DROP DATABASE ${database}`)
    await admin.query(`DROP ROLE IF EXISTS ${role}`)
    await admin.end()
  }
})
