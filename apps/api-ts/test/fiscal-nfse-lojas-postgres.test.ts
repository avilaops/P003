import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import test from "node:test"
import { createTestContext, databaseTestOptions, type TestContext } from "./support/test-context.js"
import { fakeEngine } from "./fiscal-cte-support.js"
import { nfseFixture } from "./fixtures/fiscal/nfse.js"

const base = "/api/v1/fiscal/received-nfses"
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")

async function nfseContext(respond: Parameters<typeof fakeEngine>[0], permissions = ["fiscal.nfse.read", "fiscal.nfse.import"]) {
  const engine = fakeEngine(respond)
  return { engine, ctx: await createTestContext({ permissions, dependencies: { fiscalOperations: engine.operations } }) }
}

test("GET /api/v1/fiscal/received-nfses + POST /api/v1/fiscal/received-nfses/import + GET /api/v1/fiscal/received-nfses/{id} + GET /api/v1/fiscal/received-nfses/{id}/xml [sucesso] importa, repete pela chave e devolve o XML original", databaseTestOptions, async () => {
  const note = nfseFixture()
  const { ctx, engine } = await nfseContext(() => note.inspection as unknown as Record<string, unknown>)
  try {
    const user = ctx.as("user"), key = randomUUID()
    const empty = await user.get(base)
    assert.equal(empty.statusCode, 200); assert.equal(empty.json().total, 0); assert.equal(empty.json().canImport, true)
    const created = await user.post(base + "/import", { body: { xml: note.xml }, idempotencyKey: key })
    assert.equal(created.statusCode, 201, created.body)
    assert.equal(created.json().data.document.accessKey, note.accessKey); assert.equal(created.json().data.companyTaxId, "04252011000110")
    assert.equal(created.json().data.document.xml, undefined)
    assert.deepEqual(engine.calls[0]!.input, { xml: note.xml, recipientTaxId: "04252011000110" })
    const replay = await user.post(base + "/import", { body: { xml: note.xml }, idempotencyKey: key })
    assert.equal(replay.statusCode, 200); assert.deepEqual(replay.json(), created.json()); assert.equal(engine.calls.length, 1)
    // Mesma NFS-e com outra chave de comando: devolve a existente, sem duplicar.
    const same = await user.post(base + "/import", { body: { xml: note.xml } })
    assert.equal(same.statusCode, 200); assert.equal(same.json().data.id, created.json().data.id)
    const id = created.json().data.id
    assert.equal((await user.get(base)).json().total, 1)
    assert.equal((await user.get(base, { query: { limit: 1, offset: 1 } })).json().data.length, 0)
    assert.equal((await user.get(base + "/" + id)).json().data.id, id)
    const xml = await user.get(base + "/" + id + "/xml")
    assert.equal(xml.statusCode, 200); assert.equal(xml.body, note.xml)
    assert.match(String(xml.headers["content-type"]), /^application\/xml/); assert.equal(xml.headers["x-xml-sha256"], sha(note.xml))
    assert.equal(xml.headers["content-disposition"], `attachment; filename="NFSE-${note.accessKey}.xml"`); assert.equal(xml.headers["x-content-type-options"], "nosniff")
    assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_type='fiscal_received_nfse'")).rows[0].n, 1)
  } finally { await ctx.close() }
})

test("POST /api/v1/fiscal/received-nfses/import [sucesso] valida entrada, recusa resultado inconsistente e preserva o XML original em conflito", databaseTestOptions, async () => {
  const note = nfseFixture()
  let reply: () => Record<string, unknown> = () => note.inspection as unknown as Record<string, unknown>
  const { ctx, engine } = await nfseContext(() => reply())
  try {
    const user = ctx.as("user")
    assert.equal((await user.post(base + "/import", { body: {} })).statusCode, 422)
    assert.equal((await user.post(base + "/import", { body: { xml: "" } })).statusCode, 422)
    assert.equal((await user.post(base + "/import", { body: { xml: note.xml, extra: 1 } })).statusCode, 422)
    assert.equal((await user.post(base + "/import", { body: { xml: "x".repeat(1_048_577) } })).statusCode, 422)
    assert.equal((await user.post(base + "/import", { body: { xml: note.xml }, idempotencyKey: "x" })).statusCode, 422)
    assert.equal(engine.calls.length, 0)
    reply = () => ({ status: "blocked", blockers: ["invalid_nfse_xml"] })
    const invalid = await user.post(base + "/import", { body: { xml: note.xml } })
    assert.equal(invalid.statusCode, 422); assert.match(invalid.json().type, /invalid_nfse_xml$/)
    reply = () => ({ status: "blocked", blockers: ["nfse_layout_unavailable"] })
    assert.equal((await user.post(base + "/import", { body: { xml: note.xml } })).statusCode, 502)
    reply = () => ({ ...note.inspection, netCents: "1" })
    assert.equal((await user.post(base + "/import", { body: { xml: note.xml } })).statusCode, 502)
    reply = () => ({ ...note.inspection, recipient: { ...note.inspection.recipient, value: "19131243000197" } })
    assert.equal((await user.post(base + "/import", { body: { xml: note.xml } })).statusCode, 502)
    reply = () => { throw new Error("fora do ar") }
    assert.equal((await user.post(base + "/import", { body: { xml: note.xml } })).statusCode, 502)
    assert.equal((await user.get(base)).json().total, 0)
    // Mesma chave nacional com outro conteúdo: conflito, e o primeiro arquivo permanece.
    reply = () => note.inspection as unknown as Record<string, unknown>
    assert.equal((await user.post(base + "/import", { body: { xml: note.xml } })).statusCode, 201)
    const altered = note.xml.replace("</NFSe>", "<!-- outro --></NFSe>")
    reply = () => ({ ...note.inspection, xml: altered, xmlSha256: sha(altered) })
    assert.equal((await user.post(base + "/import", { body: { xml: altered } })).statusCode, 409)
    assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM fiscal_received_nfses")).rows[0].n, 1)
    // Empresa sem CNPJ numérico válido não importa.
    await ctx.seed.query("UPDATE tenants SET tax_id='11144477735' WHERE id=$1", [ctx.tenant])
    assert.equal((await user.post(base + "/import", { body: { xml: note.xml } })).statusCode, 409)
    assert.equal((await user.get(base + "/nao-uuid")).statusCode, 422)
    assert.equal((await user.get(base + "/" + randomUUID())).statusCode, 404)
    assert.equal((await user.get(base, { query: { limit: 101 } })).statusCode, 422)
  } finally { await ctx.close() }
})

test("GET /api/v1/fiscal/received-nfses + POST /api/v1/fiscal/received-nfses/import + GET /api/v1/fiscal/received-nfses/{id} + GET /api/v1/fiscal/received-nfses/{id}/xml [negado] sem token, sem permissão, só leitura e de outra empresa", databaseTestOptions, async () => {
  const note = nfseFixture()
  const { ctx, engine } = await nfseContext(() => note.inspection as unknown as Record<string, unknown>, ["fiscal.nfse.read"])
  try {
    const id = randomUUID()
    await ctx.seed.query(`INSERT INTO fiscal_received_nfses(tenant_id,id,source,environment,access_key,company_tax_id,xml,xml_sha256,metadata,auth_subject) VALUES($1,$2,'nfse_nacional','homologation',$3,'04252011000110',$4,$5,$6,'seed')`,
      [ctx.tenant, id, note.accessKey, note.xml, note.inspection.xmlSha256, { ...note.inspection, xml: undefined }])
    for (const url of [base, base + "/" + id, base + "/" + id + "/xml"]) {
      assert.equal((await ctx.as("anonymous").get(url)).statusCode, 401, url)
      assert.equal((await ctx.as("denied").get(url)).statusCode, 403, url)
      assert.equal((await ctx.as("user").get(url)).statusCode, 200, url)
    }
    assert.equal((await ctx.as("user").get(base)).json().canImport, false)
    assert.equal((await ctx.as("anonymous").post(base + "/import", { body: { xml: note.xml } })).statusCode, 401)
    assert.equal((await ctx.as("denied").post(base + "/import", { body: { xml: note.xml } })).statusCode, 403)
    assert.equal((await ctx.as("user").post(base + "/import", { body: { xml: note.xml } })).statusCode, 403)
    assert.equal(engine.calls.length, 0)
    // Outra empresa (com todas as permissões) não enxerga nem baixa o documento desta.
    const outsider = ctx.as("outsider")
    assert.equal((await outsider.get(base, { tenant: ctx.otherTenant })).json().total, 0)
    assert.equal((await outsider.get(base + "/" + id, { tenant: ctx.otherTenant })).statusCode, 404)
    assert.equal((await outsider.get(base + "/" + id + "/xml", { tenant: ctx.otherTenant })).statusCode, 404)
    assert.equal((await outsider.get(base, { tenant: ctx.tenant })).statusCode, 403)
  } finally { await ctx.close() }
})

// ---- Lojas: autenticação por chave de integração da empresa ----
const lojas = "/api/v1/notas-recebidas"
async function lojasContext() {
  return { ctx: await createTestContext({ permissions: [] }) }
}
async function serviceKey(ctx: TestContext, tenant = ctx.tenant) {
  const id = randomUUID(), secret = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), key = `erp_${tenant}_${secret}`
  const identity = (await ctx.seed.query("SELECT id FROM identities LIMIT 1")).rows[0].id
  await ctx.seed.query("INSERT INTO service_api_keys(id,tenant_id,name,key_prefix,key_hash,created_by_identity_id) VALUES($1,$2,'Lojas',$3,$4,$5)", [id, tenant, key.slice(0, 30), createHash("sha256").update(key).digest(), identity])
  return { id, key }
}
async function seedNote(ctx: TestContext, tenant: string, accessKey: string, number = 12) {
  const xml = `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe/></nfeProc>`
  const identity = (await ctx.seed.query("SELECT id FROM identities WHERE auth_subject='user'")).rows[0].id
  return String((await ctx.seed.query(`INSERT INTO fiscal_received_nfes(tenant_id,access_key,issuer_document,issuer_name,recipient_document,number,series,issued_at,total_cents,item_count,environment,xml,xml_sha256,imported_by_identity_id)
    VALUES($1,$2,'19131243000197','Fornecedor','04252011000110',$3,1,'2026-11-18T01:00Z',1050,2,2,$4,$5,$6) RETURNING id`, [tenant, accessKey, number, xml, sha(xml), identity])).rows[0].id)
}

test("GET /api/v1/notas-recebidas + GET /api/v1/notas-recebidas/{id}/xml + GET /api/v1/notas-recebidas/{id}/danfe [sucesso] lista notas e pendências e baixa XML e DANFE com a chave da empresa", databaseTestOptions, async () => {
  const { ctx } = await lojasContext()
  try {
    const { key } = await serviceKey(ctx), headers = { authorization: "Bearer " + key, "x-tenant-id": ctx.tenant }
    const keyA = "35261019131243000197550010000000121000000010", keyPending = "35261019131243000197550010000000991000000990"
    const id = await seedNote(ctx, ctx.tenant, keyA)
    await ctx.seed.query(`INSERT INTO fiscal_monitor_runs(id,tenant_id,command_key,auth_subject,cursor_before) VALUES($1,$2,$3,'seed','000000000000000')`, [randomUUID(), ctx.tenant, randomUUID()])
    const run = (await ctx.seed.query("SELECT id FROM fiscal_monitor_runs WHERE tenant_id=$1", [ctx.tenant])).rows[0].id
    await ctx.seed.query(`INSERT INTO fiscal_monitor_documents(tenant_id,run_id,nsu,schema,kind,access_key,issuer_document,issuer_name,issued_at,total_cents,situation,xml,xml_sha256)
      VALUES($1,$2,'000000000000007','resNFe_v1.01.xsd','summary',$3,'19131243000197','Fornecedor Pendente','2026-11-18T01:00Z',5000,'1','<x/>',$4)`, [ctx.tenant, run, keyPending, sha("<x/>")])
    const list = await ctx.app.inject({ method: "GET", url: lojas, headers })
    assert.equal(list.statusCode, 200, list.body)
    assert.equal(list.json().notas.length, 1)
    assert.deepEqual(list.json().notas[0], { id: Number(id), chave: keyA, numero: 12, serie: 1, emitida_em: list.json().notas[0].emitida_em, valor: 10.5, itens: 2, compra_id: null, fornecedor: { documento: "19131243000197", nome: "Fornecedor", vinculado: false, id: null } })
    assert.equal(list.json().pendencias.length, 1); assert.equal(list.json().pendencias[0].chave, keyPending); assert.equal(list.json().pendencias[0].situacao, "Autorizada")
    assert.equal(list.headers["x-erp-backend"], "typescript")
    const xml = await ctx.app.inject({ method: "GET", url: `${lojas}/${id}/xml`, headers })
    assert.equal(xml.statusCode, 200, xml.body); assert.match(String(xml.headers["content-type"]), /^application\/xml/)
    assert.equal(xml.headers["content-disposition"], `attachment; filename="NFE-${keyA}.xml"`); assert.equal(xml.headers["x-xml-sha256"], sha(xml.body))
  } finally { await ctx.close() }
})

test("GET /api/v1/notas-recebidas/{id}/danfe [sucesso] gera o DANFE com tipo PDF e confere integridade antes", databaseTestOptions, async () => {
  const pdf = Buffer.from("%PDF-1.7\nsintetico")
  const { registerLojasNotes } = await import("../src/modules/lojas/routes.js")
  const { default: Fastify } = await import("fastify")
  const ctx = await createTestContext({ permissions: [] })
  try {
    const seen: { issuerTaxId: string; accessKey: string; environment: string }[] = []
    const app = Fastify()
    registerLojasNotes(app, { pool: { connect: () => poolConnect(ctx) }, userinfoUrl: "http://x" } as never, async input => { seen.push(input); return pdf })
    const { key } = await serviceKey(ctx), headers = { authorization: "Bearer " + key, "x-tenant-id": ctx.tenant }
    const id = await seedNote(ctx, ctx.tenant, "35261019131243000197550010000000121000000010")
    const response = await app.inject({ method: "GET", url: `${lojas}/${id}/danfe`, headers })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers["content-type"], "application/pdf"); assert.deepEqual(response.rawPayload, pdf)
    assert.equal(response.headers["x-pdf-sha256"], sha(pdf)); assert.equal(response.headers["x-nfe-environment"], "2"); assert.equal(response.headers["x-nfe-authorization-check"], "xml-protocol-only")
    assert.deepEqual(seen, [{ issuerTaxId: "19131243000197", xml: `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe/></nfeProc>`, accessKey: "35261019131243000197550010000000121000000010", environment: "homologation" }])
    // XML adulterado no banco nunca vira DANFE.
    await ctx.seed.query("ALTER TABLE fiscal_received_nfes DISABLE TRIGGER USER")
    await ctx.seed.query("UPDATE fiscal_received_nfes SET xml=xml||'<!--x-->' WHERE id=$1", [id])
    assert.equal((await app.inject({ method: "GET", url: `${lojas}/${id}/danfe`, headers })).statusCode, 409)
    assert.equal((await app.inject({ method: "GET", url: `${lojas}/${id}/xml`, headers })).statusCode, 409)
    await app.close()
  } finally { await ctx.close() }
})

async function poolConnect(ctx: TestContext) {
  const { Pool } = await import("pg")
  const { PgClientAdapter } = await import("../src/platform/database.js")
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL!); url.pathname = "/" + ctx.database
  const pool = new Pool({ connectionString: url.href, max: 1 }), client = await pool.connect()
  await client.query(`SET ROLE ${ctx.role}`)
  const adapter = new PgClientAdapter(client), release = adapter.release.bind(adapter)
  adapter.release = () => { release(); void pool.end() }
  return adapter
}

test("GET /api/v1/notas-recebidas + GET /api/v1/notas-recebidas/{id}/xml + GET /api/v1/notas-recebidas/{id}/danfe [negado] exige chave de integração válida, da mesma empresa e não revogada", databaseTestOptions, async () => {
  const { ctx } = await lojasContext()
  try {
    const { id: keyId, key } = await serviceKey(ctx), other = await serviceKey(ctx, ctx.otherTenant)
    const note = await seedNote(ctx, ctx.tenant, "35261019131243000197550010000000121000000010")
    const foreign = await seedNote(ctx, ctx.otherTenant, "35261019131243000197550010000000131000000013", 13)
    const urls = [lojas, `${lojas}/${note}/xml`, `${lojas}/${note}/danfe`]
    const call = (url: string, headers: Record<string, string>) => ctx.app.inject({ method: "GET", url, headers })
    for (const url of urls) {
      assert.equal((await call(url, { "x-tenant-id": ctx.tenant })).statusCode, 401, url + " sem credencial")
      // Token de usuário comum não vale como chave de integração.
      assert.equal((await call(url, { authorization: "Bearer user", "x-tenant-id": ctx.tenant })).statusCode, 401, url)
      assert.equal((await call(url, { authorization: "Bearer erp_" + ctx.tenant + "_" + "0".repeat(64), "x-tenant-id": ctx.tenant })).statusCode, 401, url + " chave inexistente")
      assert.equal((await call(url, { authorization: "Bearer " + key, "x-tenant-id": ctx.otherTenant })).statusCode, 403, url + " empresa divergente")
    }
    // Chave da outra empresa não enxerga as notas desta, nem o contrário.
    const mine = await call(lojas, { authorization: "Bearer " + other.key, "x-tenant-id": ctx.otherTenant })
    assert.equal(mine.statusCode, 200); assert.equal(mine.json().notas.length, 1); assert.equal(mine.json().notas[0].numero, 13)
    assert.equal((await call(`${lojas}/${note}/xml`, { authorization: "Bearer " + other.key, "x-tenant-id": ctx.otherTenant })).statusCode, 404)
    assert.equal((await call(`${lojas}/${foreign}/xml`, { authorization: "Bearer " + key, "x-tenant-id": ctx.tenant })).statusCode, 404)
    assert.equal((await call(`${lojas}/abc/xml`, { authorization: "Bearer " + key, "x-tenant-id": ctx.tenant })).statusCode, 422)
    // Escrita não existe nestas rotas.
    assert.equal((await ctx.app.inject({ method: "POST", url: lojas, headers: { authorization: "Bearer " + key, "x-tenant-id": ctx.tenant }, payload: {} })).statusCode, 404)
    // Chave revogada deixa de valer.
    await ctx.seed.query("UPDATE service_api_keys SET revoked_at=now() WHERE id=$1", [keyId])
    assert.equal((await call(lojas, { authorization: "Bearer " + key, "x-tenant-id": ctx.tenant })).statusCode, 401)
  } finally { await ctx.close() }
})
