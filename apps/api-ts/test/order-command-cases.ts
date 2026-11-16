import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"

export async function verifyOrderCommands(app: FastifyInstance, seed: Pool, tenant: string, role: string) {
  await seed.query(`GRANT DELETE ON sales_order_lines TO ${role}`)
  const product = randomUUID()
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'ORDER-ITEM','Item original','UN',10001,'active')", [product, tenant])
  const headers = { authorization: "Bearer operator", "x-tenant-id": tenant }
  const input = { customerId: tenant, dueDate: "2027-01-01", items: [{ productId: product, quantity: "1.234567" }] }
  const key = randomUUID()
  const creates = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...headers, "idempotency-key": key }, payload: input })))
  for (const response of creates) assert.equal(response.statusCode, 201, response.body)
  assert.deepEqual(creates[0]!.json(), creates[1]!.json())
  const order = creates[0]!.json().data.id as string
  assert.equal(creates[0]!.json().data.amount, "123.47")
  assert.equal(creates[0]!.json().data.status, "draft")
  assert.match(String(creates[0]!.headers["x-request-id"]), /^[a-f0-9-]{36}$/)
  const audit = (await seed.query("SELECT request_id FROM audit_log WHERE entity_id=$1", [order])).rows
  assert.equal(audit.length, 1)
  assert.ok(creates.some(response => response.headers["x-request-id"] === audit[0].request_id), "Command audit must retain the identifier returned for the original request")
  await seed.query("UPDATE products SET name='Nome novo',price_cents=999999 WHERE id=$1", [product])
  await seed.query("UPDATE parties SET legal_name='Cliente renomeado' WHERE id=$1", [tenant])
  const revised = { ...input, items: [{ productId: product, quantity: "2.000000" }] }
  const updateKey = randomUUID()
  const update = () => app.inject({ method: "PUT", url: `/api/v1/orders/${order}`, headers: { ...headers, "idempotency-key": updateKey, "if-match": '"1"' }, payload: revised })
  const changed = await update()
  assert.equal(changed.statusCode, 200, changed.body)
  assert.equal(changed.headers.etag, '"2"')
  assert.equal(changed.json().data.amount, "200.02")
  assert.equal(changed.json().data.customerName, "Cliente")
  assert.equal(changed.json().items[0].name, "Item original")
  assert.equal(changed.json().items[0].unitPrice, "100.01")
  const repeated = await update()
  assert.equal(repeated.statusCode, 200, repeated.body)
  assert.equal(repeated.headers["idempotency-replayed"], "true")
  assert.deepEqual(repeated.json(), changed.json())
  const stale = await app.inject({ method: "PUT", url: `/api/v1/orders/${order}`, headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' }, payload: revised })
  assert.equal(stale.statusCode, 412, stale.body)
  await seed.query("UPDATE products SET unit='KG' WHERE id=$1", [product])
  const incompatible = await app.inject({ method: "PUT", url: `/api/v1/orders/${order}`, headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"2"' }, payload: revised })
  assert.equal(incompatible.statusCode, 409, incompatible.body)
  const evidence = await seed.query("SELECT (SELECT count(*)::int FROM audit_log WHERE entity_id=$1) AS audits,(SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$1) AS events", [order])
  assert.deepEqual(evidence.rows[0], { audits: 2, events: 2 })
  await seed.query("UPDATE products SET unit='UN' WHERE id=$1", [product])
  await seed.query("UPDATE sales_orders SET status='cancelled' WHERE id=$1", [order])
  const edit = () => app.inject({ method: "PUT", url: `/api/v1/orders/${order}`, headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"2"' }, payload: revised })
  assert.equal((await edit()).statusCode, 409)
  await seed.query("UPDATE sales_orders SET status='draft' WHERE id=$1", [order])
  await seed.query("INSERT INTO sales_order_checkouts(tenant_id,order_id,customer_snapshot,entry_amount_cents,delivery_notes,payment_notes,notes) VALUES($1,$2,'{}',0,'','','')", [tenant, order])
  const preservedCheckout = await edit()
  assert.equal(preservedCheckout.statusCode, 409, preservedCheckout.body)
  const version = randomUUID()
  await seed.query("INSERT INTO commercial_settings(tenant_id,product_line,parameters,revision) VALUES($1,'imported','{}',1)", [tenant])
  await seed.query("INSERT INTO price_table_versions(id,tenant_id,product_line,version,settings_revision,policy_snapshot,calculator_version,digest,published_by) SELECT $1,$2,'imported',1,1,'{}','fixture',repeat('a',64),id FROM identities WHERE auth_subject='operator'", [version, tenant])
  await seed.query("INSERT INTO price_table_items(tenant_id,version_id,product_id,product_snapshot,cost_revision,cost_snapshot,price_without_ipi_cents,ipi_bps,price_with_ipi_cents) VALUES($1,$2,$3,'{}',1,'{}',10001,0,10001)", [tenant, version, product])
  await seed.query("UPDATE commercial_settings SET active_price_version_id=$2 WHERE tenant_id=$1 AND product_line='imported'", [tenant, version])
  const published = await app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...headers, "idempotency-key": randomUUID() }, payload: input })
  assert.equal(published.statusCode, 409, published.body)
  await seed.query("INSERT INTO order_pricing_snapshots(tenant_id,order_id,version_id,snapshot,needs_approval) VALUES($1,$2,$3,'{}',false)", [tenant, order, version])
  const guardedReplay = await update()
  assert.equal(guardedReplay.statusCode, 409, guardedReplay.body)
}
