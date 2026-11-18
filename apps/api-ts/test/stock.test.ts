import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { stockFixture } from "./stock-fixture.js"

const adminUrl = process.env.API_TS_TEST_ADMIN_URL
test("stock and Kardex HTTP contracts on PostgreSQL", { skip: !adminUrl }, async t => {
  const { app, tenant, otherTenant, seed, close } = await stockFixture(adminUrl!)
  t.after(close)
  const id = "aa000000-0000-3000-2000-000000000001", zero = randomUUID(), dated = randomUUID()
  await seed.query(`INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES
    ($1,$2,'ITEM/1','Equipamento','UN',100,'active'),($3,$2,'ZERO','Zerado','KG',100,'active'),
    ($4,$2,'TEMPO','Histórico','UN',100,'active'),($5,$6,'ITEM/1','Outra empresa','UN',100,'active')`, [id, tenant, zero, dated, randomUUID(), otherTenant])
  const headers = (token: string, company = tenant) => ({ authorization: "Bearer fixture-" + token + "-token", "x-tenant-id": company })
  const get = (path: string, company = tenant, token = "reader") => app.inject({ method: "GET", url: "/api/v1/stock" + path, headers: headers(token, company) })
  const post = (body: object, key = randomUUID(), token = "editor") => app.inject({ method: "POST", url: "/api/v1/stock/movements", headers: { ...headers(token), "idempotency-key": key }, payload: body })
  const input = { productId: id, direction: "receipt", quantity: "10.000000", reason: "  Abertura conferida  " }
  const snapshot = async () => {
    const response = await get("?q=ITEM%2F1")
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().canEdit, false)
    const { quantity, reserved, available } = response.json().data[0]
    return [quantity, reserved, available]
  }
  const kardex = (productId: string, more = "") => get("/movements?productId=" + productId + more)

  await t.test("zero, catalogue-independent identity, read/write rights and isolation", async () => {
    const balance = (await get("?q=ZERO")).json().data[0]
    assert.deepEqual([balance.quantity, balance.reserved, balance.available], Array(3).fill("0.000000"))
    const history = await kardex(zero)
    assert.equal(history.statusCode, 200, history.body)
    assert.deepEqual(history.json().product, { productId: zero, name: "Zerado", sku: "ZERO", unit: "KG", status: "active" })
    assert.equal(history.json().total, 0)
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/products/" + zero, headers: headers("reader") })).statusCode, 403)
    assert.equal((await post(input, randomUUID(), "reader")).statusCode, 403)
    assert.equal((await get("", tenant, "visitor")).statusCode, 403)
    assert.equal((await get("/movements?productId=" + id, otherTenant)).statusCode, 404)
    assert.equal((await get("?limit=0")).statusCode, 422)
    assert.equal((await get("?q=ausente")).json().total, 0)
  })

  await t.test("concurrent retries, reservations and order completion", async () => {
    const key = randomUUID()
    const replies = await Promise.all([post(input, key), post(input, key)])
    for (const reply of replies) assert.equal(reply.statusCode, 201, reply.body)
    assert.deepEqual(replies[0]!.json(), replies[1]!.json())
    assert.equal((await post({ ...input, quantity: "11.000000" }, key)).statusCode, 409)
    const movement = replies[0]!.json().id
    const evidence = await seed.query("SELECT (SELECT count(*) FROM audit_log WHERE entity_id=$1) AS audit,(SELECT count(*) FROM outbox_events WHERE aggregate_id=$1) AS events", [movement])
    assert.deepEqual(evidence.rows[0], { audit: "1", events: "1" })
    const order = randomUUID(), method = randomUUID()
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-01',300,'draft')", [order, tenant])
    await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'ITEM/1','Equipamento','UN',3000000,100,300)", [tenant, order, id])
    await seed.query("INSERT INTO payment_methods(id,tenant_id,code,name,modality,settlement_days,status,revision) VALUES($1,$2,'TEST','Pix','pix',0,'active',1)", [method, tenant])
    const payment = { id: method, code: "TEST", name: "Pix", modality: "pix" }
    await seed.query("INSERT INTO sales_order_checkouts(tenant_id,order_id,customer_snapshot,entry_amount_cents,delivery_notes,payment_notes,notes) VALUES($1,$2,$3,0,'','','')", [tenant, order, { legalName: "Cliente" }])
    await seed.query("INSERT INTO sales_order_installments(id,tenant_id,order_id,number,kind,payment_method_id,payment_method,due_on,amount_cents) VALUES($1,$2,$3,1,'balance',$4,$5,'2027-01-01',300)", [randomUUID(), tenant, order, method, payment])
    async function transition(action: string, revision: number) {
      const reply = await app.inject({ method: "POST", url: `/api/v1/orders/${order}/${action}`, headers: { ...headers("editor"), "idempotency-key": randomUUID(), "if-match": `"${revision}"` } })
      assert.equal(reply.statusCode, 200, reply.body)
    }
    await transition("accept", 1)
    assert.deepEqual(await snapshot(), ["10.000000", "0.000000", "10.000000"])
    await transition("confirm", 2)
    assert.deepEqual(await snapshot(), ["10.000000", "3.000000", "7.000000"])
    const demand = (await get("/movements?productId="+id,tenant,"editor")).json().openOrders
    assert.equal(demand.reserved,"3.000000")
    assert.equal(demand.data[0].id,order)
    assert.equal(demand.data[0].status,"confirmed")
    assert.deepEqual((await kardex(id)).json().openOrders.data,[])
    assert.equal((await post({ ...input, direction: "issue", quantity: "7.000001" })).statusCode, 409)
    await transition("complete", 3)
    assert.deepEqual(await snapshot(), ["7.000000", "0.000000", "7.000000"])
    const issued = (await kardex(id)).json().data[0]
    const issues = (await kardex(id,"&direction=issue")).json()
    assert.equal(issues.total,1)
    assert.deepEqual(issues.summary,{opening:"0.000000",receipts:"10.000000",issues:"3.000000",closing:"7.000000"})
    assert.equal(issued.sourceOrderId, order)
    assert.equal(issued.canReverse, false)
    assert.equal((await post({ ...input, quantity: "3.000000", reversesId: issued.id })).statusCode, 409)
  })

  await t.test("manual reversal is atomic, obeys settings and cannot be repeated", async () => {
    const receipt = (await post({ ...input, productId: zero, quantity: "0.000001" })).json()
    const reverse = { ...input, productId: zero, quantity: "0.000001", direction: "issue", reversesId: receipt.id }
    const concurrent = await Promise.all([post(reverse), post(reverse)])
    assert.deepEqual(concurrent.map(r => r.statusCode).sort(), [201,409])
    assert.ok((await kardex(zero)).json().data.every((m: { canReverse: boolean }) => !m.canReverse))
    await seed.query("INSERT INTO inventory_settings(tenant_id,allow_manual_movements,minimum_reason_length,revision) VALUES($1,false,10,1)", [tenant])
    assert.equal((await post(input)).statusCode, 409)
    await seed.query("UPDATE inventory_settings SET allow_manual_movements=true WHERE tenant_id=$1", [tenant])
    assert.equal((await post({ ...input, reason: "curto" })).statusCode, 422)
  })

  await t.test("historical inventory links protect adjustments and category filters apply before totals", async () => {
    const count = randomUUID(), adjustment = randomUUID(), category = randomUUID()
    await seed.query("INSERT INTO product_categories(id,tenant_id,code,name,status,revision,sort_order) VALUES($1,$2,'TEST','Categoria','active',1,0)", [category, tenant])
    await seed.query("UPDATE products SET category_id=$1 WHERE tenant_id=$2 AND id=$3", [category, tenant, zero])
    const inCategory = (await get("?category_id=" + category)).json()
    assert.equal(inCategory.total, 1)
    assert.equal(inCategory.data[0].productId, zero)
    await seed.query("UPDATE stock_balances SET quantity_micros=2 WHERE tenant_id=$1 AND product_id=$2", [tenant, zero])
    await seed.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason) VALUES($1,$2,$3,'receipt',2,2,'Ajuste de inventário')", [adjustment, tenant, zero])
    await seed.query("INSERT INTO audit_log(tenant_id,entity_type,entity_id,action,details) VALUES($1,'stock_movement',$2,'stock.moved',$3)", [tenant, adjustment, { inventoryCountId: count }])
    const row = (await kardex(zero)).json().data[0]
    assert.equal(row.sourceInventoryCountId, count)
    assert.equal(row.canReverse, false)
    assert.equal((await post({ ...input, productId: zero, quantity: "0.000002", direction: "issue", reversesId: adjustment })).statusCode, 409)
  })

  await t.test("São Paulo boundaries, aggregate totals beyond the page and pre-ledger stock", async () => {
    await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,7000004)", [tenant, dated])
    for (const [date, direction, quantity, after] of [
      ["2026-11-17T02:59:59.999Z", "receipt", 1000000, 8000000],
      ["2026-11-17T03:00:00Z", "receipt", 3, 8000003],
      ["2026-11-18T02:59:59.999999Z", "issue", 1000000, 7000003],
      ["2026-11-18T03:00:00Z", "receipt", 1, 7000004],
    ]) await seed.query("INSERT INTO stock_movements(tenant_id,id,product_id,direction,quantity_micros,balance_after_micros,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,'Movimento datado',$7)", [tenant, randomUUID(), dated, direction, quantity, after, date])
    for (const offset of [0,1,2]) {
      const reply = await kardex(dated, "&startDate=2026-11-17&endDate=2026-11-17&limit=1&offset=" + offset)
      assert.equal(reply.statusCode, 200, reply.body)
      assert.equal(reply.json().total, 2)
      assert.equal(reply.json().data.length, offset === 2 ? 0 : 1)
      if (offset === 0) assert.equal(reply.json().data[0].occurredAt, "2026-11-18T02:59:59.999999Z")
      assert.deepEqual(reply.json().summary, { opening: "8.000000", receipts: "0.000003", issues: "1.000000", closing: "7.000003" })
    }
    assert.equal((await kardex(dated, "&endDate=2020-01-01")).json().summary.closing, "7.000000")
    for (const suffix of ["&endDate=2026-02-31", "&startDate=", "&startDate=2026-12-01&endDate=2026-01-01"]) assert.equal((await kardex(dated, suffix)).statusCode, 422)
  })
})
