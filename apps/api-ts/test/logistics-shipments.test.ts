import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { createTestContext, databaseTestOptions } from "./support/test-context.js"

test(
  "Expedição • Um pedido expedido mostra romaneio, volumes, transportadora e data de entrega no detalhe — GET /api/v1/logistics/shipments + GET /api/v1/logistics/shipments/{id} + POST /api/v1/logistics/shipments + POST /api/v1/logistics/shipments/{id}/status [sucesso]",
  databaseTestOptions,
  async () => {
    const ctx = await createTestContext({ permissions: ["logistics.shipments.read", "logistics.shipments.manage"] })
    try {
      const { tenant, otherTenant: other, seed: pg } = ctx
      // `denied` vira leitor: só logistics.shipments.read
      await ctx.grant("denied", "logistics.shipments.read")
      const order = randomUUID(), draft = randomUUID(), foreign = randomUUID()
      for (const t of [tenant, other])
        await pg.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Cliente','52998224725',true,false,'active')", [t])
      for (const [id, status, t] of [[order, "confirmed", tenant], [draft, "draft", tenant], [foreign, "confirmed", other]] as const)
        await pg.query(
          "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-01',100000,$3)",
          [id, t, status],
        )
      const user = ctx.as("user"), reader = ctx.as("denied")
      const create = (orderId: string, key = randomUUID()) => user.post("/api/v1/logistics/shipments", { body: { orderId }, idempotencyKey: key })
      const move = (id: string, revision: number, body: object) => user.post(`/api/v1/logistics/shipments/${id}/status`, { body, revision })

      // 422 / 409 / 404 na criação (401/403 no teste [negado])
      assert.equal((await reader.post("/api/v1/logistics/shipments", { body: { orderId: order } })).statusCode, 403, "leitor não expede")
      assert.equal((await create("não-é-uuid")).statusCode, 422)
      assert.equal((await create(draft)).statusCode, 409)
      assert.equal((await create(foreign)).statusCode, 404, "pedido de outra empresa não é visível")

      const key = randomUUID()
      const [first, again] = await Promise.all([create(order, key), create(order, key)])
      assert.deepEqual([first.statusCode, again.statusCode].sort(), [200, 201], first.body + again.body)
      assert.equal(first.json().data.id, again.json().data.id)
      assert.equal((await create(order)).statusCode, 409, "um pedido tem uma única expedição")
      const id = first.json().data.id as string
      assert.equal(first.json().data.status, "to_separate")

      // leitura e isolamento por empresa
      assert.equal((await reader.get("/api/v1/logistics/shipments/" + id)).statusCode, 200)
      assert.equal((await ctx.as("outsider").get("/api/v1/logistics/shipments/" + id, { tenant: other })).statusCode, 404)
      assert.equal((await reader.get("/api/v1/logistics/shipments", { query: { orderId: order } })).json().total, 1)

      // máquina de estados: 422 (entrada), 409 (pular etapa), 412 (revisão antiga)
      assert.equal((await move(id, 1, { status: "voando" })).statusCode, 422)
      assert.equal((await move(id, 1, { status: "shipped" })).statusCode, 409)
      assert.equal((await reader.post(`/api/v1/logistics/shipments/${id}/status`, { body: { status: "separated" }, revision: 1 })).statusCode, 403)
      const separated = await move(id, 1, { status: "separated" })
      assert.equal(separated.statusCode, 200, separated.body)
      assert.equal((await move(id, 1, { status: "checked" })).statusCode, 412)
      assert.equal((await move(id, 2, { status: "checked" })).statusCode, 409, "sem checkout concluído não há conferência")

      // conferência e volumes vêm do checkout logístico
      const checkout = randomUUID()
      await pg.query("INSERT INTO logistics_checkouts(id,tenant_id,order_id,status,completed_at) VALUES($1,$2,$3,'completed',now())", [checkout, tenant, order])
      await pg.query("UPDATE logistics_shipments SET checkout_id=$1 WHERE tenant_id=$2 AND id=$3", [checkout, tenant, id])
      const checked = await move(id, 2, { status: "checked" })
      assert.equal(checked.statusCode, 200, checked.body)
      assert.equal((await move(id, 3, { status: "shipped" })).statusCode, 422, "expedir exige transportadora")
      assert.equal((await move(id, 3, { status: "shipped", carrierName: "Transportes Teste" })).statusCode, 409, "expedir exige volumes")
      await pg.query(
        "INSERT INTO logistics_checkout_packages(id,tenant_id,checkout_id,package_number,weight_grams,length_mm,width_mm,height_mm) VALUES($1,$2,$3,1,12000,500,400,300),($4,$2,$3,2,8000,400,300,200)",
        [randomUUID(), tenant, checkout, randomUUID()],
      )
      const shipped = await move(id, 3, { status: "shipped", carrierName: "Transportes Teste", vehiclePlate: "ABC1D23", driverName: "Motorista Teste", trackingCode: "TRK0001" })
      assert.equal(shipped.statusCode, 200, shipped.body)
      assert.equal(shipped.json().data.manifest.number, "ROM-000001")
      const delivered = await move(id, 4, { status: "delivered" })
      assert.equal(delivered.statusCode, 200, delivered.body)
      assert.equal((await move(id, 5, { status: "delivered" })).statusCode, 409, "entregue é terminal")

      // aceite: detalhe com romaneio, volumes, transportadora e data de entrega
      const detail = (await reader.get("/api/v1/logistics/shipments/" + id)).json().data
      assert.equal(detail.status, "delivered")
      assert.equal(detail.carrierName, "Transportes Teste")
      assert.ok(detail.deliveredAt)
      assert.equal(detail.manifest.number, "ROM-000001")
      assert.equal(detail.manifest.vehiclePlate, "ABC1D23")
      assert.equal(detail.manifest.packageCount, 2)
      assert.equal(detail.manifest.totalWeightGrams, 20000)
      assert.equal(detail.packages.length, 2)
      assert.deepEqual(detail.events.map((e: { status: string }) => e.status), ["to_separate", "separated", "checked", "shipped", "delivered"])
      const outbox = await pg.query("SELECT 1 FROM outbox_events WHERE tenant_id=$1 AND event_type='logistics.shipment.delivered'", [tenant])
      assert.equal(outbox.rowCount, 1, "entrega publica o evento para Vendas e Garantia")
    } finally { await ctx.close() }
  },
)

test(
  "Expedição • GET /api/v1/logistics/shipments + GET /api/v1/logistics/shipments/{id} + POST /api/v1/logistics/shipments + POST /api/v1/logistics/shipments/{id}/status [negado] sem token, sem permissão e de outra empresa",
  databaseTestOptions,
  async () => {
    const ctx = await createTestContext({ permissions: ["logistics.shipments.read", "logistics.shipments.manage"] })
    try {
      const order = randomUUID()
      await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Cliente','52998224725',true,false,'active')", [ctx.tenant])
      await ctx.seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-01',100000,'confirmed')", [order, ctx.tenant])
      const created = await ctx.as("user").post("/api/v1/logistics/shipments", { body: { orderId: order } })
      assert.equal(created.statusCode, 201, created.body)
      const id = created.json().data.id as string
      for (const persona of ["anonymous", "denied"] as const) {
        const expected = persona === "anonymous" ? 401 : 403, client = ctx.as(persona)
        assert.equal((await client.get("/api/v1/logistics/shipments")).statusCode, expected)
        assert.equal((await client.get("/api/v1/logistics/shipments/" + id)).statusCode, expected)
        assert.equal((await client.post("/api/v1/logistics/shipments", { body: { orderId: order } })).statusCode, expected)
        assert.equal((await client.post(`/api/v1/logistics/shipments/${id}/status`, { body: { status: "separated" }, revision: 1 })).statusCode, expected)
      }
      const outsider = ctx.as("outsider")
      assert.equal((await outsider.get("/api/v1/logistics/shipments/" + id, { tenant: ctx.otherTenant })).statusCode, 404)
      assert.equal((await outsider.post(`/api/v1/logistics/shipments/${id}/status`, { tenant: ctx.otherTenant, body: { status: "separated" }, revision: 1 })).statusCode, 404)
      assert.equal((await outsider.get("/api/v1/logistics/shipments", { tenant: ctx.otherTenant })).json().total, 0)
    } finally { await ctx.close() }
  },
)
