import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"

export async function verifyOpportunities(app: FastifyInstance, seed: Pool, tenant: string, role: string) {
  const headers = { authorization: "Bearer operator", "x-tenant-id": tenant }, key = randomUUID(), url = "/api/v1/opportunities"
  const input = { title: " OPPORTUNITY • academia ", estimatedCents: 10000, stage: "new", companyName: "Empresa", companyTaxId: "04.252.011/0001-10", contactName: "Contato", phone: "", email: "contact@example.test", source: "Indicação", notes: "Primeira linha\nSegunda linha" }
  const create = (payload: unknown = input, command = key) => app.inject({ method: "POST", url, headers: { ...headers, "idempotency-key": command }, payload: payload as object })
  const creates = await Promise.all([create(), create()])
  for (const response of creates) assert.equal(response.statusCode, 201, response.body)
  assert.deepEqual(creates[0]!.json(), creates[1]!.json())
  const id = creates[0]!.json().data.id as string
  assert.equal(creates[0]!.json().data.title, input.title)
  assert.equal(creates[0]!.json().data.customerId, null)
  const second = await create({ ...input, title: "Outra negociação", stage: "proposed", estimatedCents: 20000 }, randomUUID())
  assert.equal(second.statusCode, 201, second.body)
  const list = await app.inject({ method: "GET", url: `${url}?q=OPPORTUNITY&stage=new`, headers })
  assert.equal(list.statusCode, 200, list.body)
  assert.equal(list.json().total, 1)
  assert.equal(list.json().limit, 100)
  assert.equal(list.json().totals.find((value: { stage: string }) => value.stage === "proposed").estimatedCents, 20000)
  const edit = (name: string, revision = '"1"', payload: object = {}) => app.inject({ method: "PUT", url: `${url}/${id}`, headers: { ...headers, "if-match": revision, "idempotency-key": randomUUID() }, payload: { ...input, title: name, stage: "contacted", ...payload } })
  const edits = await Promise.all([edit("Editor A"), edit("Editor B")])
  assert.deepEqual(edits.map(response => response.statusCode).sort(), [200, 412])
  const detail = await app.inject({ method: "GET", url: `${url}/${id}`, headers })
  assert.equal(detail.statusCode, 200, detail.body)
  assert.equal(detail.headers.etag, '"2"')
  const order = (await seed.query("SELECT id FROM sales_orders WHERE tenant_id=$1 ORDER BY id LIMIT 1", [tenant])).rows[0].id
  await seed.query("UPDATE sales_opportunities SET customer_id=$3,order_id=$4 WHERE tenant_id=$1 AND id=$2", [tenant, id, tenant, order])
  const changedCustomer = await edit("Troca do cliente", '"2"')
  assert.equal(changedCustomer.statusCode, 409, changedCustomer.body)
  const preserved = await edit("Cliente preservado", '"2"', { customerId: tenant })
  assert.equal(preserved.statusCode, 200, preserved.body)
  assert.equal(preserved.json().data.orderId, order)
  for (const invalid of [{ title: " " }, { companyName: " " }, { companyTaxId: "11111111111111" }, { email: "com espaço@example.test" }, { notes: "Texto\tinválido" }, { estimatedCents: 100000000000000 }, { unknown: true }]) assert.equal((await create({ ...input, ...invalid }, randomUUID())).statusCode, 422)
  for (const query of ["?q=middle%00control", "?stage=invalid", "?offset=1.0", "?limit=0"]) assert.equal((await app.inject({ method: "GET", url: `${url}${query}`, headers })).statusCode, 422)
  const failedKey = randomUUID()
  await seed.query(`REVOKE INSERT ON outbox_events FROM ${role}`)
  assert.equal((await create({ ...input, title: "Rollback oportunidade" }, failedKey)).statusCode, 500)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM sales_opportunities WHERE tenant_id=$1 AND data->>'title'='Rollback oportunidade'", [tenant])).rows[0].count, 0)
  await seed.query(`GRANT INSERT ON outbox_events TO ${role}`)
  const events = (await seed.query("SELECT count(*)::int AS count FROM outbox_events WHERE tenant_id=$1 AND aggregate_id=$2", [tenant, id])).rows[0].count
  assert.equal(events, 3)
}
