import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"
import { verifyTransitionGuards } from "./order-transition-guards.js"

export async function verifyOrderTransitions(app: FastifyInstance, seed: Pool, tenant: string, role: string) {
  const product = randomUUID()
  const headers = { authorization: "Bearer operator", "x-tenant-id": tenant }
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'TRANSITION','Equipamento','UN',10000,'active')", [product, tenant])
  const create = async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...headers, "idempotency-key": randomUUID() }, payload: { customerId: tenant, dueDate: "2027-01-01", items: [{ productId: product, quantity: "1.000000" }] } })
    assert.equal(response.statusCode, 201, response.body)
    return response.json().data.id as string
  }
  const transition = (order: string, action: string, revision = 1, key = randomUUID(), extra = {}) => app.inject({ method: "POST", url: `/api/v1/orders/${order}/${action}`, headers: { ...headers, ...extra, "if-match": `"${revision}"`, "idempotency-key": key } })
  const order = await create()
  const shortage = await transition(order, "confirm")
  assert.equal(shortage.statusCode, 409, shortage.body)
  await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,1000000)", [tenant, product])
  const key = randomUUID()
  const confirmed = await Promise.all([1, 2].map(() => transition(order, "confirm", 1, key)))
  for (const response of confirmed) assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(confirmed[0]!.json(), confirmed[1]!.json())
  assert.equal(confirmed[0]!.json().data.status, "confirmed")
  assert.equal(confirmed[0]!.headers.etag, '"2"')
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM receivables WHERE order_id=$1", [order])).rows[0].count, 0)
  const competing = await create()
  assert.equal((await transition(competing, "confirm")).statusCode, 409, "Reservations must reduce available stock")
  const completionKey = randomUUID()
  // Failure after the stock issue must undo stock, ledger, receivable, revision and command.
  await seed.query(`REVOKE INSERT ON receivables FROM ${role}`)
  const failed = await transition(order, "complete", 2, completionKey)
  assert.equal(failed.statusCode, 500, failed.body)
  assert.equal((await seed.query("SELECT quantity_micros::text AS quantity FROM stock_balances WHERE tenant_id=$1 AND product_id=$2", [tenant, product])).rows[0].quantity, "1000000")
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM stock_movements WHERE source_order_id=$1", [order])).rows[0].count, 0)
  await seed.query(`GRANT INSERT ON receivables TO ${role}`)
  const completed = await transition(order, "complete", 2, completionKey)
  assert.equal(completed.statusCode, 200, completed.body)
  assert.equal(completed.json().data.status, "completed")
  assert.equal(completed.headers.etag, '"3"')
  assert.deepEqual((await transition(order, "complete", 2, completionKey)).json(), completed.json())
  const effects = await seed.query("SELECT (SELECT count(*)::int FROM stock_movements WHERE source_order_id=$1) AS movements,(SELECT count(*)::int FROM receivables WHERE order_id=$1) AS receivables,(SELECT quantity_micros::text FROM stock_balances WHERE tenant_id=$2 AND product_id=$3) AS quantity", [order, tenant, product])
  assert.deepEqual(effects.rows[0], { movements: 1, receivables: 1, quantity: "0" })
  assert.equal((await transition(order, "cancel", 3)).statusCode, 409)
  assert.equal((await transition(order, "confirm", 1)).statusCode, 412)
  assert.equal((await transition(order, "confirm", 3, randomUUID(), { "x-tenant-id": randomUUID() })).statusCode, 403)

  const scheduled = await create(), method = randomUUID()
  await seed.query("INSERT INTO payment_methods(id,tenant_id,code,name,modality,settlement_days,status,revision) VALUES($1,$2,'TRANSITION','Pix','pix',0,'active',1)", [method, tenant])
  const methodSnapshot = { id: method, code: "TRANSITION", name: "Pix", modality: "pix" }
  await seed.query("INSERT INTO sales_order_checkouts(tenant_id,order_id,customer_snapshot,entry_amount_cents,entry_payment_method_id,entry_payment_method,delivery_notes,payment_notes,notes) VALUES($1,$2,'{\"legalName\":\"Cliente congelado\"}',2500,$3,$4,'','','')", [tenant, scheduled, method, methodSnapshot])
  for (const [number, kind, amount, due] of [[0, "entry", 2500, null], [1, "balance", 7500, "2027-01-01"]] as const) {
    await seed.query("INSERT INTO sales_order_installments(id,tenant_id,order_id,number,kind,payment_method_id,payment_method,due_on,amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [randomUUID(), tenant, scheduled, number, kind, method, methodSnapshot, due, amount])
  }
  const acceptedKey = randomUUID()
  const accepted = await transition(scheduled, "accept", 1, acceptedKey)
  assert.equal(accepted.statusCode, 200, accepted.body)
  assert.equal(accepted.json().data.status, "accepted")
  assert.equal(accepted.json().checkout.confirmationCreatesReceivables, false)
  assert.equal(accepted.json().checkout.entry.dueOn, (await seed.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date::text AS today")).rows[0].today)
  assert.deepEqual((await transition(scheduled, "accept", 1, acceptedKey)).json(), accepted.json())
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM receivables WHERE order_id=$1", [scheduled])).rows[0].count, 2)
  assert.equal((await transition(scheduled, "confirm", 2)).statusCode, 409, "Acceptance must not reserve stock")
  const cancelKey = randomUUID(), cancelled = await transition(scheduled, "cancel", 2, cancelKey)
  assert.equal(cancelled.statusCode, 200, cancelled.body)
  assert.equal(cancelled.json().data.status, "cancelled")
  assert.deepEqual((await transition(scheduled, "cancel", 2, cancelKey)).json(), cancelled.json())
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM receivables WHERE order_id=$1 AND status='cancelled'", [scheduled])).rows[0].count, 2)
  const summary = (await seed.query("SELECT summary FROM sales_order_cancellations WHERE order_id=$1", [scheduled])).rows[0].summary
  assert.equal(summary.beforeShipment, true)
  assert.equal(summary.reconciliation.production.status, "not_required")
  assert.equal(summary.reconciliation.commission.paymentsPreserved, true)
  // Saved snapshots must be decoded like the original typed checkout reader.
  for (const field of ["entry", "installment", "extension"]) {
    const snapshotOrder = await create()
    const entryMethod = field === "entry" ? {} : { ...methodSnapshot, ignored: "stored extension" }
    await seed.query("INSERT INTO sales_order_checkouts(tenant_id,order_id,customer_snapshot,entry_amount_cents,entry_payment_method_id,entry_payment_method,delivery_notes,payment_notes,notes) VALUES($1,$2,'{}',2500,$3,$4,'','','')", [tenant, snapshotOrder, method, entryMethod])
    await seed.query("INSERT INTO sales_order_installments(id,tenant_id,order_id,number,kind,payment_method_id,payment_method,due_on,amount_cents) VALUES($1,$2,$3,1,'balance',$4,$5,'2027-01-01',7500)", [randomUUID(), tenant, snapshotOrder, method, field === "installment" ? {} : methodSnapshot])
    const decoded = await app.inject({ method: "GET", url: `/api/v1/orders/${snapshotOrder}`, headers })
    assert.equal(decoded.statusCode, field === "extension" ? 200 : 500, "Incomplete saved payment snapshots must fail closed")
    if (field === "extension") assert.deepEqual(decoded.json().checkout.entry.paymentMethod, methodSnapshot)
  }
  assert.equal((await transition(competing, "accept")).statusCode, 409, "Acceptance requires checkout")
  await verifyTransitionGuards(app, seed, tenant, product, method)
}
