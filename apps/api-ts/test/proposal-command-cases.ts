import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"
import { verifyProposalPermissions } from "./proposal-permission-cases.js"

export async function verifyProposalCommands(app: FastifyInstance, seed: Pool, tenant: string, role: string) {
  await seed.query(`GRANT DELETE ON sales_proposal_lines TO ${role}`)
  const product = "aa000000-0000-3000-2000-000000000004", headers = { authorization: "Bearer operator", "x-tenant-id": tenant }
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'PROPOSAL','Equipamento original','UN',10001,'active')", [product, tenant])
  const input = { customerId: tenant, validUntil: "2100-01-01", paymentTerms: "  À vista  ", deliveryTerms: "  Retirada  ", notes: "", items: [{ productId: product, quantity: "1.000000", unitPrice: "90.00" }] }
  const key = randomUUID()
  const creates = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/v1/proposals", headers: { ...headers, "idempotency-key": key }, payload: input })))
  for (const response of creates) assert.equal(response.statusCode, 201, response.body)
  assert.deepEqual(creates[0]!.json(), creates[1]!.json())
  const id = creates[0]!.json().data.id as string
  assert.equal(creates[0]!.json().data.paymentTerms, "À vista")
  assert.equal(creates[0]!.json().data.amount, "90.00")
  assert.equal(creates[0]!.json().items[0].productId, product)
  assert.equal(creates[0]!.json().items[0].catalogPrice, "100.01")
  const currentCustomer = creates[0]!.json().data.customerName
  const command = (action: string, revision: number, payload?: unknown, commandKey = randomUUID(), authorization = "Bearer operator") => app.inject({ method: "POST", url: `/api/v1/proposals/${id}/${action}`, headers: { ...headers, authorization, "idempotency-key": commandKey, "if-match": `"${revision}"` }, ...(payload === undefined ? {} : { payload: payload as object }) })
  assert.equal((await command("constructor", 1, {})).statusCode, 404)
  assert.equal((await command("accept", 1, {})).statusCode, 409)
  await seed.query("UPDATE products SET name='Nome atual',price_cents=50000 WHERE tenant_id=$1 AND id=$2", [tenant, product])
  await seed.query("UPDATE parties SET legal_name='Outro nome' WHERE tenant_id=$1 AND id=$1", [tenant])
  const revised = { ...input, items: [{ productId: product, quantity: "2.000000" }] }
  const updated = await app.inject({ method: "PUT", url: `/api/v1/proposals/${id}`, headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' }, payload: revised })
  assert.equal(updated.statusCode, 200, updated.body)
  assert.equal(updated.json().data.amount, "180.00")
  assert.equal(updated.json().data.customerName, currentCustomer)
  assert.equal(updated.json().items[0].name, "Equipamento original")
  const sent = await command("send", 2, {})
  assert.equal(sent.statusCode, 200, sent.body)
  const editSent = await app.inject({ method: "PUT", url: `/api/v1/proposals/${id}`, headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"3"' }, payload: revised })
  assert.equal(editSent.statusCode, 409, editSent.body)
  const reviseKey = randomUUID(), revision = await command("revise", 3, undefined, reviseKey)
  assert.equal(revision.statusCode, 200, revision.body)
  assert.equal(revision.json().data.version, 2)
  assert.equal(revision.json().versions[1].status, "superseded")
  assert.deepEqual((await command("revise", 3, undefined, reviseKey)).json(), revision.json())
  const history = await app.inject({ method: "GET", url: `/api/v1/proposals/${id}?version=1`, headers })
  assert.equal(history.statusCode, 200, history.body)
  assert.equal(history.json().data.isCurrent, false)
  assert.equal(history.json().items[0].unitPrice, "90.00")
  assert.equal((await command("send", 4, {})).statusCode, 200)
  assert.equal((await command("reject", 5, {})).statusCode, 422)
  const acceptKey = randomUUID(), accepted = await command("accept", 5, { reason: " Aceite confirmado " }, acceptKey)
  assert.equal(accepted.statusCode, 200, accepted.body)
  assert.deepEqual((await command("accept", 5, { reason: "Aceite confirmado" }, acceptKey)).json(), accepted.json())
  assert.equal(accepted.json().data.decisionReason, "Aceite confirmado")
  const convertKey = randomUUID()
  const before = (await seed.query("SELECT count(*)::int AS count FROM sales_orders WHERE tenant_id=$1", [tenant])).rows[0].count
  // Fail at the proposal event after inserting an order and its lines; nothing may persist.
  await seed.query(`REVOKE INSERT ON outbox_events FROM ${role}`)
  assert.equal((await command("convert", 6, { dueDate: "2027-01-01" }, convertKey)).statusCode, 500)
  assert.equal((await seed.query("SELECT order_id FROM sales_proposals WHERE id=$1", [id])).rows[0].order_id, null)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM sales_orders WHERE tenant_id=$1", [tenant])).rows[0].count, before)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM domain_commands WHERE command_key=$1", [convertKey])).rows[0].count, 0)
  await seed.query(`GRANT INSERT ON outbox_events TO ${role}`)
  const conversions = await Promise.all([1, 2].map(() => command("convert", 6, { dueDate: "2027-01-01" }, convertKey)))
  for (const response of conversions) assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(conversions[0]!.json(), conversions[1]!.json())
  const order = conversions[0]!.json().data.orderId as string
  const converted = await app.inject({ method: "GET", url: `/api/v1/orders/${order}`, headers })
  assert.equal(converted.statusCode, 200, converted.body)
  assert.equal(converted.json().data.amount, "180.00")
  assert.equal(converted.json().data.customerName, currentCustomer)
  assert.equal(converted.json().items[0].name, "Equipamento original")
  assert.equal(converted.json().items[0].unitPrice, "90.00")
  assert.equal((await command("convert", 7, { dueDate: "2027-01-01" })).statusCode, 409)
  const commandRecord = (await seed.query("SELECT request FROM domain_commands WHERE tenant_id=$1 AND command_key=$2", [tenant, key])).rows[0].request
  assert.equal(commandRecord.id, null)
  assert.equal(commandRecord.revision, null)
  assert.equal(commandRecord.input.items[0].structureColor, null)
  assert.equal(commandRecord.input.items[0].upholsteryColor, null)
  assert.equal(commandRecord.input.items[0].swingArmColor, undefined)
  await verifyProposalPermissions(app, seed, tenant, product)
}
