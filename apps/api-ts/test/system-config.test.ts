import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import test from "node:test"

import { platformFixture } from "./platform-fixture.js"

const skip = !process.env.API_TS_TEST_ADMIN_URL
const admin = ["system.custom_fields.read", "system.custom_fields.manage", "system.labels.manage", "system.workflows.manage", "system.files.read", "system.files.manage"]
const reader = ["system.custom_fields.read", "system.files.read"]
const etag = (response: { headers: Record<string, unknown> }) => String(response.headers.etag)
const json = (response: { body: string }) => JSON.parse(response.body)

test("system-config: campos personalizados", { skip }, async () => {
  const f = await platformFixture({ adminPermissions: admin, readerPermissions: reader })
  try {
    const input = { entityType: "product", code: "cor", label: " Cor ", valueType: "choice", choices: ["verde", "azul", "azul"] }
    const url = "/api/v1/system/custom-fields"
    assert.equal((await f.call({ method: "GET", url, token: null })).statusCode, 401)
    assert.equal((await f.call({ method: "GET", url, token: "visitor" })).statusCode, 403)
    assert.equal((await f.call({ method: "POST", url, token: "reader", body: input })).statusCode, 403)
    assert.equal((await f.call({ method: "POST", url, token: null, body: input })).statusCode, 401)
    for (const bad of [{ ...input, extra: 1 }, { ...input, code: "Cor" }, { ...input, entityType: "x" }, { ...input, valueType: "text" }, { ...input, choices: [] }]) {
      assert.equal((await f.call({ method: "POST", url, body: bad })).statusCode, 422)
    }
    const created = await f.call({ method: "POST", url, body: input })
    assert.equal(created.statusCode, 201)
    assert.equal(etag(created), '"1"')
    const field = json(created).data
    assert.equal(field.label, "Cor")
    assert.deepEqual(field.choices, ["azul", "verde"])
    assert.equal(field.revision, 1)
    assert.equal((await f.call({ method: "POST", url, body: input })).statusCode, 409)

    const listed = json(await f.call({ method: "GET", url, token: "reader" }))
    assert.equal(listed.canEdit, false)
    assert.equal(listed.data.length, 1)
    // isolamento: empresa B não vê o campo e não o edita
    const foreign = await f.call({ method: "GET", url, token: "other", tenant: f.otherTenant })
    assert.deepEqual(json(foreign).data, [])
    assert.equal((await f.call({ method: "GET", url, token: "other" })).statusCode, 403)
    const update = { ...input, label: "Cor do produto", required: true }
    assert.equal((await f.call({ method: "PUT", url: `${url}/${field.id}`, token: "other", tenant: f.otherTenant, body: update, headers: { "if-match": '"1"' } })).statusCode, 404)
    assert.equal((await f.call({ method: "PUT", url: `${url}/${field.id}`, body: update })).statusCode, 428)
    assert.equal((await f.call({ method: "PUT", url: `${url}/${field.id}`, body: update, headers: { "if-match": "1" } })).statusCode, 400)
    assert.equal((await f.call({ method: "PUT", url: `${url}/${field.id}`, token: "reader", body: update, headers: { "if-match": '"1"' } })).statusCode, 403)
    assert.equal((await f.call({ method: "PUT", url: `${url}/${field.id}`, body: { ...update, bogus: 1 }, headers: { "if-match": '"1"' } })).statusCode, 422)
    assert.equal((await f.call({ method: "PUT", url: `${url}/${field.id}`, body: update, headers: { "if-match": '"9"' } })).statusCode, 412)
    assert.equal((await f.call({ method: "PUT", url: `${url}/${randomUUID()}`, body: update, headers: { "if-match": '"1"' } })).statusCode, 404)
    // código imutável: alteração não casa com a linha
    assert.equal((await f.call({ method: "PUT", url: `${url}/${field.id}`, body: { ...update, code: "outro" }, headers: { "if-match": '"1"' } })).statusCode, 412)
    const updated = await f.call({ method: "PUT", url: `${url}/${field.id}`, body: update, headers: { "if-match": '"1"' } })
    assert.equal(updated.statusCode, 200)
    assert.equal(etag(updated), '"2"')
    const archived = await f.call({ method: "PUT", url: `${url}/${field.id}`, body: { ...update, status: "archived" }, headers: { "if-match": '"2"' } })
    assert.equal(json(archived).data.status, "archived")
    const events = await f.seed.query("SELECT action FROM audit_log WHERE entity_type='custom_field' ORDER BY occurred_at,id")
    assert.deepEqual(events.rows.map(r => r.action), ["custom_field.created", "custom_field.updated", "custom_field.archived"])
  } finally { await f.close() }
})

test("system-config: modelos de etiqueta", { skip }, async () => {
  const f = await platformFixture({ adminPermissions: admin, readerPermissions: reader })
  try {
    const url = "/api/v1/system/label-templates"
    const input = { name: "Gôndola", widthMm: 60, heightMm: 40, source: "product", elements: [{ kind: "text", field: "name", xMm: 2, yMm: 2, widthMm: 40, heightMm: 8 }, { kind: "barcode", field: "code", label: " EAN ", xMm: 2, yMm: 12, widthMm: 40, heightMm: 20, fontSizePt: 8 }] }
    assert.equal((await f.call({ method: "GET", url, token: null })).statusCode, 401)
    assert.equal((await f.call({ method: "GET", url, token: "visitor" })).statusCode, 403)
    assert.equal((await f.call({ method: "POST", url, token: "visitor", body: input })).statusCode, 403)
    for (const bad of [{ ...input, extra: 1 }, { ...input, widthMm: 5 }, { ...input, source: "x" }, { ...input, elements: [] }, { ...input, elements: [{ ...input.elements[0], field: "price", kind: "img" }] }, { ...input, elements: [{ ...input.elements[0], field: "document" }] }, { ...input, elements: [{ ...input.elements[0], widthMm: 80 }] }]) {
      assert.equal((await f.call({ method: "POST", url, body: bad })).statusCode, 422)
    }
    const created = await f.call({ method: "POST", url, body: input })
    assert.equal(created.statusCode, 201)
    const tpl = json(created).data
    assert.equal(tpl.widthMm, 60)
    assert.equal(tpl.layout.elements[0].fontSizePt, 10)
    assert.equal(tpl.layout.elements[1].label, "EAN")
    assert.deepEqual(json(await f.call({ method: "GET", url, token: "other", tenant: f.otherTenant })).data, [])
    assert.equal(json(await f.call({ method: "GET", url })).data.length, 1)
    const put = (body: unknown, match: string | undefined, extra: Record<string, unknown> = {}) => f.call({ method: "PUT", url: `${url}/${extra.id ?? tpl.id}`, ...(extra.token ? { token: extra.token as string } : {}), ...(extra.tenant ? { tenant: extra.tenant as string } : {}), body, headers: match ? { "if-match": match } : {} })
    assert.equal((await put({ ...input, name: "Novo" }, undefined)).statusCode, 428)
    assert.equal((await put({ ...input, name: "Novo" }, '"3"')).statusCode, 412)
    assert.equal((await put({ ...input, extra: 1 }, '"1"')).statusCode, 422)
    assert.equal((await put({ ...input, name: "Novo" }, '"1"', { token: "other", tenant: f.otherTenant })).statusCode, 404)
    assert.equal((await put({ ...input, name: "Novo" }, '"1"', { id: randomUUID() })).statusCode, 404)
    const ok = await put({ ...input, name: "Novo" }, '"1"')
    assert.equal(ok.statusCode, 200)
    assert.equal(etag(ok), '"2"')
    assert.equal(json(ok).data.name, "Novo")
  } finally { await f.close() }
})

test("system-config: fluxos de trabalho", { skip }, async () => {
  const f = await platformFixture({ adminPermissions: admin })
  try {
    const url = "/api/v1/system/workflows"
    const flow = (version = 1) => ({ code: "aprovacao", version, name: "Aprovação", states: [{ code: "novo", label: "Novo", isInitial: true }, { code: "ok", label: "Aprovado", isTerminal: true }], transitions: [{ fromState: "novo", toState: "ok", permissionCode: "system.files.read" }] })
    assert.equal((await f.call({ method: "GET", url, token: null })).statusCode, 401)
    assert.equal((await f.call({ method: "GET", url, token: "visitor" })).statusCode, 403)
    assert.equal((await f.call({ method: "POST", url, token: "visitor", body: flow() })).statusCode, 403)
    const f1 = flow()
    for (const bad of [{ ...f1, x: 1 }, { ...f1, version: 0 }, { ...f1, code: "A" }, { ...f1, states: [f1.states[0]] }, { ...f1, transitions: [{ ...f1.transitions[0], toState: "novo" }] }, { ...f1, transitions: [{ ...f1.transitions[0], fromState: "ok", toState: "novo" }] }, { ...f1, transitions: [{ ...f1.transitions[0], permissionCode: "nao.existe" }] }]) {
      assert.equal((await f.call({ method: "POST", url, body: bad })).statusCode, 422)
    }
    const created = await f.call({ method: "POST", url, body: f1 })
    assert.equal(created.statusCode, 201)
    const wf = json(created).data
    assert.equal(wf.status, "draft")
    assert.equal(wf.transitions[0].requiresReason, true)
    assert.equal((await f.call({ method: "POST", url, body: f1 })).statusCode, 409)
    const listed = json(await f.call({ method: "GET", url }))
    assert.equal(listed.data.length, 1)
    assert.ok(listed.permissions.length > 0)
    assert.deepEqual(json(await f.call({ method: "GET", url, token: "other", tenant: f.otherTenant })).data, [])
    const wfUrl = `${url}/${wf.id}`
    const h = (v: string) => ({ "if-match": v })
    assert.equal((await f.call({ method: "PUT", url: wfUrl, body: f1 })).statusCode, 428)
    assert.equal((await f.call({ method: "PUT", url: wfUrl, body: f1, headers: h('"7"') })).statusCode, 412)
    assert.equal((await f.call({ method: "PUT", url: wfUrl, body: flow(2), headers: h('"1"') })).statusCode, 422)
    assert.equal((await f.call({ method: "PUT", url: wfUrl, token: "other", tenant: f.otherTenant, body: f1, headers: h('"1"') })).statusCode, 404)
    const edited = await f.call({ method: "PUT", url: wfUrl, body: { ...f1, name: "Aprovação 2" }, headers: h('"1"') })
    assert.equal(edited.statusCode, 200)
    assert.equal(etag(edited), '"2"')
    for (const action of ["publish", "archive"]) {
      assert.equal((await f.call({ method: "POST", url: `${wfUrl}/${action}` })).statusCode, 428)
      assert.equal((await f.call({ method: "POST", url: `${wfUrl}/${action}`, token: "other", tenant: f.otherTenant, headers: h('"2"') })).statusCode, 404)
      assert.equal((await f.call({ method: "POST", url: `${wfUrl}/${action}`, token: "visitor", headers: h('"2"') })).statusCode, 403)
    }
    assert.equal((await f.call({ method: "POST", url: `${wfUrl}/archive`, headers: h('"2"') })).statusCode, 409)
    assert.equal((await f.call({ method: "POST", url: `${wfUrl}/publish`, headers: h('"1"') })).statusCode, 412)
    const published = await f.call({ method: "POST", url: `${wfUrl}/publish`, headers: h('"2"') })
    assert.equal(json(published).data.status, "published")
    assert.equal(etag(published), '"3"')
    assert.equal((await f.call({ method: "PUT", url: wfUrl, body: f1, headers: h('"3"') })).statusCode, 409)
    // outra versão não publica enquanto a primeira estiver publicada
    const v2 = json(await f.call({ method: "POST", url, body: flow(2) })).data
    assert.equal((await f.call({ method: "POST", url: `${url}/${v2.id}/publish`, headers: h('"1"') })).statusCode, 409)
    const archived = await f.call({ method: "POST", url: `${wfUrl}/archive`, headers: h('"3"') })
    assert.equal(json(archived).data.status, "archived")
    assert.equal((await f.call({ method: "POST", url: `${url}/${v2.id}/publish`, headers: h('"1"') })).statusCode, 200)
  } finally { await f.close() }
})

test("system-config: arquivos", { skip }, async () => {
  const f = await platformFixture({ adminPermissions: admin, readerPermissions: reader })
  try {
    const url = "/api/v1/system/files"
    const content = Buffer.from("%PDF-1.4 conteúdo")
    const history = randomUUID(), legacy = randomUUID(), legacyHtml = randomUUID(), systemFile = randomUUID(), foreignHistory = randomUUID(), foreignFile = randomUUID()
    const sha = createHash("sha256").update(content).digest("hex")
    await f.seed.query("INSERT INTO legacy_history(tenant_id,id,collection,title,details) VALUES($1,$2,'docs','Manual','{}'),($3,$4,'docs','Alheio','{}')", [f.tenant, history, f.otherTenant, foreignHistory])
    await f.seed.query("INSERT INTO legacy_files(tenant_id,id,history_id,filename,media_type,content,sha256) VALUES($1,$2,$3,'manual ç.pdf','application/pdf',$4,$5),($1,$6,$3,'x.html','text/html',$7,$5),($8,$9,$10,'alheio.pdf','application/pdf',$4,$5)", [f.tenant, legacy, history, content, sha, legacyHtml, Buffer.from("<script>1</script>"), f.otherTenant, foreignFile, foreignHistory])
    await f.seed.query("INSERT INTO system_config.files(tenant_id,id,storage_key,original_name,media_type,byte_size,sha256,status,created_by) SELECT $1,$2,'k1','sistema.png','image/png',10,$3,'available',id FROM identities WHERE auth_subject='admin'", [f.tenant, systemFile, sha])

    assert.equal((await f.call({ method: "GET", url, token: null })).statusCode, 401)
    assert.equal((await f.call({ method: "GET", url, token: "visitor" })).statusCode, 403)
    for (const q of ["?origin=x", "?status=x", "?limit=0", "?limit=101", "?offset=-1", "?foo=1", "?limit=abc"]) assert.equal((await f.call({ method: "GET", url: url + q })).statusCode, 422, q)
    const listed = json(await f.call({ method: "GET", url: url + "?limit=2", token: "reader" }))
    assert.equal(listed.total, 3)
    assert.equal(listed.data.length, 2)
    assert.equal(listed.canEdit, false)
    assert.equal(json(await f.call({ method: "GET", url: url + "?origin=legacy&q=MANUAL" })).total, 1)
    assert.equal(json(await f.call({ method: "GET", url: url + "?origin=system" })).data[0].filename, "sistema.png")
    const foreign = json(await f.call({ method: "GET", url, token: "other", tenant: f.otherTenant }))
    assert.deepEqual(foreign.data.map((r: { id: string }) => r.id), [foreignFile])

    // conteúdo
    const ok = await f.call({ method: "GET", url: `${url}/${legacy}/content`, token: "reader" })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.headers["content-type"], "application/pdf")
    assert.equal(ok.headers["x-content-type-options"], "nosniff")
    assert.equal(ok.headers["cache-control"], "no-store")
    assert.match(String(ok.headers["content-disposition"]), /^attachment; filename="manual _\.pdf"; filename\*=UTF-8''manual%20%C3%A7\.pdf$/)
    assert.deepEqual(ok.rawPayload, content)
    assert.equal((await f.call({ method: "GET", url: `${url}/${legacyHtml}/content` })).headers["content-type"], "application/octet-stream")
    assert.equal((await f.call({ method: "GET", url: `${url}/${legacy}/content`, token: null })).statusCode, 401)
    assert.equal((await f.call({ method: "GET", url: `${url}/${legacy}/content`, token: "visitor" })).statusCode, 403)
    assert.equal((await f.call({ method: "GET", url: `${url}/${legacy}/content`, token: "other", tenant: f.otherTenant })).statusCode, 404)
    assert.equal((await f.call({ method: "GET", url: `${url}/${foreignFile}/content` })).statusCode, 404)
    assert.equal((await f.call({ method: "GET", url: `${url}/${systemFile}/content` })).statusCode, 404)

    // arquivar
    const archive = `${url}/${systemFile}/archive`
    assert.equal((await f.call({ method: "POST", url: archive, token: null, headers: { "if-match": '"1"' } })).statusCode, 401)
    assert.equal((await f.call({ method: "POST", url: archive })).statusCode, 428)
    assert.equal((await f.call({ method: "POST", url: archive, token: "reader", headers: { "if-match": '"1"' } })).statusCode, 403)
    assert.equal((await f.call({ method: "POST", url: archive, token: "other", tenant: f.otherTenant, headers: { "if-match": '"1"' } })).statusCode, 404)
    assert.equal((await f.call({ method: "POST", url: archive, headers: { "if-match": '"5"' } })).statusCode, 412)
    const done = await f.call({ method: "POST", url: archive, headers: { "if-match": '"1"' } })
    assert.equal(done.statusCode, 200)
    assert.equal(json(done).data.status, "archived")
    assert.equal(etag(done), '"2"')
    assert.equal((await f.call({ method: "POST", url: archive, headers: { "if-match": '"2"' } })).statusCode, 409)
    assert.equal((await f.call({ method: "POST", url: `${url}/${randomUUID()}/archive`, headers: { "if-match": '"1"' } })).statusCode, 404)
    const audit = await f.seed.query("SELECT action FROM audit_log WHERE entity_type='system_file'")
    assert.deepEqual(audit.rows.map(r => r.action), ["system.file.archived"])
  } finally { await f.close() }
})
