import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"
import { parseJson } from "../src/platform/json.js"

export async function verifyProposalPermissions(app: FastifyInstance, seed: Pool, tenant: string, product: string) {
  const identity = randomUUID(), membership = randomUUID(), role = randomUUID()
  await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,'proposal-seller','proposals@example.test','Vendedor propostas')", [identity])
  await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [membership, tenant, identity])
  await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'PROPOSALS','Propostas')", [role, tenant])
  await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, role])
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])", [role, ["sales.proposals.read", "sales.proposals.manage", "sales.orders.read", "sales.orders.manage"]])
  const headers = { authorization: "Bearer proposal-seller", "x-tenant-id": tenant }
  const input = { customerId: tenant, validUntil: "2100-01-01", paymentTerms: "À vista", deliveryTerms: "Retirada", notes: "", items: [{ productId: product, quantity: "1.000000" }] }
  const create = (payload: unknown, key = randomUUID()) => app.inject({ method: "POST", url: "/api/v1/proposals", headers: { ...headers, "idempotency-key": key }, payload: payload as object })
  const discounted = await create({ ...input, items: [{ ...input.items[0], unitPrice: "90.00" }] })
  assert.equal(discounted.statusCode, 403, discounted.body)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM sales_proposals p JOIN sales_proposal_versions v ON v.tenant_id=p.tenant_id AND v.proposal_id=p.id WHERE v.created_by='proposal-seller'")).rows[0].count, 0)
  await seed.query("UPDATE products SET plate_holder_colors=ARRAY['Vermelho'] WHERE tenant_id=$1 AND id=$2", [tenant, product])
  const key = randomUUID(), legacy = { ...input, items: [{ ...input.items[0], armColor: " Vermelho " }] }, canonical = { ...input, items: [{ ...input.items[0], plateHolderColor: " Vermelho " }] }
  const created = await create(legacy, key)
  assert.equal(created.statusCode, 201, created.body)
  assert.deepEqual((await create(canonical, key)).json(), created.json())
  const stored = (await seed.query("SELECT request FROM domain_commands WHERE command_key=$1", [key])).rows[0].request
  assert.equal(stored.input.items[0].armColor, undefined)
  assert.equal(stored.input.items[0].plateHolderColor, " Vermelho ")
  const id = created.json().data.id as string
  const action = (name: string, revision: number, payload: unknown = {}) => app.inject({ method: "POST", url: `/api/v1/proposals/${id}/${name}`, headers: { ...headers, "idempotency-key": randomUUID(), "if-match": `"${revision}"` }, payload: payload as object })
  assert.equal((await action("send", 1)).statusCode, 200)
  assert.equal((await action("accept", 2)).statusCode, 403)
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'sales.proposals.decide')", [role])
  await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='sales.proposals.manage'", [role])
  const decided = await action("accept", 2)
  assert.equal(decided.statusCode, 200, decided.body)
  assert.equal(decided.json().canEdit, false, "A decision grant does not grant draft editing")
  assert.equal((await action("convert", 3, { dueDate: "2027-01-01" })).statusCode, 403)
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'sales.proposals.manage')", [role])
  await seed.query("UPDATE products SET unit='KG' WHERE tenant_id=$1 AND id=$2", [tenant, product])
  assert.equal((await action("approve-order", 3, { dueDate: "2027-01-01" })).statusCode, 409)
  await seed.query("UPDATE products SET unit='UN' WHERE tenant_id=$1 AND id=$2", [tenant, product])
  const converted = await action("approve-order", 3, { dueDate: "2027-01-01" })
  assert.equal(converted.statusCode, 200, converted.body)
  assert.ok(converted.json().data.orderId)
  const high = "9007199254740993", expired = await create({ ...input, validUntil: "1900-01-01" })
  assert.equal(expired.statusCode, 201, expired.body)
  const expiredId = expired.json().data.id as string
  for (const name of ["send", "approve-order"]) {
    const response = await app.inject({ method: "POST", url: `/api/v1/proposals/${expiredId}/${name}`, headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' }, payload: name === "send" ? {} : { dueDate: "2027-01-01" } })
    assert.equal(response.statusCode, 409, response.body)
  }
  await seed.query("UPDATE sales_proposals SET revision=$2 WHERE tenant_id=$1 AND id=$3", [tenant, high, expiredId])
  const highKey = randomUUID(), highInput = { ...input, notes: "Revisão exata", validUntil: "2100-01-01" }
  const update = () => app.inject({ method: "PUT", url: `/api/v1/proposals/${expiredId}`, headers: { ...headers, "idempotency-key": highKey, "if-match": `"${high}"` }, payload: highInput })
  const highResponse = await update()
  assert.equal(highResponse.statusCode, 200, highResponse.body)
  assert.equal(highResponse.headers.etag, '"9007199254740994"')
  assert.ok(highResponse.body.includes('"revision":9007199254740994'))
  const replayed = await update()
  assert.ok(replayed.body.includes('"revision":9007199254740994'))
  assert.deepEqual(parseJson(replayed.body), parseJson(highResponse.body))
}
