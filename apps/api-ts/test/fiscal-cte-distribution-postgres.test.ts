import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { createTestContext, databaseTestOptions } from "./support/test-context.js"
import { fakeEngine, seedCteDocument } from "./fiscal-cte-support.js"
import { cteEventXml, cteFixture } from "./fixtures/fiscal/cte.js"

const base = "/api/v1/fiscal/cte-distribution"
const nsu = (n: number) => String(n).padStart(15, "0")
const all = ["fiscal.cte.read", "fiscal.cte.query"]

async function contextWith(respond: Parameters<typeof fakeEngine>[0], permissions = all) {
  const engine = fakeEngine(respond)
  const ctx = await createTestContext({ permissions, dependencies: { fiscalOperations: engine.operations } })
  await ctx.seed.query("INSERT INTO company_profiles(tenant_id,revision,details) VALUES($1,1,$2)", [ctx.tenant, { state: "SP" }])
  return { ctx, engine }
}

test("GET /api/v1/fiscal/cte-distribution/status + POST /api/v1/fiscal/cte-distribution/query + GET /api/v1/fiscal/cte-distribution/runs/{id} + GET /api/v1/fiscal/cte-distribution/documents + GET /api/v1/fiscal/cte-distribution/documents/{id} [sucesso] grava o lote, avança o NSU e repete pela Idempotency-Key", databaseTestOptions, async () => {
  const cte = cteFixture()
  const { ctx, engine } = await contextWith(() => ({ code: "138", lastNsu: nsu(2), maxNsu: nsu(5), nextNsu: nsu(2), documents: [
    { nsu: nsu(1), schema: "procCTe_v4.00.xsd", kind: "full", xml: cte.xml }, { nsu: nsu(2), schema: "procEventoCTe_v4.00.xsd", kind: "event", xml: cteEventXml }] }))
  try {
    const user = ctx.as("user")
    const status = await user.get(base + "/status")
    assert.equal(status.statusCode, 200, status.body)
    assert.equal(status.headers.etag, '"1"')
    assert.deepEqual({ ...(status.json() as object), tenantId: undefined }, { tenantId: undefined, companyTaxId: null, lastNsu: nsu(0), maxNsu: nsu(0), revision: 1, nextQueryAt: null, lastCode: null, running: false, environment: "homologation", canQuery: true })

    const key = randomUUID()
    const run = await user.post(base + "/query", { body: {}, revision: 1, idempotencyKey: key })
    assert.equal(run.statusCode, 200, run.body)
    const result = run.json()
    assert.equal(result.status, "completed"); assert.equal(result.documentCount, 2); assert.equal(result.lastNsu, nsu(2)); assert.equal(result.maxNsu, nsu(5))
    assert.equal(result.lastCode, "138"); assert.equal(result.revision, 3); assert.equal(run.headers.etag, '"3"')
    // O motor recebeu o cursor e o certificado; o certificado nunca volta na resposta nem no resultado gravado.
    assert.equal(engine.calls.length, 1)
    assert.deepEqual({ ...engine.calls[0]!.input, certificate: undefined }, { issuerTaxId: "04252011000110", certificate: undefined, environment: "homologation", authorState: "SP", lastNsu: nsu(0) })
    assert.ok(!run.body.includes("senha-ficticia"))

    const replay = await user.post(base + "/query", { body: {}, revision: 1, idempotencyKey: key })
    assert.equal(replay.statusCode, 200); assert.deepEqual(replay.json(), result); assert.equal(engine.calls.length, 1)

    const stored = await user.get(base + "/runs/" + result.runId)
    assert.equal(stored.statusCode, 200, stored.body)
    assert.equal(stored.json().status, "completed"); assert.equal(stored.json().requestedNsu, nsu(0)); assert.equal(stored.json().documentCount, 2)
    assert.deepEqual(stored.json().result, result)

    const list = await user.get(base + "/documents", { query: { limit: 1 } })
    assert.equal(list.statusCode, 200, list.body)
    assert.equal(list.json().total, 2); assert.equal(list.json().data.length, 1); assert.equal(list.json().environment, "homologation")
    assert.equal(list.json().data[0].xml, undefined)
    const full = (await user.get(base + "/documents", { query: { limit: 100 } })).json().data.find((d: { nsu: string }) => d.nsu === nsu(1))
    const detail = await user.get(base + "/documents/" + full.id)
    assert.equal(detail.statusCode, 200); assert.equal(detail.json().xml, cte.xml); assert.equal(detail.json().kind, "full"); assert.equal(detail.json().verification, "pending")

    const audit = await ctx.seed.query("SELECT action FROM audit_log WHERE tenant_id=$1 AND entity_type='fiscal_cte_distribution' ORDER BY id", [ctx.tenant])
    assert.deepEqual(audit.rows.map(row => row.action), ["fiscal.cte.distribution.requested", "fiscal.cte.distribution.finished"])
  } finally { await ctx.close() }
})

test("POST /api/v1/fiscal/cte-distribution/query [sucesso] valida entrada, If-Match, intervalo obrigatório e falha incerta do motor", databaseTestOptions, async () => {
  let reply: () => Record<string, unknown> = () => ({ code: "137", lastNsu: nsu(0), maxNsu: nsu(0), nextNsu: nsu(0), documents: [] })
  const { ctx, engine } = await contextWith(() => reply())
  try {
    const user = ctx.as("user")
    assert.equal((await user.post(base + "/query", { body: { lastNsu: "1" }, revision: 1 })).statusCode, 422)
    assert.equal((await user.post(base + "/query", { body: {} })).statusCode, 428)
    const noKey = await ctx.app.inject({ method: "POST", url: base + "/query", headers: { authorization: "Bearer user", "x-tenant-id": ctx.tenant, "if-match": '"1"' }, payload: {} })
    assert.equal(noKey.statusCode, 428)
    assert.equal((await user.post(base + "/query", { body: {}, idempotencyKey: "nao-uuid", revision: 1 })).statusCode, 422)
    assert.equal((await user.post(base + "/query", { body: {}, revision: 7 })).statusCode, 412)
    assert.equal(engine.calls.length, 0)

    const empty = await user.post(base + "/query", { body: {}, revision: 1 })
    assert.equal(empty.statusCode, 200, empty.body); assert.equal(empty.json().status, "completed"); assert.equal(empty.json().lastCode, "137")
    // 137: aguarda uma hora antes da próxima consulta.
    const cooling = await user.post(base + "/query", { body: {}, revision: empty.json().revision })
    assert.equal(cooling.statusCode, 409, cooling.body)
    assert.equal((await user.post(base + "/query", { body: {}, revision: 1 })).statusCode, 412)

    // Falha de transporte: estado incerto, cursor preservado e concessão liberada.
    await ctx.seed.query("UPDATE fiscal_cte_distribution_state SET next_query_at=NULL WHERE tenant_id=$1", [ctx.tenant])
    reply = () => { throw new Error("sem resposta") }
    const uncertain = await user.post(base + "/query", { body: {}, revision: empty.json().revision })
    assert.equal(uncertain.statusCode, 200, uncertain.body)
    assert.equal(uncertain.json().status, "unknown"); assert.equal(uncertain.json().lastNsu, nsu(0)); assert.equal(uncertain.json().running, false)
    assert.equal(uncertain.json().lastCode, "transport_uncertain")

    // Lote fora da ordem do cursor é recusado sem gravar documentos.
    await ctx.seed.query("UPDATE fiscal_cte_distribution_state SET next_query_at=NULL WHERE tenant_id=$1", [ctx.tenant])
    reply = () => ({ code: "138", lastNsu: nsu(1), maxNsu: nsu(1), nextNsu: nsu(1), documents: [{ nsu: nsu(3), schema: "procCTe_v4.00.xsd", kind: "full", xml: cteFixture().xml }] })
    const invalid = await user.post(base + "/query", { body: {}, revision: uncertain.json().revision })
    assert.equal(invalid.json().status, "failed"); assert.equal(invalid.json().lastCode, "invalid_batch"); assert.equal(invalid.json().lastNsu, nsu(0))
    assert.equal((await user.get(base + "/documents")).json().total, 0)

    // NSU já gravado com outro conteúdo: falha de persistência, cursor não avança.
    await seedCteDocument(ctx, cteFixture({ number: "999" }).xml, { nsu: nsu(1) })
    await ctx.seed.query("UPDATE fiscal_cte_distribution_state SET next_query_at=NULL WHERE tenant_id=$1", [ctx.tenant])
    reply = () => ({ code: "138", lastNsu: nsu(1), maxNsu: nsu(1), nextNsu: nsu(1), documents: [{ nsu: nsu(1), schema: "procCTe_v4.00.xsd", kind: "full", xml: cteFixture().xml }] })
    const clash = await user.post(base + "/query", { body: {}, revision: invalid.json().revision })
    assert.equal(clash.json().status, "failed"); assert.equal(clash.json().lastCode, "persistence_failed"); assert.equal(clash.json().lastNsu, nsu(0))

    // Empresa sem UF não consulta.
    await ctx.seed.query("UPDATE company_profiles SET details='{}' WHERE tenant_id=$1", [ctx.tenant])
    await ctx.seed.query("UPDATE fiscal_cte_distribution_state SET next_query_at=NULL WHERE tenant_id=$1", [ctx.tenant])
    assert.equal((await user.post(base + "/query", { body: {}, revision: clash.json().revision })).statusCode, 409)
  } finally { await ctx.close() }
})

test("GET /api/v1/fiscal/cte-distribution/status + POST /api/v1/fiscal/cte-distribution/query + GET /api/v1/fiscal/cte-distribution/runs/{id} + GET /api/v1/fiscal/cte-distribution/documents + GET /api/v1/fiscal/cte-distribution/documents/{id} [negado] sem token, sem permissão, só leitura e de outra empresa", databaseTestOptions, async () => {
  const { ctx, engine } = await contextWith(() => ({ code: "137", lastNsu: nsu(0), maxNsu: nsu(0), nextNsu: nsu(0), documents: [] }), ["fiscal.cte.read"])
  try {
    const id = await seedCteDocument(ctx, cteFixture().xml)
    const runId = (await ctx.seed.query("SELECT run_id FROM fiscal_cte_distribution_documents WHERE id=$1", [id])).rows[0].run_id
    const reads = [base + "/status", base + "/documents", base + "/documents/" + id, base + "/runs/" + runId]
    for (const url of reads) {
      assert.equal((await ctx.as("anonymous").get(url)).statusCode, 401, url)
      assert.equal((await ctx.as("denied").get(url)).statusCode, 403, url)
      assert.equal((await ctx.as("outsider").get(url)).statusCode, 403, url)
      assert.equal((await ctx.as("user").get(url)).statusCode, 200, url)
    }
    assert.equal((await ctx.as("user").get(base + "/status")).json().canQuery, false)
    assert.equal((await ctx.as("user").post(base + "/query", { body: {}, revision: 1 })).statusCode, 403)
    assert.equal((await ctx.as("anonymous").post(base + "/query", { body: {}, revision: 1 })).statusCode, 401)
    assert.equal(engine.calls.length, 0)
    // Isolamento: a outra empresa (com todas as permissões) não enxerga os documentos desta.
    const outsider = ctx.as("outsider")
    assert.equal((await outsider.get(base + "/documents", { tenant: ctx.otherTenant })).json().total, 0)
    assert.equal((await outsider.get(base + "/documents/" + id, { tenant: ctx.otherTenant })).statusCode, 404)
    assert.equal((await outsider.get(base + "/runs/" + runId, { tenant: ctx.otherTenant })).statusCode, 404)
    assert.equal((await ctx.as("user").get(base + "/documents/nao-uuid")).statusCode, 422)
    assert.equal((await ctx.as("user").get(base + "/documents", { query: { limit: 0 } })).statusCode, 422)
    assert.equal((await ctx.as("user").get(base + "/runs/" + randomUUID())).statusCode, 404)
  } finally { await ctx.close() }
})
