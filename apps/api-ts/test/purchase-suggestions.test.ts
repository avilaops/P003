import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { databaseTestOptions, withTestContext, type TestContext } from "./support/test-context.js"

const url = "/api/v1/purchase-suggestions"
const permissions = ["purchasing.orders.read", "purchasing.orders.manage", "inventory.stock.read"]

async function seed(ctx: TestContext) {
  const supplierA = randomUUID(), supplierB = randomUUID(), p1 = randomUUID(), p2 = randomUUID(), p3 = randomUUID()
  for (const [id, name, tax] of [[supplierA, "Fornecedor A", "04252011000110"], [supplierB, "Fornecedor B", "60677380000106"]])
    await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'juridica',$3,$4,false,true,'active')", [id, ctx.tenant, name, tax])
  for (const [id, sku] of [[p1, "P1"], [p2, "P2"], [p3, "P3"]])
    await ctx.seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,$3,$3,'UN',100,'active')", [id, ctx.tenant, sku])
  // P1/P2 abaixo do ponto de pedido; P3 acima.
  for (const [id, balance] of [[p1, 2], [p2, 1], [p3, 100]]) {
    await ctx.seed.query("INSERT INTO stock_replenishment_rules(tenant_id,product_id,minimum_micros,reorder_micros,lot_micros,lead_days,revision) VALUES($1,$2,5000000,10000000,0,3,1)", [ctx.tenant, id])
    await ctx.seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,$3)", [ctx.tenant, id, Number(balance) * 1_000_000])
  }
  return { supplierA, supplierB, p1, p2, p3 }
}

test("Produtos abaixo do ponto de pedido geram pedidos agrupados por fornecedor com a quantidade sugerida", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const { supplierA, supplierB, p1, p2, p3 } = await seed(ctx)
    const listed = await ctx.as("user").get(url)
    assert.equal(listed.statusCode, 200, listed.body)
    assert.deepEqual(listed.json().data.map((r: { productId: string }) => r.productId).sort(), [p1, p2].sort())
    assert.ok(!listed.json().data.some((r: { productId: string }) => r.productId === p3))
    const created = await ctx.as("user").post(`${url}/orders`, { body: { dueDate: "2027-02-01", items: [
      { productId: p1, quantity: "8.000000", supplierId: supplierA, unitCost: "10.00" },
      { productId: p2, quantity: "9.000000", supplierId: supplierA, unitCost: "20.00" },
      { productId: p3, quantity: "1.000000", supplierId: supplierB, unitCost: "5.00" },
    ] } })
    assert.equal(created.statusCode, 201, created.body)
    assert.equal(created.json().data.length, 2, "um pedido por fornecedor")
    const a = created.json().data.find((o: { supplierId: string }) => o.supplierId === supplierA)
    assert.equal(a.amount, "260.00")
    const lines = (await ctx.seed.query("SELECT quantity_micros::int AS q FROM purchase_order_lines WHERE order_id=$1 ORDER BY line_number", [a.id])).rows
    assert.deepEqual(lines.map(l => l.q), [8_000_000, 9_000_000])
    // Segunda geração usa o último fornecedor e preço.
    const again = await ctx.as("user").post(`${url}/orders`, { body: { dueDate: "2027-02-01", items: [{ productId: p1, quantity: "1.000000" }] } })
    assert.equal(again.json().data[0].supplierId, supplierA)
    assert.equal(again.json().data[0].amount, "10.00")
  })
})

test("POST /api/v1/purchase-suggestions/orders [negado] produto nunca comprado sem fornecedor 422, entrada inválida 422, sem permissão 403, sem token 401", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const { p1 } = await seed(ctx)
    const body = { dueDate: "2027-02-01", items: [{ productId: p1, quantity: "1.000000" }] }
    assert.equal((await ctx.as("user").post(`${url}/orders`, { body })).statusCode, 422)
    assert.equal((await ctx.as("user").post(`${url}/orders`, { body: { items: [] } })).statusCode, 422)
    assert.equal((await ctx.as("denied").post(`${url}/orders`, { body })).statusCode, 403)
    assert.equal((await ctx.as("anonymous").post(`${url}/orders`, { body })).statusCode, 401)
    assert.equal((await ctx.as("denied").get(url)).statusCode, 403)
    assert.equal((await ctx.as("anonymous").get(url)).statusCode, 401)
    assert.equal((await ctx.as("outsider").get(url)).statusCode, 403)
  })
})
