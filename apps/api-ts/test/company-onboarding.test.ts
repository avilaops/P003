import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { databaseTestOptions, withTestContext } from "./support/test-context.js"

// Empresa, cadastro de empresas e seleção de empresa (porte de company.rs / onboarding.rs).
// `user` administra a empresa A; `denied` só consulta a empresa; `outsider` administra apenas a empresa B.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=="
const company = (overrides: Record<string, unknown> = {}) => ({
  legalName: "Empresa Nova Ltda", tradeName: "Nova", personType: "juridica", taxId: "04.252.011/0001-10", taxRegime: "simples",
  segments: ["Comércio"], postalCode: "01001-000", state: "SP", city: "São Paulo", street: "Praça da Sé", number: "1", district: "Sé", ...overrides,
})

test("empresa, cadastro e seleção de empresa", databaseTestOptions, async t => {
  await withTestContext({}, async ctx => {
    await ctx.seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT r.id,p.code FROM roles r CROSS JOIN permissions p WHERE r.code='user' AND r.tenant_id=$1 ON CONFLICT DO NOTHING", [ctx.tenant])
    await ctx.grant("denied", "platform.company.read")
    const user = ctx.as("user"), denied = ctx.as("denied"), outsider = ctx.as("outsider"), anonymous = ctx.as("anonymous")
    const noTenant = (token: string | undefined, method: "GET" | "POST", url: string, init: { key?: string; body?: unknown } = {}) => ctx.app.inject({
      method, url, ...(init.body === undefined ? {} : { payload: init.body as object }),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.key ? { "idempotency-key": init.key } : {}) },
    })

    await t.test("GET /api/v1/company + PUT /api/v1/company [negado] sem token, de outra empresa e sem permissão de gerenciar", async () => {
      assert.equal((await anonymous.get("/api/v1/company")).statusCode, 401)
      assert.equal((await anonymous.put("/api/v1/company", { body: company(), revision: 0 })).statusCode, 401)
      assert.equal((await outsider.get("/api/v1/company")).statusCode, 403)
      assert.equal((await outsider.put("/api/v1/company", { body: company(), revision: 0 })).statusCode, 403)
      assert.equal((await denied.put("/api/v1/company", { body: company(), revision: 0 })).statusCode, 403)
    })

    await t.test("GET /api/v1/company [sucesso] lê os dados da empresa ativa com ETag", async () => {
      const read = await denied.get("/api/v1/company")
      assert.equal(read.statusCode, 200, read.body)
      assert.equal(read.headers.etag, '"0"')
      assert.deepEqual([read.json().canEdit, read.json().tenantId, read.json().data.legalName], [false, ctx.tenant, "Empresa A"])
      assert.equal((await user.get("/api/v1/company")).json().canEdit, true)
    })

    await t.test("PUT /api/v1/company [sucesso] grava com If-Match, valida campos e preserva logo omitido", async () => {
      assert.equal((await user.put("/api/v1/company", { body: company() })).statusCode, 428)
      assert.equal((await user.put("/api/v1/company", { body: company(), headers: { "if-match": "0" } })).statusCode, 400)
      const invalid = await user.put("/api/v1/company", { body: company({ taxId: "123", postalCode: "1", segments: [] }), revision: 0 })
      assert.equal(invalid.statusCode, 422)
      assert.deepEqual(invalid.json().errors.map((error: { field: string }) => error.field), ["taxId", "segments", "postalCode"])
      assert.equal((await user.put("/api/v1/company", { body: { ...company(), tenantId: ctx.otherTenant }, revision: 0 })).statusCode, 422, "campo desconhecido")
      assert.equal((await user.put("/api/v1/company", { body: company({ logoDataUrl: "https://example.test/logo.png" }), revision: 0 })).statusCode, 422)
      assert.equal((await user.put("/api/v1/company", { body: company(), revision: 3 })).statusCode, 412)
      assert.equal((await user.put("/api/v1/company", { body: company({ taxId: "529.982.247-25", personType: "fisica" }), revision: 0 })).statusCode, 409, "documento de outra empresa")
      const saved = await user.put("/api/v1/company", { body: company({ logoDataUrl: PNG, partnerName: "Sócia" }), revision: 0 })
      assert.equal(saved.statusCode, 200, saved.body)
      assert.equal(saved.headers.etag, '"1"')
      assert.deepEqual([saved.json().data.taxId, saved.json().data.postalCode, saved.json().data.logoDataUrl], ["04252011000110", "01001000", PNG])
      const omitted = await user.put("/api/v1/company", { body: company({ tradeName: "Nova 2" }), revision: 1 })
      assert.deepEqual([omitted.json().data.logoDataUrl, omitted.json().data.partnerName], [PNG, "Sócia"], "omissão preserva logo e sócio")
      const cleared = await user.put("/api/v1/company", { body: company({ logoDataUrl: "" }), revision: 2 })
      assert.deepEqual([cleared.json().data.logoDataUrl, cleared.json().revision], ["", 3])
      assert.equal((await user.put("/api/v1/company", { body: company(), revision: 2 })).statusCode, 412)
      assert.equal((await ctx.seed.query("SELECT legal_name FROM tenants WHERE id=$1", [ctx.otherTenant])).rows[0].legal_name, "Empresa B", "outra empresa intacta")
      assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM audit_log WHERE action='company.updated' AND tenant_id=$1", [ctx.tenant])).rows[0].n, 3)
    })

    let tenantC = ""
    await t.test("GET /api/v1/companies + POST /api/v1/companies + POST /api/v1/company-selection [negado] sem token, chave ausente e empresa alheia", async () => {
      assert.equal((await noTenant(undefined, "GET", "/api/v1/companies")).statusCode, 401)
      assert.equal((await noTenant("invalido", "GET", "/api/v1/companies")).statusCode, 401)
      assert.equal((await noTenant(undefined, "POST", "/api/v1/companies", { key: randomUUID(), body: company() })).statusCode, 401)
      assert.equal((await anonymous.post("/api/v1/company-selection")).statusCode, 401)
      assert.equal((await outsider.post("/api/v1/company-selection")).statusCode, 403, "só seleciona empresa a que pertence")
      assert.equal((await user.post("/api/v1/company-selection", { tenant: ctx.otherTenant })).statusCode, 403)
      assert.equal((await user.post("/api/v1/company-selection", { headers: { "x-tenant-id": "ruim" } })).statusCode, 400)
    })

    await t.test("GET /api/v1/companies [sucesso] lista só as empresas do usuário; administrador da plataforma vê todas", async () => {
      assert.deepEqual((await noTenant("user", "GET", "/api/v1/companies")).json(), { data: [{ id: ctx.tenant, legalName: "Empresa Nova Ltda", tradeName: "Nova", status: "active" }], platformAdministrator: false })
      assert.deepEqual((await noTenant("outsider", "GET", "/api/v1/companies")).json().data.map((item: { id: string }) => item.id), [ctx.otherTenant])
      await ctx.seed.query("INSERT INTO platform_administrators(auth_subject,granted_by,reason) VALUES('denied','teste','teste')")
      try {
        const all = (await noTenant("denied", "GET", "/api/v1/companies")).json()
        assert.deepEqual([all.data.length, all.platformAdministrator], [2, true])
        assert.equal((await denied.post("/api/v1/company-selection", { tenant: ctx.otherTenant })).statusCode, 204, "administrador da plataforma entra em qualquer empresa")
        const selected = await ctx.seed.query("SELECT details FROM audit_log WHERE action='platform.tenant.selected' AND tenant_id=$1", [ctx.otherTenant])
        assert.equal(selected.rows[0]?.details.platformAdministrator, true)
      } finally { await ctx.seed.query("DELETE FROM platform_administrators WHERE auth_subject='denied'") }
    })

    await t.test("POST /api/v1/companies [sucesso] cria empresa com Idempotency-Key e torna quem criou administrador", async () => {
      const newCompany = company({ legalName: "Terceira Ltda", taxId: "11222333000181" }), key = randomUUID()
      assert.equal((await noTenant("outsider", "POST", "/api/v1/companies", { body: newCompany })).statusCode, 428)
      assert.equal((await noTenant("outsider", "POST", "/api/v1/companies", { key: "x", body: newCompany })).statusCode, 400)
      const bad = await noTenant("outsider", "POST", "/api/v1/companies", { key: randomUUID(), body: company({ taxId: "1" }) })
      assert.equal(bad.statusCode, 422)
      assert.equal(bad.json().errors[0].field, "taxId")
      const made = await noTenant("outsider", "POST", "/api/v1/companies", { key, body: newCompany })
      assert.equal(made.statusCode, 201, made.body)
      tenantC = made.json().tenantId
      assert.equal(made.json().revision, 1)
      const again = await noTenant("outsider", "POST", "/api/v1/companies", { key, body: newCompany })
      assert.deepEqual([again.statusCode, again.json()], [201, made.json()], "mesma intenção repetida")
      assert.equal((await noTenant("outsider", "POST", "/api/v1/companies", { key, body: company({ legalName: "Outra" }) })).statusCode, 409)
      assert.equal((await noTenant("outsider", "POST", "/api/v1/companies", { key: randomUUID(), body: newCompany })).statusCode, 409, "documento repetido")
      const evidence = await ctx.seed.query("SELECT (SELECT count(*)::int FROM tenants WHERE tax_id='11222333000181') AS tenants,(SELECT count(*)::int FROM audit_log WHERE action='company.created' AND tenant_id=$1) AS audits,(SELECT count(*)::int FROM outbox_events WHERE event_type='company.created' AND tenant_id=$1) AS events", [tenantC])
      assert.deepEqual(evidence.rows[0], { tenants: 1, audits: 1, events: 1 })
      assert.deepEqual((await noTenant("outsider", "GET", "/api/v1/companies")).json().data.map((item: { id: string }) => item.id).sort(), [ctx.otherTenant, tenantC].sort())
    })

    await t.test("POST /api/v1/company-selection [sucesso] troca de empresa só entre as do usuário", async () => {
      assert.equal((await outsider.post("/api/v1/company-selection", { tenant: tenantC })).statusCode, 204)
      assert.equal((await outsider.get("/api/v1/roles", { tenant: tenantC })).json().data[0].code, "admin")
      assert.equal((await outsider.post("/api/v1/company-selection", { tenant: ctx.tenant })).statusCode, 403)
      assert.equal((await user.post("/api/v1/company-selection", { tenant: tenantC })).statusCode, 403)
      assert.equal((await user.get("/api/v1/company", { tenant: tenantC })).statusCode, 403)
      assert.equal((await user.post("/api/v1/company-selection")).statusCode, 204)
      assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM audit_log WHERE action='platform.tenant.selected'")).rows[0].n, 3)
    })
  })
})
