import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { createTestContext, databaseTestOptions, type TestContext } from "./support/test-context.js"
import { actorHeader, fakeEngine, seedCteDocument } from "./fiscal-cte-support.js"
import { CTE_COMPANY, cteFixture } from "./fixtures/fiscal/cte.js"

const base = "/api/v1/fiscal/cte-distribution/documents/"
const perms = ["fiscal.cte.read", "fiscal.cte.inspect", "fiscal.cte.link", "catalog.parties.read", "purchasing.orders.read", "sales.orders.read"]

async function setup(permissions = perms) {
  const cte = cteFixture()
  const engine = fakeEngine(() => cte.inspection as unknown as Record<string, unknown>)
  const ctx = await createTestContext({ permissions, dependencies: { fiscalOperations: engine.operations } })
  const id = await seedCteDocument(ctx, cte.xml)
  return { ctx, engine, cte, id }
}
let counter = 0
function cpf() {
  const digits = String(100000000 + ++counter).split("").map(Number)
  for (const end of [9, 10]) { const sum = digits.slice(0, end).reduce((t, d, i) => t + d * (end + 1 - i), 0), r = sum % 11; digits.push(r < 2 ? 0 : 11 - r) }
  return digits.join("")
}
async function seedOrder(ctx: TestContext, kind: "purchase" | "sale", { tenant = ctx.tenant, amount = 100000, status = "confirmed" } = {}) {
  const id = randomUUID(), party = randomUUID()
  await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,status,is_customer,is_supplier) VALUES($1,$2,'fisica','Contraparte',$3,'active',true,true)", [party, tenant, cpf()])
  if (kind === "purchase") await ctx.seed.query("INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Fornecedor','52998224725','2026-12-01',$4,$5)", [id, tenant, party, amount, status])
  else await ctx.seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','52998224725','2026-12-01',$4,$5)", [id, tenant, party, amount, status])
  return id
}
async function seedCarrier(ctx: TestContext) {
  await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,status,is_customer,is_supplier) VALUES($1,$2,'juridica','Transportadora Cadastrada','11222333000181','active',false,true)", [randomUUID(), ctx.tenant])
  return (await ctx.seed.query("SELECT id FROM parties WHERE tenant_id=$1 AND tax_id='11222333000181'", [ctx.tenant])).rows[0].id as string
}

test("GET /api/v1/fiscal/cte-distribution/documents/{id}/inspection + POST /api/v1/fiscal/cte-distribution/documents/{id}/inspect [sucesso] confere uma vez, repete pela chave e reaproveita o resultado", databaseTestOptions, async () => {
  const { ctx, engine, id, cte } = await setup()
  try {
    const user = ctx.as("user")
    const before = await user.get(base + id + "/inspection")
    assert.equal(before.statusCode, 200, before.body); assert.equal(before.json().data, null); assert.equal(before.json().canInspect, true)
    const key = randomUUID()
    const created = await user.post(base + id + "/inspect", { body: {}, idempotencyKey: key })
    assert.equal(created.statusCode, 201, created.body)
    assert.equal(created.json().data.document.accessKey, cte.accessKey); assert.equal(created.json().data.document.xml, undefined)
    assert.equal(created.json().data.inspectorVersion, "cte-received-v1")
    assert.deepEqual(engine.calls[0]!.input, { xml: cte.xml, companyTaxId: CTE_COMPANY, environment: "homologation" })
    const replay = await user.post(base + id + "/inspect", { body: {}, idempotencyKey: key })
    assert.equal(replay.statusCode, 200); assert.deepEqual(replay.json(), created.json()); assert.equal(engine.calls.length, 1)
    const again = await user.post(base + id + "/inspect", { body: {} })
    assert.equal(again.statusCode, 200); assert.equal(again.json().data.id, created.json().data.id); assert.equal(engine.calls.length, 1)
    assert.equal((await user.post(base + id + "/inspect", { body: {}, idempotencyKey: key })).statusCode, 200)
    assert.equal((await user.get(base + id + "/inspection")).json().data.id, created.json().data.id)
    const audit = await ctx.seed.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_type='fiscal_cte_inspection'")
    assert.equal(audit.rows[0].n, 1)
  } finally { await ctx.close() }
})

test("POST /api/v1/fiscal/cte-distribution/documents/{id}/inspect [sucesso] recusa XML inválido, perfil fora do suportado, resultado adulterado e motor fora do ar", databaseTestOptions, async () => {
  const cte = cteFixture()
  let reply: () => Record<string, unknown> = () => ({ status: "blocked", blockers: ["invalid_cte_xml"] })
  const engine = fakeEngine(() => reply())
  const ctx = await createTestContext({ permissions: perms, dependencies: { fiscalOperations: engine.operations } })
  try {
    const id = await seedCteDocument(ctx, cte.xml), user = ctx.as("user")
    assert.equal((await user.post(base + id + "/inspect", { body: { x: 1 } })).statusCode, 422)
    assert.equal((await user.post(base + id + "/inspect", { body: {}, idempotencyKey: "x" })).statusCode, 422)
    const invalid = await user.post(base + id + "/inspect", { body: {} })
    assert.equal(invalid.statusCode, 422); assert.match(invalid.json().type, /invalid_cte_xml$/)
    reply = () => ({ status: "blocked", blockers: ["cte_profile_unsupported"] })
    assert.match((await user.post(base + id + "/inspect", { body: {} })).json().type, /cte_profile_unsupported$/)
    reply = () => ({ status: "blocked", blockers: ["cte_layout_unavailable"] })
    assert.equal((await user.post(base + id + "/inspect", { body: {} })).statusCode, 502)
    reply = () => ({ ...cte.inspection, serviceCents: "1" })
    assert.equal((await user.post(base + id + "/inspect", { body: {} })).statusCode, 502)
    reply = () => { throw new Error("fora do ar") }
    assert.equal((await user.post(base + id + "/inspect", { body: {} })).statusCode, 502)
    assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM fiscal_cte_inspections")).rows[0].n, 0)
    const event = await seedCteDocument(ctx, "<x/>", { nsu: "000000000000002", schema: "procEventoCTe_v4.00.xsd", kind: "event" })
    assert.equal((await user.post(base + event + "/inspect", { body: {} })).statusCode, 422)
    assert.equal((await user.get(base + event + "/inspection")).json().canInspect, false)
    // CNPJ da empresa mudou depois da coleta.
    await ctx.seed.query("UPDATE tenants SET tax_id='19131243000197' WHERE id=$1", [ctx.tenant])
    assert.equal((await user.post(base + id + "/inspect", { body: {} })).statusCode, 409)
  } finally { await ctx.close() }
})

test("GET /api/v1/fiscal/cte-distribution/documents/{id}/inspection + POST /api/v1/fiscal/cte-distribution/documents/{id}/inspect [negado] sem token, sem permissão, sem conferência e de outra empresa", databaseTestOptions, async () => {
  const { ctx, engine, id } = await setup(["fiscal.cte.read"])
  try {
    assert.equal((await ctx.as("anonymous").get(base + id + "/inspection")).statusCode, 401)
    assert.equal((await ctx.as("anonymous").post(base + id + "/inspect", { body: {} })).statusCode, 401)
    assert.equal((await ctx.as("denied").get(base + id + "/inspection")).statusCode, 403)
    assert.equal((await ctx.as("denied").post(base + id + "/inspect", { body: {} })).statusCode, 403)
    assert.equal((await ctx.as("user").post(base + id + "/inspect", { body: {} })).statusCode, 403)
    const view = await ctx.as("user").get(base + id + "/inspection")
    assert.equal(view.statusCode, 200); assert.equal(view.json().canInspect, false)
    assert.equal((await ctx.as("outsider").get(base + id + "/inspection", { tenant: ctx.otherTenant })).statusCode, 404)
    assert.equal((await ctx.as("outsider").post(base + id + "/inspect", { body: {}, tenant: ctx.otherTenant })).statusCode, 404)
    assert.equal(engine.calls.length, 0)
  } finally { await ctx.close() }
})

test("GET /api/v1/fiscal/cte-distribution/documents/{id}/commercial-links + GET /api/v1/fiscal/cte-distribution/documents/{id}/commercial-options + POST /api/v1/fiscal/cte-distribution/documents/{id}/commercial-links + POST /api/v1/fiscal/cte-distribution/documents/{id}/commercial-links/{linkId}/unlink [sucesso] vincula frete, respeita o total e desfaz preservando histórico", databaseTestOptions, async () => {
  const { ctx, id } = await setup()
  try {
    const user = ctx.as("user"), actor = actorHeader("user"), carrier = await seedCarrier(ctx)
    const notYet = await user.get(base + id + "/commercial-links")
    assert.equal(notYet.statusCode, 409, "exige conferência antes")
    assert.equal((await user.post(base + id + "/inspect", { body: {} })).statusCode, 201)
    const view = await user.get(base + id + "/commercial-links")
    assert.equal(view.statusCode, 200, view.body)
    assert.equal(view.headers.etag, '"1"'); assert.equal(view.json().serviceCents, "15001"); assert.equal(view.json().allocatedCents, "0")
    assert.equal(view.json().carrier.partyId, carrier); assert.equal(view.json().carrier.available, true); assert.equal(view.json().canLinkPurchase, true)

    const purchase = await seedOrder(ctx, "purchase"), sale = await seedOrder(ctx, "sale"), draft = await seedOrder(ctx, "sale", { status: "draft" })
    const options = await user.get(base + id + "/commercial-options", { query: { kind: "purchase" } })
    assert.equal(options.statusCode, 200, options.body); assert.equal(options.json().total, 1); assert.equal(options.json().data[0].id, purchase)
    assert.equal((await user.get(base + id + "/commercial-options", { query: { kind: "sale" } })).json().data.find((o: { id: string }) => o.id === draft), undefined)
    assert.equal((await user.get(base + id + "/commercial-options", { query: { kind: "x" } })).statusCode, 422)
    assert.equal((await user.get(base + id + "/commercial-options", { query: { kind: "sale", limit: 99 } })).statusCode, 422)

    const body = (orderId: string, kind = "purchase", freightCents = "10000") => ({ kind, orderId, carrierPartyId: carrier, freightCents, reason: "Conferido com o conhecimento" })
    const key = randomUUID()
    const linked = await user.post(base + id + "/commercial-links", { body: body(purchase), revision: 1, idempotencyKey: key, headers: actor })
    assert.equal(linked.statusCode, 201, linked.body)
    assert.equal(linked.json().revision, 2); assert.equal(linked.json().allocatedCents, "10000"); assert.equal(linked.json().data[0].orderId, purchase); assert.equal(linked.json().data[0].canUnlink, true)
    const replay = await user.post(base + id + "/commercial-links", { body: body(purchase), revision: 1, idempotencyKey: key, headers: actor })
    assert.equal(replay.statusCode, 200); assert.equal(replay.json().data.length, 1)
    assert.equal((await user.post(base + id + "/commercial-links", { body: body(purchase), revision: 2, headers: actor })).statusCode, 409, "pedido já vinculado")
    assert.equal((await user.post(base + id + "/commercial-links", { body: body(sale, "sale", "5002"), revision: 2, headers: actor })).statusCode, 409, "acima do valor do CT-e")
    const second = await user.post(base + id + "/commercial-links", { body: body(sale, "sale", "5001"), revision: 2, headers: actor })
    assert.equal(second.statusCode, 201, second.body); assert.equal(second.json().allocatedCents, "15001")

    const linkId = linked.json().data[0].id, ukey = randomUUID()
    const unlink = await user.post(base + id + "/commercial-links/" + linkId + "/unlink", { body: { reason: "Pedido errado" }, revision: 3, idempotencyKey: ukey, headers: actor })
    assert.equal(unlink.statusCode, 200, unlink.body); assert.equal(unlink.json().revision, 4); assert.equal(unlink.json().data.length, 1)
    assert.equal((await user.post(base + id + "/commercial-links/" + linkId + "/unlink", { body: { reason: "Pedido errado" }, revision: 3, idempotencyKey: ukey, headers: actor })).statusCode, 200)
    assert.equal((await user.post(base + id + "/commercial-links/" + linkId + "/unlink", { body: { reason: "Outra vez" }, revision: 4, headers: actor })).statusCode, 409, "já desfeito")
    assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM fiscal_cte_commercial_links")).rows[0].n, 2)
    const events = await ctx.seed.query("SELECT action FROM audit_log WHERE entity_type='fiscal_cte_commercial_link' ORDER BY id")
    assert.deepEqual(events.rows.map(r => r.action).sort(), ["fiscal.cte.linked", "fiscal.cte.linked", "fiscal.cte.unlinked"])
  } finally { await ctx.close() }
})

test("POST /api/v1/fiscal/cte-distribution/documents/{id}/commercial-links + POST /api/v1/fiscal/cte-distribution/documents/{id}/commercial-links/{linkId}/unlink [sucesso] valida entrada, revisão, ator e transportadora", databaseTestOptions, async () => {
  const { ctx, id } = await setup()
  try {
    const user = ctx.as("user"), actor = actorHeader("user"), carrier = await seedCarrier(ctx)
    await user.post(base + id + "/inspect", { body: {} })
    const order = await seedOrder(ctx, "purchase"), ok = { kind: "purchase", orderId: order, carrierPartyId: carrier, freightCents: "100", reason: "Conferido" }
    const post = (body: unknown, init: Record<string, unknown> = { revision: 1 }) => user.post(base + id + "/commercial-links", { body, headers: actor, ...init })
    assert.equal((await post({ ...ok, freightCents: "01" })).statusCode, 422)
    assert.equal((await post({ ...ok, freightCents: "-1" })).statusCode, 422)
    assert.equal((await post({ ...ok, reason: "ab" })).statusCode, 422)
    assert.equal((await post({ ...ok, extra: 1 })).statusCode, 422)
    assert.equal((await post({ ...ok, kind: "x" })).statusCode, 422)
    assert.equal((await post(ok, {})).statusCode, 428)
    assert.equal((await post(ok, { revision: 9 })).statusCode, 412)
    assert.equal((await user.post(base + id + "/commercial-links", { body: ok, revision: 1 })).statusCode, 409, "sem X-Actor-Subject")
    assert.equal((await user.post(base + id + "/commercial-links", { body: ok, revision: 1, headers: actorHeader("outro") })).statusCode, 409)
    assert.equal((await post({ ...ok, carrierPartyId: randomUUID() })).statusCode, 409, "transportadora diferente")
    assert.equal((await post({ ...ok, orderId: randomUUID() })).statusCode, 404)
    assert.equal((await post({ ...ok, orderId: await seedOrder(ctx, "purchase", { status: "draft" }) })).statusCode, 409)
    assert.equal((await user.post(base + id + "/commercial-links/" + randomUUID() + "/unlink", { body: { reason: "Motivo" }, revision: 1, headers: actor })).statusCode, 404)
    assert.equal((await post(ok)).statusCode, 201)
    const linkId = (await ctx.seed.query("SELECT id FROM fiscal_cte_commercial_links")).rows[0].id
    assert.equal((await user.post(base + id + "/commercial-links/" + linkId + "/unlink", { body: { reason: "x" }, revision: 2, headers: actor })).statusCode, 422)
    assert.equal((await user.post(base + id + "/commercial-links/" + linkId + "/unlink", { body: { reason: "Motivo" }, revision: 1, headers: actor })).statusCode, 412)
  } finally { await ctx.close() }
})

test("GET /api/v1/fiscal/cte-distribution/documents/{id}/commercial-links + GET /api/v1/fiscal/cte-distribution/documents/{id}/commercial-options + POST /api/v1/fiscal/cte-distribution/documents/{id}/commercial-links + POST /api/v1/fiscal/cte-distribution/documents/{id}/commercial-links/{linkId}/unlink [negado] sem token, sem permissão, sem pedidos e de outra empresa", databaseTestOptions, async () => {
  const { ctx, id } = await setup(["fiscal.cte.read", "fiscal.cte.inspect", "fiscal.cte.link", "catalog.parties.read", "purchasing.orders.read"])
  try {
    const user = ctx.as("user"), actor = actorHeader("user"), carrier = await seedCarrier(ctx)
    await user.post(base + id + "/inspect", { body: {} })
    const order = await seedOrder(ctx, "purchase"), sale = await seedOrder(ctx, "sale")
    const ok = { kind: "purchase", orderId: order, carrierPartyId: carrier, freightCents: "100", reason: "Conferido" }
    const urls = [base + id + "/commercial-links", base + id + "/commercial-options?kind=purchase"]
    for (const url of urls) {
      assert.equal((await ctx.as("anonymous").get(url)).statusCode, 401)
      assert.equal((await ctx.as("denied").get(url)).statusCode, 403)
      assert.equal((await ctx.as("outsider").get(url, { tenant: ctx.otherTenant })).statusCode, 404)
    }
    assert.equal((await ctx.as("anonymous").post(base + id + "/commercial-links", { body: ok, revision: 1 })).statusCode, 401)
    assert.equal((await ctx.as("denied").post(base + id + "/commercial-links", { body: ok, revision: 1, headers: actorHeader("denied") })).statusCode, 403)
    assert.equal((await ctx.as("outsider").post(base + id + "/commercial-links", { body: ok, revision: 1, tenant: ctx.otherTenant, headers: actorHeader("outsider") })).statusCode, 404)
    // Sem sales.orders.read: não lista nem vincula vendas, e a compra continua permitida.
    assert.equal((await user.get(base + id + "/commercial-options", { query: { kind: "sale" } })).statusCode, 403)
    assert.equal((await user.post(base + id + "/commercial-links", { body: { ...ok, kind: "sale", orderId: sale }, revision: 1, headers: actor })).statusCode, 403)
    const linked = await user.post(base + id + "/commercial-links", { body: ok, revision: 1, headers: actor })
    assert.equal(linked.statusCode, 201, linked.body)
    // Pedido de outra empresa não pode ser vinculado a este CT-e.
    const foreign = await seedOrder(ctx, "purchase", { tenant: ctx.otherTenant })
    assert.equal((await user.post(base + id + "/commercial-links", { body: { ...ok, orderId: foreign }, revision: 2, headers: actor })).statusCode, 404)
    // Um leitor sem permissão de vínculo vê o vínculo, mas não desfaz.
    await ctx.seed.query("DELETE FROM role_permissions WHERE permission_code='fiscal.cte.link' AND role_id IN (SELECT id FROM roles WHERE tenant_id=$1 AND code='user')", [ctx.tenant])
    const linkId = linked.json().data[0].id
    assert.equal((await user.post(base + id + "/commercial-links/" + linkId + "/unlink", { body: { reason: "Motivo" }, revision: 2, headers: actor })).statusCode, 403)
    assert.equal((await user.get(base + id + "/commercial-links")).json().data[0].canUnlink, false)
  } finally { await ctx.close() }
})
