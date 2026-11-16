import assert from "node:assert/strict"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"

export async function verifyCommercialTables(app: FastifyInstance, seed: Pool, tenant: string) {
  const headers = { authorization: "Bearer operator", "x-tenant-id": tenant }
  const get = (query = "", authorization = headers.authorization) => app.inject({ method: "GET", url: `/api/v1/commercial/tables/national${query}`, headers: { ...headers, authorization } })
  const actual = await get()
  assert.equal(actual.statusCode, 200, actual.body)
  assert.equal(actual.json().data.availability.status, "ready")
  assert.equal(actual.json().data.context.destinationState, "SP")
  assert.equal(actual.json().data.context.taxpayer, false)
  assert.equal(actual.json().authority, "director")
  assert.equal(actual.json().data.destinations.length, 54)
  assert.equal(actual.json().data.items[0].available, true)
  assert.equal(actual.json().data.items[0].priceWithIpiCents, 17003)
  assert.ok(actual.json().data.items[0].maxOwnDiscountBps > 2000)
  for (const key of ["purchaseCents", "equipmentCostCents", "netProfitCents", "supplierPaymentCents", "fixedFeeCents"]) assert.ok(!actual.body.includes(key), `Table response must not expose ${key}`)
  assert.deepEqual(Object.keys(actual.json().paymentMethods[0]).sort(), ["id", "kind", "name"])
  const seller = await get("", "Bearer transition-seller")
  assert.equal(seller.statusCode, 200, seller.body)
  assert.equal(seller.json().authority, "seller")
  assert.equal(seller.json().data.items[0].maxOwnDiscountBps, 2000)
  const manager = await get("?destinationState=MG&taxpayer=true", "Bearer commercial-manager")
  assert.equal(manager.statusCode, 200, manager.body)
  assert.ok(["managerProfit", "managerTarget"].includes(manager.json().authority))
  assert.equal(manager.json().canCreateOrder, false)
  assert.equal(manager.json().data.context.destinationState, "MG")
  assert.equal(manager.json().data.context.taxpayer, true)
  for (const query of ["?destinationState=sp", "?taxpayer=1", "?unknown=1", "?taxpayer=true&taxpayer=false"]) assert.equal((await get(query)).statusCode, 422)
  const rules = (await seed.query("SELECT revision,rules FROM commercial_approval_settings WHERE tenant_id=$1", [tenant])).rows[0]
  await seed.query("DELETE FROM commercial_approval_settings WHERE tenant_id=$1", [tenant])
  const missing = await get()
  assert.equal(missing.statusCode, 200, missing.body)
  assert.equal(missing.json().data.availability.status, "rulesMissing")
  assert.equal(missing.json().data.items[0].maxOwnDiscountBps, null)
  await seed.query("INSERT INTO commercial_approval_settings(tenant_id,revision,rules) VALUES($1,$2,$3)", [tenant, rules.revision, rules.rules])
  await seed.query("UPDATE commercial_settings SET revision=2 WHERE tenant_id=$1 AND product_line='national'", [tenant])
  const stale = await get()
  assert.equal(stale.json().data.availability.status, "settingsStale")
  assert.equal(stale.json().data.items[0].available, false)
  await seed.query("UPDATE commercial_settings SET revision=1 WHERE tenant_id=$1 AND product_line='national'", [tenant])
  const product = actual.json().data.items[0].productId as string
  await seed.query("UPDATE product_costs SET revision=2 WHERE tenant_id=$1 AND product_id=$2", [tenant, product])
  const unavailable = await get()
  assert.equal(unavailable.json().data.availability.status, "itemsUnavailable")
  assert.equal(unavailable.json().data.items[0].freeDiscountPriceWithIpiCents, null)
  await seed.query("UPDATE product_costs SET revision=1 WHERE tenant_id=$1 AND product_id=$2", [tenant, product])

  // A read waiting for the shared tenant lock must reload rights after access changes.
  const locked = await seed.connect()
  let pending: Promise<{ statusCode: number }> | undefined
  try {
    await locked.query("BEGIN")
    await locked.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenant])
    pending = Promise.resolve(get("", "Bearer commercial-manager"))
    const deadline = Date.now() + 5000
    let observed = false
    while (Date.now() < deadline) {
      if ((await seed.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT id FROM tenants WHERE id=$1 FOR SHARE') AS waiting")).rows[0].waiting) { observed = true; break }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(observed)
    await locked.query("DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE tenant_id=$1 AND code='APPROVER') AND permission_code='sales.orders.read'", [tenant])
    await locked.query("COMMIT")
    assert.equal((await pending).statusCode, 403)
  } finally {
    await locked.query("ROLLBACK"); locked.release()
    if (pending) await pending
  }
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT id,'sales.orders.read' FROM roles WHERE tenant_id=$1 AND code='APPROVER'", [tenant])
}
