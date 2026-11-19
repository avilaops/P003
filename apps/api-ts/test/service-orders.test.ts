import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import type { ReceivableRequest, ServicePorts } from "../src/modules/services/ports.contract.js"
import { databaseTestOptions, withTestContext, type TestContext } from "./support/test-context.js"

const permissions = ["service.orders.read", "service.orders.manage"]
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200, 1)]).toString("base64")
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 2)]).toString("base64")
async function seedBase(ctx: TestContext) {
  const customer = randomUUID(), technician = randomUUID(), product = randomUUID()
  await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente','52998224725',true,false,'active')", [customer, ctx.tenant])
  await ctx.seed.query("INSERT INTO staff(id,tenant_id,code,name,is_employee,is_seller,status) VALUES($1,$2,'TEC1','Técnico',true,false,'active')", [technician, ctx.tenant])
  await ctx.seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'PECA-1','Peça','UN',1000,'active')", [product, ctx.tenant])
  await ctx.seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,5000000)", [ctx.tenant, product])
  return { customer, technician, product }
}
const order = (customerId: string, extra: Record<string, unknown> = {}) => ({ customerId, title: "Manutenção de equipamento", serialNumber: "SER-1", checklist: [{ label: "Limpeza", required: true }, { label: "Teste final", required: true }], ...extra })
const url = "/api/v1/service-orders"

test("GET /api/v1/service-orders + POST /api/v1/service-orders [sucesso] abre e lista com service.orders.read/manage", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const { customer, technician } = await seedBase(ctx), user = ctx.as("user")
    const created = await user.post(url, { body: order(customer, { technicianId: technician, scheduledAt: "2026-12-01T13:00:00Z" }) })
    assert.equal(created.statusCode, 201, created.body)
    assert.match(created.json().data.number, /^OS-\d{6}$/)
    assert.equal(created.json().data.status, "scheduled")
    const listed = await user.get(url, { query: { status: "scheduled" } })
    assert.equal(listed.json().total, 1)
    const detail = await user.get(`${url}/${created.json().data.id}`)
    assert.equal(detail.statusCode, 200)
    assert.deepEqual([detail.json().data.hours, detail.json().data.parts, detail.json().data.photos], [[], [], []])
    assert.equal((await user.get(url + "/equipment-history", { query: { serialNumber: "ser-1" } })).json().data.length, 1)
  })
})
test("GET /api/v1/service-orders + POST /api/v1/service-orders + GET /api/v1/service-orders/{id} + GET /api/v1/service-orders/equipment-history [negado] sem token, sem permissão e de outra empresa", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const { customer } = await seedBase(ctx)
    const created = (await ctx.as("user").post(url, { body: order(customer) })).json().data
    for (const persona of ["anonymous", "denied"] as const) {
      const client = ctx.as(persona), expected = persona === "anonymous" ? 401 : 403
      assert.equal((await client.get(url)).statusCode, expected)
      assert.equal((await client.get(`${url}/${created.id}`)).statusCode, expected)
      assert.equal((await client.get(url + "/equipment-history", { query: { serialNumber: "SER-1" } })).statusCode, expected)
      assert.equal((await client.post(url, { body: order(customer) })).statusCode, expected)
    }
    const other = ctx.as("outsider")
    assert.equal((await other.get(`${url}/${created.id}`, { tenant: ctx.otherTenant })).statusCode, 404)
    assert.equal((await other.get(url, { tenant: ctx.otherTenant })).json().total, 0)
  })
})
test("POST /api/v1/service-orders [422] valida cliente, técnico, campos desconhecidos e garantia de outro cliente", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const { customer } = await seedBase(ctx), user = ctx.as("user")
    assert.equal((await user.post(url, { body: order(randomUUID()) })).statusCode, 422)
    assert.equal((await user.post(url, { body: order(customer, { technicianId: randomUUID() }) })).statusCode, 422)
    assert.equal((await user.post(url, { body: { ...order(customer), extra: true } })).statusCode, 422)
    assert.equal((await user.post(url, { body: order(customer, { title: "x" }) })).statusCode, 422)
    assert.equal((await user.post(url, { body: order(customer, { warrantyCaseId: randomUUID() }) })).statusCode, 422)
  })
})
test("POST /api/v1/service-orders [idempotência] repetir a chave não abre outra ordem", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const { customer } = await seedBase(ctx), user = ctx.as("user"), key = randomUUID()
    const first = await user.post(url, { body: order(customer), idempotencyKey: key })
    const again = await user.post(url, { body: order(customer), idempotencyKey: key })
    assert.equal(again.json().data.id, first.json().data.id)
    assert.equal((await user.get(url)).json().total, 1)
  })
})

test("OS no celular: checklist, horas, peça com baixa de estoque, foto e assinatura; fechamento fora da garantia gera cobrança", databaseTestOptions, async () => {
  const titles: ReceivableRequest[] = []
  const services: ServicePorts = { receivables: { async open(_ctx, request) { titles.push(request); return { status: "issued", reference: "TIT-1" } } } }
  await withTestContext({ permissions, dependencies: { services } }, async ctx => {
    const { customer, technician, product } = await seedBase(ctx), user = ctx.as("user")
    let data = (await user.post(url, { body: order(customer, { technicianId: technician, scheduledAt: "2026-12-01T13:00:00Z" }) })).json().data
    const call = async (path: string, body: unknown) => {
      const response = await user.post(`${url}/${data.id}/${path}`, { body, revision: data.revision })
      assert.equal(response.statusCode, 200, `${path}: ${response.body}`)
      data = response.json().data
      return data
    }
    await call("start", {})
    await call("hours", { minutes: 90, rateCents: 10000, note: "Diagnóstico e reparo" })
    assert.equal(data.laborCents, 15000)
    await call("parts", { productId: product, quantity: "2", unitCents: 2500 })
    assert.equal(data.partsCents, 5000)
    const balance = (await ctx.seed.query("SELECT quantity_micros::text AS q FROM stock_balances WHERE product_id=$1", [product])).rows[0]!.q
    assert.equal(balance, "3000000", "a peça baixou o estoque")
    await call("photos", { filename: "antes.jpg", mediaType: "image/jpeg", caption: "Antes", base64: jpeg })
    // Fechar sem concluir o checklist obrigatório é recusado.
    const early = await user.post(`${url}/${data.id}/close`, { body: { signerName: "Maria Cliente", signaturePng: png }, revision: data.revision })
    assert.equal(early.statusCode, 409)
    await call("checklist", { items: [{ label: "Limpeza", required: true, done: true }, { label: "Teste final", required: true, done: true }] })
    await call("close", { signerName: "Maria Cliente", signaturePng: png })
    assert.equal(data.status, "completed")
    assert.equal(data.signedBy, "Maria Cliente")
    assert.equal(data.chargeStatus, "issued")
    assert.equal(titles.length, 1)
    assert.equal(titles[0]!.amountCents, 20000)
    assert.equal(titles[0]!.idempotencyKey, data.id)
    const detail = (await user.get(`${url}/${data.id}`)).json().data
    assert.equal(detail.parts.length, 1); assert.equal(detail.hours.length, 1)
    const photo = await user.get(`/api/v1/service-order-photos/${detail.photos[0].id}/file`)
    assert.equal(photo.statusCode, 200)
    assert.equal(photo.headers["content-type"], "image/jpeg")
    assert.equal((await ctx.as("denied").get(`/api/v1/service-order-photos/${detail.photos[0].id}/file`)).statusCode, 403)
    assert.equal((await ctx.as("anonymous").get(`/api/v1/service-order-photos/${detail.photos[0].id}/file`)).statusCode, 401)
    // Histórico do equipamento reúne a OS concluída.
    const history = (await user.get(url + "/equipment-history", { query: { serialNumber: "SER-1" } })).json().data
    assert.equal(history[0].status, "completed"); assert.equal(history[0].totalCents, 20000)
    // Ordem encerrada não aceita novos lançamentos nem cobrança repetida.
    assert.equal((await user.post(`${url}/${data.id}/hours`, { body: { minutes: 10, rateCents: 1 }, revision: data.revision })).statusCode, 409)
    assert.equal((await user.post(`${url}/${data.id}/charge`, { body: {}, revision: data.revision })).statusCode, 409)
  })
})
test("OS: sem porta de título a cobrança fica pendente e é repetida; garantia elegível não cobra", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const { customer } = await seedBase(ctx), user = ctx.as("user")
    let data = (await user.post(url, { body: order(customer, { checklist: [] }) })).json().data
    const call = async (path: string, body: unknown) => { const r = await user.post(`${url}/${data.id}/${path}`, { body, revision: data.revision }); assert.equal(r.statusCode, 200, r.body); data = r.json().data }
    await call("start", {}); await call("hours", { minutes: 60, rateCents: 8000 }); await call("close", { signerName: "Maria Cliente", signaturePng: png })
    assert.equal(data.chargeStatus, "pending")
    assert.match(data.chargeMessage, /FI1/)
    // Zerar não é permitido pela API; a repetição só resolve com a porta presente (aqui continua pendente).
    await call("charge", {})
    assert.equal(data.chargeStatus, "pending")
    // Garantia elegível: o fechamento dispensa a cobrança.
    const caseId = randomUUID()
    await ctx.seed.query("INSERT INTO warranty_cases(id,tenant_id,protocol,title,description,criticality,customer_id,coverage_status) VALUES($1,$2,'GAR-X','Garantia','Descrição da garantia','normal',$3,'eligible')", [caseId, ctx.tenant, customer])
    data = (await user.post(url, { body: order(customer, { checklist: [], warrantyCaseId: caseId }) })).json().data
    assert.equal(data.underWarranty, true)
    await call("start", {}); await call("hours", { minutes: 60, rateCents: 8000 }); await call("close", { signerName: "Maria Cliente", signaturePng: png })
    assert.equal(data.chargeStatus, "waived")
  })
})
test("POST /api/v1/service-orders/{id}/schedule + start + checklist + hours + parts + photos + close + charge + cancel [negado] sem permissão", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const { customer } = await seedBase(ctx)
    const created = (await ctx.as("user").post(url, { body: order(customer) })).json().data
    for (const path of ["schedule", "start", "checklist", "hours", "parts", "photos", "close", "charge", "cancel"]) {
      assert.equal((await ctx.as("anonymous").post(`${url}/${created.id}/${path}`, { body: {}, revision: 1 })).statusCode, 401, path)
      assert.equal((await ctx.as("denied").post(`${url}/${created.id}/${path}`, { body: {}, revision: 1 })).statusCode, 403, path)
    }
  })
})
test("POST /api/v1/service-orders/{id}/schedule + hours + parts + photos + close + cancel [412/409/422] revisão, estoque, arquivo e estado", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const { customer, technician, product } = await seedBase(ctx), user = ctx.as("user")
    const created = (await user.post(url, { body: order(customer) })).json().data, path = `${url}/${created.id}`
    assert.equal((await user.post(path + "/hours", { body: { minutes: 10, rateCents: 100 }, revision: 99 })).statusCode, 412)
    assert.equal((await user.post(path + "/hours", { body: { minutes: 10, rateCents: 100 } })).statusCode, 428)
    assert.equal((await user.post(path + "/hours", { body: { minutes: 0, rateCents: 100 }, revision: 1 })).statusCode, 422)
    assert.equal((await user.post(path + "/schedule", { body: { technicianId: randomUUID(), scheduledAt: "2026-12-01T13:00:00Z" }, revision: 1 })).statusCode, 422)
    assert.equal((await user.post(path + "/close", { body: { signerName: "Maria Cliente", signaturePng: png }, revision: 1 })).statusCode, 409, "fechar sem iniciar")
    assert.equal((await user.post(path + "/parts", { body: { productId: product, quantity: "9", unitCents: 100 }, revision: 1 })).statusCode, 409, "acima do estoque")
    assert.equal((await user.post(path + "/photos", { body: { filename: "x.png", mediaType: "image/png", base64: jpeg }, revision: 1 })).statusCode, 422, "tipo diferente do conteúdo")
    const scheduled = await user.post(path + "/schedule", { body: { technicianId: technician, scheduledAt: "2026-12-01T13:00:00Z" }, revision: 1 })
    assert.equal(scheduled.statusCode, 200); assert.equal(scheduled.json().data.status, "scheduled")
    const part = await user.post(path + "/parts", { body: { productId: product, quantity: "1", unitCents: 100 }, revision: scheduled.json().data.revision })
    assert.equal((await user.post(path + "/cancel", { body: { reason: "Cliente desistiu" }, revision: part.json().data.revision })).statusCode, 409, "peça baixada impede cancelar")
    const other = (await user.post(url, { body: order(customer) })).json().data
    const cancelled = await user.post(`${url}/${other.id}/cancel`, { body: { reason: "Cliente desistiu" }, revision: other.revision })
    assert.equal(cancelled.json().data.status, "cancelled")
    assert.equal((await user.post(`${url}/${other.id}/start`, { body: {}, revision: cancelled.json().data.revision })).statusCode, 409)
    assert.equal((await user.get(`${url}/${randomUUID()}`)).statusCode, 404)
  })
})
