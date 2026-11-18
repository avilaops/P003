import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { stockFixture } from "./stock-fixture.js"

const admin = process.env.API_TS_TEST_ADMIN_URL
test("physical locations reconcile imported stock, reversible transfers and confirmed reservations", { skip: !admin }, async t => {
  const { app, tenant, otherTenant, seed, close } = await stockFixture(admin!)
  t.after(close)
  const productId = randomUUID(), second = randomUUID(), other = randomUUID()
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'LOC','Teste local','KG',100,'active')", [productId, tenant])
  await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,10000000)", [tenant, productId])
  await seed.query("INSERT INTO warehouses(tenant_id,id,code,name,status,revision) VALUES($1,$2,'LOJA','Loja','active',1),($3,$4,'FILIAL','Outra empresa','active',1)", [tenant, second, otherTenant, other])
  const url = "/api/v1/stock/locations"
  function put(body: object, token = "editor") {
    return app.inject({ method: "PUT", url, headers: { authorization: "Bearer fixture-" + token + "-token", "x-tenant-id": tenant,
      "idempotency-key": randomUUID() }, payload: body })
  }
  async function transfer(body: object, key = randomUUID(), path = "") {
    return app.inject({ method: "POST", url: "/api/v1/stock/transfers" + path, headers: {
      authorization: "Bearer fixture-editor-token", "x-tenant-id": tenant, "idempotency-key": key }, payload: body })
  }
  const config = { enabled: true, salesId: second, purchaseId: null, productionId: null, revision: 1 }
  assert.equal((await put(config, "reader")).statusCode, 403)
  assert.equal((await put({ ...config, salesId: other })).statusCode, 422)
  const saved = await put(config)
  assert.equal(saved.statusCode, 200, saved.body)
  const fromId = saved.json().openingId as string
  assert.ok(fromId && fromId !== second)
  const input = { fromId, toId: second, items: [{ productId, quantity: "2.000000" }], reason: "Reposição de loja" }
  const key = randomUUID(), moved = await transfer(input, key)
  assert.equal(moved.statusCode, 201, moved.body)
  assert.equal((await transfer(input, key)).json().id, moved.json().id)
  async function positions() {
    const { rows } = await seed.query("SELECT warehouse_id,quantity_micros FROM stock_positions WHERE tenant_id=$1 AND product_id=$2", [tenant, productId])
    return Object.fromEntries(rows.map(row => [row.warehouse_id, row.quantity_micros]))
  }
  assert.deepEqual(await positions(), { [fromId]: "8000000", [second]: "2000000" })
  const get = (path: string) => app.inject({ method:"GET",url:"/api/v1/stock"+path,headers:{authorization:"Bearer fixture-reader-token","x-tenant-id":tenant} })
  const kardex = await get("/movements?productId="+productId)
  assert.equal(kardex.statusCode,200,kardex.body)
  assert.equal(kardex.json().summary.receipts,"0.000000")
  assert.equal(kardex.json().summary.issues,"0.000000")
  assert.ok(kardex.json().data.every((movement: {canReverse: boolean}) => !movement.canReverse))
  const badReversal = await app.inject({method:"POST",url:"/api/v1/stock/movements",
    headers:{authorization:"Bearer fixture-editor-token","x-tenant-id":tenant,"idempotency-key":randomUUID()},
    payload:{productId,direction:"receipt",reason:"Estorno isolado",quantity:"2.000000",reversesId:moved.json().items[0].issueId}})
  assert.equal(badReversal.statusCode,409,badReversal.body)
  const filtered = await get("/movements?warehouseId="+second+"&productId="+productId)
  assert.equal(filtered.statusCode,200,filtered.body)
  assert.deepEqual(filtered.json().summary,{ opening:"0.000000",receipts:"2.000000",issues:"0.000000",closing:"2.000000" })
  const order = randomUUID()
  await seed.query("INSERT INTO sales_orders(tenant_id,id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$1,'Cliente','52998224725','2027-01-01',200,'draft')", [tenant, order])
  await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'LOC','Teste local','KG',2000000,100,200)", [tenant, order, productId])
  await seed.query("UPDATE sales_orders SET status='confirmed' WHERE tenant_id=$1 AND id=$2", [tenant, order])
  const stock = await get("?warehouseId="+second)
  assert.equal(stock.statusCode,200,stock.body)
  assert.equal(stock.json().data[0].available,"0.000000")
  const reverse = "/" + moved.json().id + "/reverse"
  assert.equal((await transfer({ reason: "Estorno solicitado" }, randomUUID(), reverse)).statusCode, 409)
  assert.deepEqual(await positions(), { [fromId]: "8000000", [second]: "2000000" })
  await seed.query("UPDATE sales_orders SET status='cancelled' WHERE tenant_id=$1 AND id=$2", [tenant, order])
  const reversed = await transfer({ reason: "Estorno solicitado" }, randomUUID(), reverse)
  assert.equal(reversed.statusCode, 201, reversed.body)
  assert.equal((await transfer({ reason: "Segunda tentativa" }, randomUUID(), reverse)).statusCode, 409)
  assert.deepEqual(await positions(), { [fromId]: "10000000", [second]: "0" })
  const onlyPositive=await get("?warehouseId="+second+"&inStock=1")
  assert.equal(onlyPositive.statusCode,200,onlyPositive.body)
  assert.deepEqual([onlyPositive.json().total,onlyPositive.json().data],[0,[]])
  const atOrigin=await get("?warehouseId="+fromId+"&inStock=1")
  assert.equal(atOrigin.json().total,1)
  assert.equal(atOrigin.json().data[0].productId,productId)
  const count = await seed.query("SELECT count(*) AS legs,sum(CASE direction WHEN 'receipt' THEN quantity_micros ELSE -quantity_micros END) AS net FROM stock_movements WHERE tenant_id=$1", [tenant])
  assert.deepEqual(count.rows[0], { legs: "4", net: "0" })
})
