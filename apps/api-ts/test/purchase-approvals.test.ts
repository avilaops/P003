import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { databaseTestOptions, withTestContext, type TestContext } from "./support/test-context.js"

const permissions = ["purchasing.orders.read", "purchasing.orders.manage", "purchasing.receipts.create", "inventory.stock.manage", "finance.payables.originate", "approvals.rules.manage"]

async function setup(ctx: TestContext) {
  const supplier = randomUUID(), product = randomUUID()
  await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,email,is_customer,is_supplier,status) VALUES($1,$2,'juridica','Fornecedor A','04252011000110','f@example.test',false,true,'active')", [supplier, ctx.tenant])
  await ctx.seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'P-1','Peça','UN',100,'active')", [product, ctx.tenant])
  const created = await ctx.as("user").post("/api/v1/purchase-orders", { body: { supplierId: supplier, dueDate: "2027-01-10", items: [{ productId: product, quantity: "10.000000", unitCost: "1000.00" }] } })
  assert.equal(created.statusCode, 201, created.body)
  return created.json().data as { id: string }
}
async function limitRule(ctx: TestContext, approverCode: string) {
  const role = (await ctx.seed.query("SELECT id FROM roles WHERE tenant_id=$1 AND code=$2", [ctx.tenant, approverCode])).rows[0]!.id
  const res = await ctx.as("user").post("/api/v1/approval-rules", { body: { documentType: "purchase", name: "Compras acima de 5 mil", threshold: "5000.00", approverRoleId: role } })
  assert.equal(res.statusCode, 201, res.body)
}

test("Pedido acima do limite do comprador só segue após a aprovação registrada", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    await ctx.grant("denied", "approvals.decide")
    await limitRule(ctx, "denied")
    const order = await setup(ctx) // R$ 10.000,00 > R$ 5.000,00
    const confirm = await ctx.as("user").post(`/api/v1/purchase-orders/${order.id}/confirm`, { revision: 1 })
    assert.equal(confirm.statusCode, 200, confirm.body)
    assert.equal(confirm.json().data.status, "awaiting_approval")
    // Aguardando aprovação: não pode ser recebido.
    const receive = await ctx.as("user").post(`/api/v1/purchase-orders/${order.id}/receipts`, { revision: 2, body: { reference: "NF-1", occurredOn: "2027-01-05", items: [{ productId: (await ctx.seed.query("SELECT product_id FROM purchase_order_lines LIMIT 1")).rows[0]!.product_id, quantity: "1.000000" }] } })
    assert.equal(receive.statusCode, 409, receive.body)
    // Quem pediu não aprova; o aprovador da alçada aprova.
    const pending = (await ctx.as("denied").get("/api/v1/approvals/pending")).json().data
    assert.equal(pending.length, 1)
    assert.equal(pending[0].documentId, order.id)
    const decision = await ctx.as("denied").post(`/api/v1/approvals/${pending[0].id}/decision`, { body: { decision: "approved" } })
    assert.equal(decision.statusCode, 200, decision.body)
    const after = await ctx.as("user").get(`/api/v1/purchase-orders/${order.id}`)
    assert.equal(after.json().data.status, "confirmed")
  })
})

test("Pedido recusado na alçada volta a rascunho; abaixo do limite confirma direto", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    await ctx.grant("denied", "approvals.decide")
    await limitRule(ctx, "denied")
    const order = await setup(ctx)
    await ctx.as("user").post(`/api/v1/purchase-orders/${order.id}/confirm`, { revision: 1 })
    const request = (await ctx.as("denied").get("/api/v1/approvals/pending")).json().data[0].id
    await ctx.as("denied").post(`/api/v1/approvals/${request}/decision`, { body: { decision: "rejected", reason: "Acima do orçamento" } })
    assert.equal((await ctx.as("user").get(`/api/v1/purchase-orders/${order.id}`)).json().data.status, "draft")
    await ctx.seed.query("UPDATE approval_rules SET active=false")
    const again = await ctx.as("user").get(`/api/v1/purchase-orders/${order.id}`)
    const confirmed = await ctx.as("user").post(`/api/v1/purchase-orders/${order.id}/confirm`, { revision: again.json().data.revision })
    assert.equal(confirmed.json().data.status, "confirmed")
  })
})
