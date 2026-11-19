import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import type { FreightProvider, FreightTrackingEvent } from "../src/modules/logistics-freight/provider.js"
import { createTestContext, databaseTestOptions, type TestContext } from "./support/test-context.js"

const base = "/api/v1/logistics/freight"
const permissions = ["logistics.freight.read", "logistics.freight.manage"]

/** Stub do Ávila Envios: os testes nunca chamam um intermediador real. */
function stubProvider() {
  const calls: string[] = []
  const tracking: FreightTrackingEvent[] = []
  const provider: FreightProvider = {
    code: "stub-envios",
    async quote(input) {
      calls.push(`quote:${input.origin.postalCode}>${input.destination.postalCode}:${input.packages.reduce((s, p) => s + p.weightGrams, 0)}`)
      return [
        { serviceCode: "expresso", serviceName: "Expresso", carrierName: "Transportadora Rápida", priceCents: 8990, deliveryDays: 2 },
        { serviceCode: "economico", serviceName: "Econômico", carrierName: "Transportadora Barata", priceCents: 4590, deliveryDays: 6 },
      ]
    },
    async contract(input) { calls.push(`contract:${input.serviceCode}`); return { providerReference: "REF-" + input.reference.slice(0, 8), trackingCode: "BR123456789" } },
    async label(reference) { calls.push(`label:${reference}`); return { format: "pdf", labelCode: "ETQ-0001", content: Buffer.from("%PDF-1.4 etiqueta de teste") } },
    async track(reference) { calls.push(`track:${reference}`); return tracking },
    async cancel(reference) { calls.push(`cancel:${reference}`) },
  }
  return { provider, calls, tracking }
}

const cpfs = ["52998224725", "11144477735", "12345678909", "39053344705", "15350946056", "71428793860"]
let seeded = 0

/** Pedido confirmado com cliente (CEP), CEP da empresa e expedição conferida com dois volumes. */
async function seedShipment(ctx: TestContext, options: { customerPostal?: string | null; companyPostal?: string | null; packages?: boolean; status?: string } = {}) {
  const cpf = cpfs[seeded++ % cpfs.length]!
  const customer = randomUUID(), order = randomUUID(), checkout = randomUUID(), shipment = randomUUID()
  const addresses = options.customerPostal === null ? [] : [{ label: "Entrega", postalCode: options.customerPostal ?? "01310100", state: "SP", city: "São Paulo", street: "Av. Paulista", number: "1000", district: "Bela Vista", primary: true }]
  await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status,addresses) VALUES($1,$2,'fisica','Cliente Frete',$4,true,false,'active',$3)", [customer, ctx.tenant, JSON.stringify(addresses), cpf])
  if (options.companyPostal !== null)
    await ctx.seed.query("INSERT INTO company_profiles(tenant_id,revision,details) VALUES($1,1,$2) ON CONFLICT (tenant_id) DO UPDATE SET details=EXCLUDED.details", [ctx.tenant, { postalCode: options.companyPostal ?? "13010-000" }])
  await ctx.seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente Frete',$4,'2027-01-01',250000,'confirmed')", [order, ctx.tenant, customer, cpf])
  await ctx.seed.query("INSERT INTO logistics_checkouts(id,tenant_id,order_id,status,completed_at) VALUES($1,$2,$3,'completed',now())", [checkout, ctx.tenant, order])
  if (options.packages !== false)
    await ctx.seed.query("INSERT INTO logistics_checkout_packages(id,tenant_id,checkout_id,package_number,weight_grams,length_mm,width_mm,height_mm) VALUES($1,$2,$3,1,12000,500,400,300),($4,$2,$3,2,8000,400,300,200)", [randomUUID(), ctx.tenant, checkout, randomUUID()])
  await ctx.seed.query("INSERT INTO logistics_shipments(id,tenant_id,order_id,checkout_id,status) VALUES($1,$2,$3,$4,$5)", [shipment, ctx.tenant, order, checkout, options.status ?? "checked"])
  return { order, shipment }
}

test(
  `Ávila Envios • Cota pelo peso e destino, contrata, gera etiqueta e rastreia com eventos no pedido — POST ${base}/quotes + POST ${base}/contracts + GET ${base}/contracts + GET ${base}/contracts/{id} + POST ${base}/contracts/{id}/label + GET ${base}/contracts/{id}/label + POST ${base}/contracts/{id}/tracking + POST ${base}/contracts/{id}/cancel [sucesso]`,
  databaseTestOptions,
  async () => {
    const stub = stubProvider()
    const ctx = await createTestContext({ permissions: [...permissions, "logistics.shipments.read"], dependencies: { freight: stub.provider } })
    try {
      const user = ctx.as("user")
      const { shipment } = await seedShipment(ctx)

      const quote = await user.post(base + "/quotes", { body: { shipmentId: shipment } })
      assert.equal(quote.statusCode, 200, quote.body)
      const q = quote.json().data
      assert.equal(q.weightGrams, 20000)
      assert.equal(q.packageCount, 2)
      assert.equal(q.origin.postalCode, "13010000")
      assert.equal(q.destination.postalCode, "01310100")
      assert.deepEqual(q.options.map((o: { serviceCode: string }) => o.serviceCode), ["economico", "expresso"], "mais barato primeiro")
      assert.equal(stub.calls[0], "quote:13010000>01310100:20000")

      const key = randomUUID()
      const [first, again] = await Promise.all([
        user.post(base + "/contracts", { body: { shipmentId: shipment, serviceCode: "economico" }, idempotencyKey: key }),
        user.post(base + "/contracts", { body: { shipmentId: shipment, serviceCode: "economico" }, idempotencyKey: key }),
      ])
      assert.equal(first.statusCode, 201, first.body)
      assert.equal(again.statusCode, 200, again.body)
      assert.equal(again.headers["idempotency-replayed"], "true")
      const contract = first.json().data
      assert.equal(contract.carrierName, "Transportadora Barata")
      assert.equal(contract.priceCents, 4590)
      assert.equal(contract.trackingCode, "BR123456789")
      assert.equal(contract.status, "contracted")
      assert.equal(stub.calls.filter(c => c.startsWith("contract:")).length, 1, "contratação idempotente chama o provedor uma vez")

      // a transportadora contratada passa para a expedição (romaneio)
      const shipped = (await user.get("/api/v1/logistics/shipments/" + shipment)).json().data
      assert.equal(shipped.carrierName, "Transportadora Barata")
      assert.equal(shipped.trackingCode, "BR123456789")

      const listed = await user.get(base + "/contracts", { query: { shipmentId: shipment } })
      assert.equal(listed.statusCode, 200, listed.body)
      assert.equal(listed.json().total, 1)

      assert.equal((await user.get(base + "/contracts/" + contract.id + "/label")).statusCode, 404, "etiqueta ainda não gerada")
      const labeled = await user.post(base + "/contracts/" + contract.id + "/label", { revision: 1 })
      assert.equal(labeled.statusCode, 200, labeled.body)
      assert.equal(labeled.json().data.status, "labeled")
      assert.equal(labeled.json().data.labelCode, "ETQ-0001")
      const file = await user.get(base + "/contracts/" + contract.id + "/label")
      assert.equal(file.statusCode, 200)
      assert.equal(file.headers["content-type"], "application/pdf")
      assert.match(file.body, /^%PDF/)

      stub.tracking.push(
        { providerEventId: "e1", occurredAt: "2026-11-20T10:00:00Z", status: "posted", description: "Objeto postado", location: "Campinas/SP" },
        { providerEventId: "e2", occurredAt: "2026-11-21T09:00:00Z", status: "in_transit", description: "Em trânsito", location: null },
      )
      const tracked = await user.post(base + "/contracts/" + contract.id + "/tracking", { revision: 2 })
      assert.equal(tracked.statusCode, 200, tracked.body)
      assert.equal(tracked.json().data.status, "in_transit")
      assert.equal(tracked.json().data.events.length, 2)
      const again2 = await user.post(base + "/contracts/" + contract.id + "/tracking", { revision: 3 })
      assert.equal(again2.json().data.events.length, 2, "eventos repetidos do provedor não duplicam")
      assert.equal(again2.json().data.revision, 3, "sem novidade, sem nova revisão")

      const detail = await user.get(base + "/contracts/" + contract.id)
      assert.equal(detail.statusCode, 200)
      assert.equal(detail.headers.etag, '"3"')
      const history = (await user.get("/api/v1/logistics/shipments/" + shipment)).json().data.events.map((e: { status: string }) => e.status)
      assert.deepEqual(history.filter((s: string) => s !== "to_separate"), ["freight_contracted", "tracking", "tracking"], "rastreio aparece no histórico do pedido")

      // cancelamento: envio postado não cancela; nova contratação cancela antes de postar
      assert.equal((await user.post(base + "/contracts/" + contract.id + "/cancel", { revision: 3 })).statusCode, 409)
      await ctx.seed.query("UPDATE logistics_freight_contracts SET status='labeled' WHERE id=$1", [contract.id])
      const cancelled = await user.post(base + "/contracts/" + contract.id + "/cancel", { revision: 3 })
      assert.equal(cancelled.statusCode, 200, cancelled.body)
      assert.equal(cancelled.json().data.status, "cancelled")
      const recontract = await user.post(base + "/contracts", { body: { shipmentId: shipment, serviceCode: "expresso" } })
      assert.equal(recontract.statusCode, 201, "cancelado libera nova contratação")
    } finally { await ctx.close() }
  },
)

test(
  `Ávila Envios • POST ${base}/quotes + POST ${base}/contracts + GET ${base}/contracts + GET ${base}/contracts/{id} + POST ${base}/contracts/{id}/label + GET ${base}/contracts/{id}/label + POST ${base}/contracts/{id}/tracking + POST ${base}/contracts/{id}/cancel [negado] sem token, sem permissão e de outra empresa; 422, 409 e 412`,
  databaseTestOptions,
  async () => {
    const stub = stubProvider()
    const ctx = await createTestContext({ permissions, dependencies: { freight: stub.provider } })
    try {
      const user = ctx.as("user")
      const { shipment } = await seedShipment(ctx)
      const contract = (await user.post(base + "/contracts", { body: { shipmentId: shipment, serviceCode: "expresso" } })).json().data
      const id = contract.id as string
      const writes: [string, object?][] = [
        [base + "/quotes", { shipmentId: shipment }], [base + "/contracts", { shipmentId: shipment, serviceCode: "expresso" }],
        [`${base}/contracts/${id}/label`], [`${base}/contracts/${id}/tracking`], [`${base}/contracts/${id}/cancel`],
      ]
      const reads = [base + "/contracts", `${base}/contracts/${id}`, `${base}/contracts/${id}/label`]
      for (const [url, body] of writes) {
        assert.equal((await ctx.as("anonymous").post(url, { body, revision: 1 })).statusCode, 401, url)
        assert.equal((await ctx.as("denied").post(url, { body, revision: 1 })).statusCode, 403, url)
      }
      for (const url of reads) {
        assert.equal((await ctx.as("anonymous").get(url)).statusCode, 401, url)
        assert.equal((await ctx.as("denied").get(url)).statusCode, 403, url)
      }
      // outra empresa (com todas as permissões lá) não enxerga o envio
      const outsider = ctx.as("outsider")
      assert.equal((await outsider.get(`${base}/contracts/${id}`, { tenant: ctx.otherTenant })).statusCode, 404)
      assert.equal((await outsider.post(`${base}/contracts/${id}/label`, { tenant: ctx.otherTenant, revision: 1 })).statusCode, 404)
      assert.equal((await outsider.post(base + "/quotes", { tenant: ctx.otherTenant, body: { shipmentId: shipment } })).statusCode, 404)
      assert.equal((await outsider.get(base + "/contracts", { tenant: ctx.otherTenant })).json().total, 0)

      // só leitura não contrata
      await ctx.grant("denied", "logistics.freight.read")
      assert.equal((await ctx.as("denied").get(`${base}/contracts/${id}`)).statusCode, 200)
      assert.equal((await ctx.as("denied").post(base + "/quotes", { body: { shipmentId: shipment } })).statusCode, 403)

      // 422
      assert.equal((await user.post(base + "/quotes", { body: { shipmentId: "x" } })).statusCode, 422)
      assert.equal((await user.post(base + "/contracts", { body: { shipmentId: shipment, serviceCode: "expresso", extra: 1 } })).statusCode, 422)
      assert.equal((await user.get(base + "/contracts", { query: { status: "voando" } })).statusCode, 422)
      assert.equal((await user.post(`${base}/contracts/${id}/label`, { body: { a: 1 }, revision: 1 })).statusCode, 422)

      // 409: contratação ativa, serviço indisponível, expedição sem volumes, sem CEP, já expedida
      assert.equal((await user.post(base + "/contracts", { body: { shipmentId: shipment, serviceCode: "expresso" } })).statusCode, 409)
      const other = await seedShipment(ctx)
      assert.equal((await user.post(base + "/contracts", { body: { shipmentId: other.shipment, serviceCode: "sedex-10" } })).statusCode, 409)
      const empty = await seedShipment(ctx, { packages: false })
      assert.equal((await user.post(base + "/quotes", { body: { shipmentId: empty.shipment } })).statusCode, 409)
      const noPostal = await seedShipment(ctx, { customerPostal: null })
      const missing = await user.post(base + "/quotes", { body: { shipmentId: noPostal.shipment } })
      assert.equal(missing.statusCode, 409)
      assert.equal(missing.json().title, "Informe o CEP do endereço principal do cliente para cotar o frete")
      const early = await seedShipment(ctx, { status: "to_separate" })
      assert.equal((await user.post(base + "/quotes", { body: { shipmentId: early.shipment } })).statusCode, 409)

      // 412 e 428
      assert.equal((await user.post(`${base}/contracts/${id}/label`, { revision: 9 })).statusCode, 412)
      assert.equal((await user.post(`${base}/contracts/${id}/label`, { headers: { "if-match": '"1"' }, idempotencyKey: "não-uuid" })).statusCode, 422)
      assert.equal(stub.calls.filter(c => c.startsWith("label:")).length, 0, "nenhuma recusa chegou ao provedor")
    } finally { await ctx.close() }
  },
)

test(`Ávila Envios • sem provedor configurado a cotação recusa com mensagem clara (POST ${base}/quotes)`, databaseTestOptions, async () => {
  const ctx = await createTestContext({ permissions })
  try {
    const { shipment } = await seedShipment(ctx)
    const response = await ctx.as("user").post(base + "/quotes", { body: { shipmentId: shipment } })
    assert.equal(response.statusCode, 503)
    assert.equal(response.json().type, "https://erp.avilaops.com/problems/freight_provider_unavailable")
    assert.match(response.body, /Ávila Envios ainda não está configurado/)
  } finally { await ctx.close() }
})
