import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"

export async function verifyLegacyPricing(app: FastifyInstance, seed: Pool, tenant: string, databaseRole: string) {
  await seed.query(`GRANT UPDATE ON order_pricing_snapshots TO ${databaseRole}`)
  const headers = { authorization: "Bearer operator", "x-tenant-id": tenant }
  const version = (await seed.query("SELECT active_price_version_id FROM commercial_settings WHERE tenant_id=$1 AND product_line='imported'", [tenant])).rows[0].active_price_version_id
  const create = async (snapshot = true, status = "draft") => {
    const id = randomUUID()
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725',CURRENT_DATE,10000,$3)", [id, tenant, status])
    if (snapshot) await seed.query("INSERT INTO order_pricing_snapshots(tenant_id,order_id,version_id,snapshot,needs_approval) VALUES($1,$2,$3,'{\"sale\":{\"totalCents\":10000},\"director\":{\"profitCents\":2000}}',true)", [tenant, id, version])
    return id
  }
  const id = await create(), url = `/api/v1/orders/${id}/pricing`
  const low = { ...headers, authorization: "Bearer commercial-manager" }
  const publicView = await app.inject({ method: "GET", url, headers: low })
  assert.equal(publicView.statusCode, 200, publicView.body)
  assert.equal(publicView.headers.etag, '"1"')
  assert.deepEqual(publicView.json().data, { snapshot: { sale: { totalCents: 10000 } }, needsApproval: true, approved: false })
  assert.equal(publicView.json().canApprove, false)
  const privateView = await app.inject({ method: "GET", url, headers })
  assert.deepEqual(privateView.json().data.snapshot.director, { profitCents: 2000 })
  assert.equal(privateView.json().canApprove, true)
  const absent = await app.inject({ method: "GET", url: `/api/v1/orders/${await create(false)}/pricing`, headers })
  assert.equal(absent.statusCode, 200, absent.body)
  assert.equal(absent.json().data, null)
  assert.equal((await app.inject({ method: "GET", url: `/api/v1/orders/${randomUUID()}/pricing`, headers })).statusCode, 404)
  const managerRole = (await seed.query("SELECT role_id FROM membership_roles mr JOIN tenant_memberships m ON m.id=mr.membership_id JOIN identities i ON i.id=m.identity_id WHERE i.auth_subject='commercial-manager'")).rows[0].role_id
  const approve = (key = randomUUID(), revision = 1, reason = "  Exceção legada revisada  ") => app.inject({ method: "POST", url: `${url}/approve`, headers: { ...low, "if-match": `"${revision}"`, "idempotency-key": key }, payload: { reason } })
  assert.equal((await approve()).statusCode, 403)
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'platform.company.manage')", [managerRole])
  const managerView = await app.inject({ method: "GET", url, headers: low })
  assert.equal(managerView.json().canApprove, true)
  assert.equal(managerView.json().data.snapshot.director, undefined, "Company management alone must not disclose the director snapshot")
  for (const reason of ["ab", "ab\nc", "a".repeat(2001)]) assert.equal((await approve(randomUUID(), 1, reason)).statusCode, 422)
  const key = randomUUID()
  await seed.query(`REVOKE INSERT ON outbox_events FROM ${databaseRole}`)
  assert.equal((await approve(key)).statusCode, 500)
  assert.equal((await seed.query("SELECT approved_by FROM order_pricing_snapshots WHERE order_id=$1", [id])).rows[0].approved_by, null)
  await seed.query(`GRANT INSERT ON outbox_events TO ${databaseRole}`)
  const approved = await Promise.all([1, 2].map(() => approve(key)))
  for (const response of approved) { assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers.etag, '"2"') }
  assert.deepEqual(approved[0]!.json(), approved[1]!.json())
  assert.equal((await seed.query("SELECT approval_reason FROM order_pricing_snapshots WHERE order_id=$1", [id])).rows[0].approval_reason, "Exceção legada revisada")
  assert.equal((await approve(randomUUID(), 1)).statusCode, 412)
  assert.equal((await approve(randomUUID(), 2)).statusCode, 409)
  await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='platform.company.manage'", [managerRole])
  assert.equal((await approve(key)).statusCode, 403, "Revocation must precede command replay")
}
