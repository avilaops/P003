import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"

export async function verifyCommercialApprovals(app: FastifyInstance, seed: Pool, tenant: string, databaseRole: string, backend = "typescript") {
  const headers = { authorization: "Bearer operator", "x-tenant-id": tenant }, settings = "/api/v1/commercial/approval-settings"
  const defaults = await app.inject({ method: "GET", url: settings, headers })
  assert.equal(defaults.statusCode, 200, defaults.body)
  assert.equal(defaults.headers.etag, '"1"')
  assert.equal(defaults.json().data, null)
  const rules = { belowTarget: true, freight: true, directorAutoApproval: false, managerLimit: "profit" }
  const writes = await Promise.all(["profit", "target"].map(managerLimit => app.inject({ method: "PUT", url: settings, headers: { ...headers, "if-match": '"1"' }, payload: { ...rules, managerLimit } })))
  assert.deepEqual(writes.map(response => response.statusCode).sort(), [200, 412])
  assert.equal((await app.inject({ method: "PUT", url: settings, headers: { ...headers, "if-match": '"2"' }, payload: { ...rules, unknown: true } })).statusCode, 422)
  const identity = randomUUID(), membership = randomUUID(), role = randomUUID()
  await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,'commercial-manager','manager@example.test','Gerente')", [identity])
  await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [membership, tenant, identity])
  await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'APPROVER','Aprovação')", [role, tenant])
  await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, role])
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'sales.orders.read'),($1,'sales.approvals.manage')", [role])
  const managerHeaders = { ...headers, authorization: "Bearer commercial-manager" }
  assert.equal((await app.inject({ method: "GET", url: settings, headers: managerHeaders })).statusCode, 403)
  const version = (await seed.query("SELECT active_price_version_id FROM commercial_settings WHERE tenant_id=$1 AND product_line='imported'", [tenant])).rows[0].active_price_version_id
  const issuer = (await seed.query("SELECT id FROM identities WHERE auth_subject='operator'")).rows[0].id
  const create = async (director: boolean) => {
    const id = randomUUID()
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725',CURRENT_DATE,10000,'draft')", [id, tenant])
    await seed.query("INSERT INTO commercial_order_quotes(tenant_id,order_id,price_version_id,public_snapshot,private_snapshot,approval_rules,approval_status,requires_director,created_by) VALUES($1,$2,$3,'{\"totalCents\":10000}','{\"director\":{\"netProfitCents\":1000}}','{}','pending',$4,$5)", [tenant, id, version, director, issuer])
    return id
  }
  const order = await create(false), url = `/api/v1/commercial/orders/${order}`
  // The requester-cannot-approve rule is enforced by the TypeScript API only; the frozen Rust backend keeps the legacy decision rule.
  if (backend !== "rust") {
    const own = await app.inject({ method: "POST", url: url+"/decision", headers: { ...headers, "if-match": '"1"', "idempotency-key": randomUUID() }, payload: { approved: true, reason: "Própria solicitação" } })
    assert.equal(own.statusCode, 403)
  }
  const snapshot = await app.inject({ method: "GET", url, headers: managerHeaders })
  assert.equal(snapshot.statusCode, 200, snapshot.body)
  assert.equal(snapshot.json().canApprove, true)
  assert.equal(snapshot.json().director, null)
  assert.deepEqual(snapshot.json().data, { totalCents: 10000 })
  assert.equal(snapshot.json().checkout, null)
  const privileged = await app.inject({ method: "GET", url, headers })
  assert.deepEqual(privileged.json().director, { netProfitCents: 1000 })
  const key = randomUUID(), decide = () => app.inject({ method: "POST", url: `${url}/decision`, headers: { ...managerHeaders, "if-match": '"1"', "idempotency-key": key }, payload: { approved: true, reason: " Aprovação explícita " } })
  await seed.query(`REVOKE INSERT ON commercial_approval_decisions FROM ${databaseRole}`)
  assert.equal((await decide()).statusCode, 500)
  assert.equal((await seed.query("SELECT approval_status FROM commercial_order_quotes WHERE tenant_id=$1 AND order_id=$2", [tenant, order])).rows[0].approval_status, "pending")
  await seed.query(`GRANT INSERT ON commercial_approval_decisions TO ${databaseRole}`)
  const responses = await Promise.all([decide(), decide()])
  for (const response of responses) assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(responses[0]!.json(), responses[1]!.json())
  assert.equal(responses[0]!.headers.etag, '"2"')
  const decided = await app.inject({ method: "GET", url, headers: managerHeaders })
  assert.equal(decided.json().decisions.length, 1)
  assert.equal(decided.json().decisions[0].decidedBy, "Gerente")
  assert.equal(decided.json().decisions[0].reason, "Aprovação explícita")
  await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='sales.approvals.manage'", [role])
  assert.equal((await decide()).statusCode, 403, "Revocation must apply before replay")
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'sales.approvals.manage')", [role])
  const restricted = await create(true)
  const directorOnly = await app.inject({ method: "POST", url: `/api/v1/commercial/orders/${restricted}/decision`, headers: { ...managerHeaders, "if-match": '"1"', "idempotency-key": randomUUID() }, payload: { approved: false, reason: "Fora da alçada" } })
  assert.equal(directorOnly.statusCode, 403, directorOnly.body)
  const unknown = await app.inject({ method: "GET", url: `/api/v1/commercial/orders/${randomUUID()}`, headers: managerHeaders })
  assert.equal(unknown.statusCode, 200)
  assert.equal(unknown.json().data, null)
  assert.equal(unknown.headers.etag, undefined)
}
