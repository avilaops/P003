import assert from "node:assert/strict"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import test from "node:test"
import type { LightMyRequestResponse } from "fastify"

import { buildApp } from "../src/app.js"
import { SettingsSecretVault } from "../src/modules/platform-admin/secret-vault.js"
import { platformContext, type PlatformToken } from "./platform-context.js"

const PERMS = ["platform.audit.read", "platform.roles.read", "platform.integrations.manage", "platform.legacy.read"]
const keyring = JSON.stringify({ active: "k1", keys: { k1: randomBytes(32).toString("base64") } })
const vault = new SettingsSecretVault(keyring)
const skip = !process.env.API_TS_TEST_ADMIN_URL
const body = (response: LightMyRequestResponse) => response.json() as any
const problem = (response: LightMyRequestResponse, status: number, code: string) => {
  assert.equal(response.statusCode, status, response.body)
  assert.equal(body(response).type, `https://erp.avilaops.com/problems/${code}`)
}

test("GET /api/health é público e responde 503 sem banco", async () => {
  const down = buildApp({ pool: { async connect() { throw new Error("sem banco") } }, userinfoUrl: "http://x.test/userinfo" })
  const response = await down.inject({ method: "GET", url: "/api/health" })
  assert.equal(response.statusCode, 503)
  assert.deepEqual(body(response), { status: "unavailable" })
  const up = buildApp({ pool: { async connect() { return { async query() { return { rows: [{}] } }, release() {} } } } as never, userinfoUrl: "http://x.test/userinfo" })
  const ok = await up.inject({ method: "GET", url: "/api/health" })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(body(ok), { status: "ready" })
})

test("cofre de segredos usa AES-256-GCM com o contexto como dado autenticado", () => {
  const sealed = vault.seal("ctx", Buffer.from("segredo"))
  assert.equal(vault.open("ctx", sealed).toString(), "segredo")
  assert.throws(() => vault.open("outro", sealed))
})

test("permissões, auditoria, chaves de serviço, histórico legado e OpenAPI", { skip }, async () => {
  const f = await platformContext({ adminPermissions: PERMS, readerPermissions: ["platform.audit.read"] })
  try {
    const { call, seed, tenant, otherTenant } = f

    // ---- OpenAPI público
    const openapi = await call({ method: "GET", url: "/openapi.json", token: null, tenant: null })
    assert.equal(openapi.statusCode, 200)
    const doc = body(openapi)
    assert.equal(doc.openapi, "3.1.0")
    for (const path of ["/api/v1/audit", "/api/v1/integrations/service-keys/{id}", "/api/v1/legacy-history/files/{id}", "/api/health", "/openapi.json"]) assert.ok(doc.paths[path], path)
    assert.ok(doc.paths["/api/v1/integrations/service-keys"].post && doc.paths["/api/v1/integrations/service-keys/{id}"].delete)

    // ---- /api/health sem autenticação
    assert.equal((await call({ method: "GET", url: "/api/health", token: null, tenant: null })).statusCode, 200)

    // ---- permissões
    problem(await call({ method: "GET", url: "/api/v1/permissions", token: null }), 401, "missing_token")
    problem(await call({ method: "GET", url: "/api/v1/permissions", token: "visitor" }), 403, "forbidden")
    problem(await call({ method: "GET", url: "/api/v1/permissions", token: "other" }), 403, "forbidden") // outra empresa
    const permissions = await call({ method: "GET", url: "/api/v1/permissions" })
    assert.equal(permissions.statusCode, 200)
    assert.ok(body(permissions).data.some((item: { code: string }) => item.code === "platform.audit.read"))

    // ---- chaves de serviço
    const base = "/api/v1/integrations/service-keys"
    problem(await call({ method: "GET", url: base, token: null }), 401, "missing_token")
    problem(await call({ method: "GET", url: base, token: "visitor" }), 403, "forbidden")
    problem(await call({ method: "POST", url: base, token: "reader", body: { name: "Integração ERP" } }), 403, "forbidden")
    problem(await call({ method: "POST", url: base, token: null, body: { name: "Integração ERP" } }), 401, "missing_token")
    for (const invalid of [{ name: "ab" }, { name: "x".repeat(101) }, { name: "Integração", extra: 1 }, {}]) problem(await call({ method: "POST", url: base, body: invalid }), 422, "invalid_input")
    const created = await call({ method: "POST", url: base, body: { name: "  Integração ERP  " } })
    assert.equal(created.statusCode, 201, created.body)
    const key = body(created)
    assert.match(key.key, new RegExp(`^erp_${tenant}_[0-9a-f]{64}$`))
    assert.equal(key.name, "Integração ERP")
    assert.equal(key.keyPrefix, key.key.slice(0, key.key.length - 56))
    const stored = await seed.query("SELECT key_hash,key_prefix FROM service_api_keys WHERE id=$1", [key.id])
    assert.deepEqual(stored.rows[0].key_hash, createHash("sha256").update(key.key).digest())
    assert.equal(JSON.stringify(stored.rows).includes(key.key.slice(-64)), false)
    const listed = await call({ method: "GET", url: base })
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.body.includes(key.key), false)
    assert.equal(body(listed).data[0].id, key.id)
    assert.equal(body(listed).data[0].revokedAt, null)
    assert.ok(!("key" in body(listed).data[0]))
    // isolamento: outra empresa não vê nem revoga
    assert.deepEqual(body(await call({ method: "GET", url: base, token: "other", tenant: otherTenant })).data, [])
    problem(await call({ method: "DELETE", url: `${base}/${key.id}`, token: "other", tenant: otherTenant }), 404, "not_found")
    problem(await call({ method: "DELETE", url: `${base}/${key.id}`, token: "other" }), 403, "forbidden")
    problem(await call({ method: "DELETE", url: `${base}/${key.id}`, token: "visitor" }), 403, "forbidden")
    problem(await call({ method: "DELETE", url: `${base}/${key.id}`, token: null }), 401, "missing_token")
    problem(await call({ method: "DELETE", url: `${base}/${randomUUID()}` }), 404, "not_found")
    problem(await call({ method: "DELETE", url: `${base}/nao-uuid` }), 404, "not_found")
    assert.equal((await call({ method: "DELETE", url: `${base}/${key.id}` })).statusCode, 204)
    assert.equal((await call({ method: "DELETE", url: `${base}/${key.id}` })).statusCode, 204) // revogar de novo é idempotente
    assert.ok(body(await call({ method: "GET", url: base })).data[0].revokedAt)
    const revokeEvents = await seed.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_id=$1 AND action='platform.service_key.revoked'", [key.id])
    assert.equal(revokeEvents.rows[0].n, 1)

    // ---- auditoria
    const audit = "/api/v1/audit"
    problem(await call({ method: "GET", url: audit, token: null }), 401, "missing_token")
    problem(await call({ method: "GET", url: audit, token: "visitor" }), 403, "forbidden")
    await seed.query("INSERT INTO audit_log(tenant_id,action,entity_type,entity_id,details,occurred_at) SELECT $1,'thing.deleted','thing',g::text,'{\"segredo\":1}',timestamptz '2026-01-01 12:00+00' + g * interval '1 minute' FROM generate_series(1,30) g", [tenant])
    await seed.query("INSERT INTO audit_log(tenant_id,action,entity_type,entity_id,details) VALUES($1,'outra.empresa','thing','x','{}')", [otherTenant])
    const page = body(await call({ method: "GET", url: `${audit}?entity=thing`, token: "reader" }))
    assert.equal(page.tenantId, tenant)
    assert.equal(page.data.length, 25)
    assert.ok(page.nextCursor)
    assert.deepEqual(Object.keys(page.data[0]).sort(), ["action", "actor", "entityType", "id", "occurredAt"])
    const next = body(await call({ method: "GET", url: `${audit}?entity=thing&before=${page.nextCursor}` }))
    assert.equal(next.data.length, 5)
    assert.equal(next.nextCursor, null)
    assert.equal(new Set([...page.data, ...next.data].map((item: { id: string }) => item.id)).size, 30)
    const fromOther = body(await call({ method: "GET", url: audit, token: "other", tenant: otherTenant }))
    assert.deepEqual(fromOther.data.map((item: { action: string }) => item.action), ["outra.empresa"])
    problem(await call({ method: "GET", url: `${audit}?before=${fromOther.data[0].id}` }), 422, "invalid_input") // cursor de outra empresa
    assert.equal(body(await call({ method: "GET", url: `${audit}?category=deletions&startDate=2026-01-01&endDate=2026-01-01` })).data.length, 25)
    assert.equal(body(await call({ method: "GET", url: `${audit}?action=nenhuma` })).data.length, 0)
    assert.equal(body(await call({ method: "GET", url: `${audit}?startDate=2026-01-02` })).data.some((item: { entityType: string }) => item.entityType === "thing"), false)
    for (const query of ["category=outra", "startDate=2026-13-01", "endDate=ontem", "startDate=2026-02-01&endDate=2026-01-01", "foo=1", `q=${"x".repeat(121)}`, `before=${randomUUID()}`]) problem(await call({ method: "GET", url: `${audit}?${query}` }), 422, "invalid_input")

    // ---- histórico legado
    const legacy = "/api/v1/legacy-history"
    problem(await call({ method: "GET", url: legacy, token: null }), 401, "missing_token")
    problem(await call({ method: "GET", url: legacy, token: "visitor" }), 403, "forbidden")
    const ids = Array.from({ length: 27 }, () => randomUUID()).sort()
    const fileA = randomUUID(), fileB = randomUUID(), foreignHistory = randomUUID()
    for (const [index, id] of ids.entries()) await seed.query("INSERT INTO legacy_history(tenant_id,id,collection,title,details) VALUES($1,$2,'clientes',$3,'{}')", [tenant, id, `Registro ${index}`])
    await seed.query("INSERT INTO legacy_files(tenant_id,id,history_id,filename,media_type,content,sha256) VALUES($1,$2,$3,'nota fiscal \"ç\".png','image/png',$4,'x'),($1,$5,$3,'script.html','text/html',$6,'y')", [tenant, fileA, ids[0], Buffer.from([137, 80, 78, 71]), fileB, Buffer.from("<script>")])
    await seed.query("INSERT INTO legacy_history(tenant_id,id,collection,title,details) VALUES($1,$2,'clientes','Da outra empresa','{}')", [otherTenant, foreignHistory])
    const foreignFile = randomUUID()
    await seed.query("INSERT INTO legacy_files(tenant_id,id,history_id,filename,media_type,content,sha256) VALUES($1,$2,$3,'b.png','image/png',$4,'z')", [otherTenant, foreignFile, foreignHistory, Buffer.from("B")])
    const first = body(await call({ method: "GET", url: legacy }))
    assert.equal(first.total, 27)
    assert.equal(first.data.length, 25)
    assert.deepEqual(first.collections, [{ name: "clientes", count: 27 }])
    assert.deepEqual(first.data[0].files.map((file: { id: string }) => file.id).sort(), [fileA, fileB].sort())
    assert.equal(first.nextCursor.id, first.data[24].id)
    const second = body(await call({ method: "GET", url: `${legacy}?afterCollection=clientes&afterId=${first.nextCursor.id}` }))
    assert.equal(second.data.length, 2)
    assert.equal(second.nextCursor, null)
    assert.equal(body(await call({ method: "GET", url: `${legacy}?offset=25` })).data.length, 2)
    assert.equal(body(await call({ method: "GET", url: legacy, token: "other", tenant: otherTenant })).total, 1)
    for (const query of ["offset=100001", "offset=-1", "offset=x", "afterId=" + randomUUID(), "afterCollection=clientes", "afterCollection=a&afterId=" + randomUUID() + "&offset=5", "afterCollection=a&afterId=" + randomUUID() + "&collection=b", "foo=1"]) problem(await call({ method: "GET", url: `${legacy}?${query}` }), 422, "invalid_input")
    const png = await call({ method: "GET", url: `${legacy}/files/${fileA}` })
    assert.equal(png.statusCode, 200)
    assert.equal(png.headers["content-type"], "image/png")
    assert.match(String(png.headers["content-disposition"]), /^attachment; filename="nota fiscal _[^"]*"; filename\*=UTF-8''/)
    assert.equal(png.headers["x-content-type-options"], "nosniff")
    assert.equal(png.headers["cache-control"], "no-store")
    assert.deepEqual([...png.rawPayload], [137, 80, 78, 71])
    assert.equal((await call({ method: "GET", url: `${legacy}/files/${fileB}` })).headers["content-type"], "application/octet-stream")
    problem(await call({ method: "GET", url: `${legacy}/files/${foreignFile}` }), 404, "not_found") // arquivo de outra empresa
    problem(await call({ method: "GET", url: `${legacy}/files/${foreignFile}`, token: "other" }), 403, "forbidden")
    assert.equal((await call({ method: "GET", url: `${legacy}/files/${foreignFile}`, token: "other", tenant: otherTenant })).statusCode, 200)
    problem(await call({ method: "GET", url: `${legacy}/files/${fileA}`, token: null }), 401, "missing_token")
    problem(await call({ method: "GET", url: `${legacy}/files/${fileA}`, token: "visitor" }), 403, "forbidden")
    problem(await call({ method: "GET", url: `${legacy}/files/${randomUUID()}` }), 404, "not_found")
  } finally { await f.close() }
})

test("configuração SMTP da plataforma: somente administradores, ETag, cifra e sem segredo na resposta", { skip }, async () => {
  const f = await platformContext({ adminPermissions: PERMS, readerIsPlatformAdministrator: true, dependencies: { platformAdmin: { mail: { vault } } } })
  try {
    const { call, seed } = f
    // `reader` é administrador da plataforma; `admin` (administrador só da empresa) não é.
    const url = "/api/v1/platform/mail-settings"
    const settings = { enabled: true, name: "Central", host: " SMTP.Example.Test ", port: 587, security: "starttls", username: "usuario", fromName: "Empresa", fromAddress: "vendas@example.test", password: "senha-secreta-teste" }
    const put = (revision: string | undefined, payload: unknown, token: PlatformToken = "reader") => call({ method: "PUT", url, token, tenant: null, body: payload, headers: revision ? { "if-match": revision } : {} })
    problem(await call({ method: "GET", url, token: null, tenant: null }), 401, "missing_token")
    problem(await call({ method: "GET", url, tenant: null }), 403, "forbidden")
    problem(await put('"0"', settings, "admin"), 403, "forbidden")
    problem(await put('"0"', settings, "visitor"), 403, "forbidden")
    problem(await put('"0"', settings, "other"), 403, "forbidden")
    const initial = await call({ method: "GET", url, token: "reader", tenant: null })
    assert.equal(initial.statusCode, 200)
    assert.equal(body(initial).revision, 0)
    assert.equal(body(initial).source, "unconfigured")
    assert.equal(body(initial).encryptionReady, true)
    assert.equal(initial.headers.etag, '"0"')
    problem(await put(undefined, settings), 428, "revision_required")
    for (const raw of ["0", "W/\"0\"", "*", '"x"', '"-1"', '"9223372036854775808"']) problem(await put(raw, settings), 400, "invalid_revision")
    problem(await put('"1"', settings), 412, "revision_conflict")
    for (const invalid of [{ ...settings, host: "smtp://x" }, { ...settings, host: "a..b" }, { ...settings, port: 0 }, { ...settings, port: 70000 }, { ...settings, security: "none" }, { ...settings, fromAddress: "Alguém <a@b.co>" }, { ...settings, fromName: "x\r\nBcc: y" }, { ...settings, extra: 1 }, { ...settings, username: "" }, { ...settings, password: null }]) problem(await put('"0"', invalid), 422, "invalid_input")
    const saved = await put('"0"', settings)
    assert.equal(saved.statusCode, 200, saved.body)
    assert.equal(saved.headers.etag, '"1"')
    assert.equal(body(saved).source, "platform")
    assert.equal(body(saved).data.passwordSet, true)
    assert.equal(body(saved).data.host, "smtp.example.test")
    assert.equal(saved.body.includes("senha-secreta-teste"), false)
    assert.equal((await call({ method: "GET", url, token: "reader", tenant: null })).body.includes("senha-secreta-teste"), false)
    const row = (await seed.query("SELECT secret_context,secret_key_id,secret_nonce,secret_ciphertext,data FROM platform_mail_settings")).rows[0]
    assert.equal(JSON.stringify(row.data).includes("senha"), false)
    assert.equal(vault.open(row.secret_context, { keyId: row.secret_key_id, nonce: row.secret_nonce, ciphertext: row.secret_ciphertext }).toString(), "senha-secreta-teste")
    // revisão desatualizada preserva a edição; sem senha, o segredo atual é mantido
    problem(await put('"0"', settings), 412, "revision_conflict")
    const kept = await put('"1"', { ...settings, name: "Renomeada", password: undefined })
    assert.equal(kept.statusCode, 200, kept.body)
    assert.equal(body(kept).revision, 2)
    assert.equal(body(kept).data.passwordSet, true)
    // trocar servidor exige nova senha
    problem(await put('"2"', { ...settings, host: "outro.example.test", password: undefined }), 422, "invalid_input")
    assert.equal((await put('"2"', { ...settings, host: "outro.example.test" })).statusCode, 200)
    // desativar sem senha mantém o cadastro
    assert.equal(body(await put('"3"', { ...settings, host: "outro.example.test", enabled: false, password: undefined })).data.enabled, false)
  } finally { await f.close() }
})

test("configuração SMTP: sem cofre não ativa nem salva senha; ambiente aparece até o primeiro salvamento", { skip }, async () => {
  const environment = { enabled: true, name: "Ambiente", host: "smtp.env.test", port: 465, security: "tls" as const, username: "env", fromName: "Env", fromAddress: "env@example.test", passwordSet: true }
  const f = await platformContext({ adminPermissions: PERMS, readerIsPlatformAdministrator: true, dependencies: { platformAdmin: { mail: { environment } } } })
  try {
    const url = "/api/v1/platform/mail-settings"
    const initial = body(await f.call({ method: "GET", url, token: "reader", tenant: null }))
    assert.equal(initial.source, "environment")
    assert.equal(initial.encryptionReady, false)
    assert.equal(initial.data.host, "smtp.env.test")
    const base = { enabled: false, name: "", host: "smtp.example.test", port: 587, security: "starttls", username: "u", fromName: "", fromAddress: "" }
    const send = (payload: unknown) => f.call({ method: "PUT", url, token: "reader", tenant: null, body: payload, headers: { "if-match": '"0"' } })
    problem(await send({ ...base, enabled: true, fromAddress: "a@example.test" }), 422, "invalid_input")
    problem(await send({ ...base, password: "x" }), 422, "invalid_input")
    assert.equal((await send(base)).statusCode, 200)
  } finally { await f.close() }
})
