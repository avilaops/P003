import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { stockFixture } from "./stock-fixture.js"

const admin = process.env.API_TS_TEST_ADMIN_URL
test("detalhe de lançamento • produto, depósito, custo, origem, estorno e isolamento por empresa", { skip: !admin }, async t => {
  const { app, seed, tenant, otherTenant, close } = await stockFixture(admin!)
  t.after(close)
  const productId = randomUUID(), foreignProduct = randomUUID()
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'DET','Detalhe de lançamento','UN',100,'active'),($3,$4,'OUT','Outra empresa','UN',100,'active')",
    [productId, tenant, foreignProduct, otherTenant])
  const headers = (token: string, company = tenant) => ({ authorization: "Bearer fixture-" + token + "-token", "x-tenant-id": company })
  const post = (payload: object, company = tenant) => app.inject({ method: "POST", url: "/api/v1/stock/movements",
    headers: { ...headers("editor", company), "idempotency-key": randomUUID() }, payload })
  const get = (id: string, token = "reader", company = tenant) => app.inject({ method: "GET", url: "/api/v1/stock/movements/" + id, headers: headers(token, company) })

  const receipt = await post({ productId, direction: "receipt", quantity: "4.000000", unitCost: "12.500000", effectiveDate: "2025-03-10", reason: "Entrada para detalhe" })
  assert.equal(receipt.statusCode, 201, receipt.body)
  const id = receipt.json().id as string

  const detail = await get(id)
  assert.equal(detail.statusCode, 200, detail.body)
  assert.equal(detail.headers["cache-control"], "no-store")
  const body = detail.json()
  assert.equal(body.tenantId, tenant)
  assert.equal(body.canEdit, false)
  assert.deepEqual(body.product, { productId, sku: "DET", name: "Detalhe de lançamento", unit: "UN", status: "active" })
  assert.ok(body.warehouse?.id, "movimento recebe o depósito padrão")
  assert.equal(body.warehouse.name, "Principal")
  assert.deepEqual([body.movement.id, body.movement.direction, body.movement.quantity, body.movement.balanceAfter, body.movement.effectiveDate],
    [id, "receipt", "4.000000", "4.000000", "2025-03-10"])
  assert.deepEqual([body.movement.unitCost, body.movement.movementValue], ["12.500000", "50.00"])
  assert.deepEqual([body.movement.canReverse, body.movement.reversedBy, body.movement.reversesId], [true, null, null])

  const reversal = await post({ productId, direction: "issue", quantity: "4.000000", reason: "Estorno do detalhe", reversesId: id })
  assert.equal(reversal.statusCode, 201, reversal.body)
  const reversed = (await get(id, "editor")).json()
  assert.deepEqual([reversed.canEdit, reversed.movement.canReverse, reversed.movement.reversedBy], [true, false, reversal.json().id])
  const reverseDetail = (await get(reversal.json().id)).json()
  assert.deepEqual([reverseDetail.movement.reversesId, reverseDetail.movement.direction, reverseDetail.movement.canReverse], [id, "issue", false])

  const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/stock/movements/" + id, headers: { "x-tenant-id": tenant } })
  assert.equal(unauthenticated.statusCode, 401, unauthenticated.body)
  assert.equal((await get(id, "visitor")).statusCode, 403)
  assert.equal((await get("MOV-01842")).statusCode, 422)
  assert.equal((await get(randomUUID())).statusCode, 404)

  const foreign = await post({ productId: foreignProduct, direction: "receipt", quantity: "1.000000", reason: "Entrada de outra empresa" }, otherTenant)
  assert.equal(foreign.statusCode, 201, foreign.body)
  assert.equal((await get(foreign.json().id)).statusCode, 404, "outra empresa não vê o lançamento")
  assert.equal((await get(id, "reader", otherTenant)).statusCode, 404)
})
