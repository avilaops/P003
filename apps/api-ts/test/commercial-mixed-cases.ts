import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"
import { commercialFixture } from "./commercial-fixture.js"
import { verifyCommercialTables } from "./commercial-table-cases.js"
import { verifySimulationPermissionReload } from "./simulation-permission-cases.js"

export async function verifyCommercialMixed(app: FastifyInstance, seed: Pool, tenant: string, role: string) {
  const { parameters } = commercialFixture(), items = []
  for (const [index, line] of ["imported", "national"].entries()) {
    const product = index ? randomUUID() : "aa000000-0000-3000-2000-000000000006"
    const version = randomUUID(), price = index ? 17003 : 30001, ipi = index ? 0 : 1300
    const policy = { ...parameters, fixedOrderFeeCents: 101, ipiBps: ipi, minimumDownPaymentBps: index ? 3000 : 7000 }
    await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,$3,'Equipamento misto','UN',$4,'active')", [product, tenant, `MIXED-${index}`, price])
    await seed.query("INSERT INTO product_costs(tenant_id,product_id,product_line,purchase_cost_cents,tax_credit_bps,packaging_cents,revision) VALUES($1,$2,$3,1000,0,0,1)", [tenant, product, line])
    await seed.query("UPDATE commercial_settings SET revision=1,parameters=$3 WHERE tenant_id=$1 AND product_line=$2", [tenant, line, policy])
    await seed.query("INSERT INTO price_table_versions(id,tenant_id,product_line,version,settings_revision,policy_snapshot,calculator_version,digest,published_by) SELECT $1,$2,$3,2,1,$4,'fixture',$5,id FROM identities WHERE auth_subject='operator'", [version, tenant, line, policy, String(index + 3).repeat(64)])
    await seed.query("INSERT INTO price_table_items(tenant_id,version_id,product_id,product_snapshot,cost_revision,cost_snapshot,price_without_ipi_cents,ipi_bps,price_with_ipi_cents) VALUES($1,$2,$3,$4,1,'{\"purchaseCostCents\":1000,\"taxCreditBps\":0,\"packagingCents\":0}',$5,$6,$7)", [tenant, version, product, { sku: `MIXED-${index}`, name: "Equipamento misto", unit: "UN", revision: 1 }, price, ipi, index ? 17003 : 33902])
    await seed.query("UPDATE commercial_settings SET active_price_version_id=$3 WHERE tenant_id=$1 AND product_line=$2", [tenant, line, version])
    items.push({ line, versionId: version, productId: product, quantity: 3 })
  }
  const headers = { authorization: "Bearer operator", "x-tenant-id": tenant }, input = { destinationState: "SP", taxpayer: false, discount: { kind: "percent", value: 0 }, freightCents: 103, items }
  const simulated = await app.inject({ method: "POST", url: "/api/v1/commercial/mixed/simulate", headers, payload: input })
  assert.equal(simulated.statusCode, 200, simulated.body)
  assert.equal(simulated.json().sale.totalCents, 152712)
  assert.equal(simulated.json().sale.ipiBps, null)
  assert.equal(simulated.json().sale.downPaymentCents, 86497)
  assert.equal(simulated.json().director.fixedFeeCents, 101)
  const publicOnly = await app.inject({ method: "POST", url: "/api/v1/commercial/mixed/simulate", headers: { ...headers, authorization: "Bearer commercial-manager" }, payload: input })
  assert.equal(publicOnly.statusCode, 200, publicOnly.body)
  assert.equal(publicOnly.json().director, null)
  assert.equal(publicOnly.json().digest, simulated.json().digest)
  const method = (await seed.query("SELECT id FROM payment_methods WHERE tenant_id=$1 AND status='active' ORDER BY id LIMIT 1", [tenant])).rows[0].id
  const payload = { simulation: input, digest: simulated.json().digest, customerId: tenant, dueDate: "2027-01-01", checkout: { entry: { paymentMethodId: method }, installments: [{ paymentMethodId: method, dueOn: "2027-01-01", amountCents: 66218 }], deliveryNotes: "", paymentNotes: "", notes: "" } }
  const key = randomUUID(), convert = (body: unknown = payload) => app.inject({ method: "POST", url: "/api/v1/commercial/mixed/orders", headers: { ...headers, "idempotency-key": key }, payload: body as object })
  assert.equal((await convert({ ...payload, digest: "outdated" })).statusCode, 412)
  const before = (await seed.query("SELECT count(*)::int AS count FROM sales_orders WHERE tenant_id=$1", [tenant])).rows[0].count
  await seed.query(`REVOKE INSERT ON commercial_order_quote_versions FROM ${role}`)
  assert.equal((await convert()).statusCode, 500)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM sales_orders WHERE tenant_id=$1", [tenant])).rows[0].count, before)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM domain_commands WHERE command_key=$1", [key])).rows[0].count, 0)
  await seed.query(`GRANT INSERT ON commercial_order_quote_versions TO ${role}`)
  const created = await Promise.all([convert(), convert()])
  for (const response of created) assert.equal(response.statusCode, 201, response.body)
  assert.deepEqual(created[0]!.json(), created[1]!.json())
  const order = created[0]!.json().id as string
  const detail = await app.inject({ method: "GET", url: `/api/v1/orders/${order}`, headers })
  assert.equal(detail.json().data.amount, "1527.15")
  assert.deepEqual(detail.json().items.map((item: { productId: string }) => item.productId), items.map(item => item.productId))
  assert.deepEqual(detail.json().items.map((item: { unitPrice: string }) => item.unitPrice), ["339.02", "170.03"])
  assert.equal(detail.json().checkout.installments[0].amountCents, 66218)
  const versions = await seed.query("SELECT product_line FROM commercial_order_quote_versions WHERE tenant_id=$1 AND order_id=$2 ORDER BY product_line", [tenant, order])
  assert.deepEqual(versions.rows.map(row => row.product_line), ["imported", "national"])
  assert.equal((await seed.query("SELECT price_version_id FROM commercial_order_quotes WHERE tenant_id=$1 AND order_id=$2", [tenant, order])).rows[0].price_version_id, null)
  const quote = await app.inject({ method: "GET", url: `/api/v1/commercial/orders/${order}`, headers })
  assert.equal(quote.json().data.kind, "mixed")
  assert.equal(quote.json().director.policyGroups.length, 2)
  await verifySimulationPermissionReload(app, seed, tenant, "/api/v1/commercial/mixed/simulate", input)
  await verifyCommercialTables(app, seed, tenant)
  await seed.query("UPDATE product_costs SET revision=2 WHERE tenant_id=$1 AND product_id=$2", [tenant, items[0]!.productId])
  const stale = await app.inject({ method: "POST", url: "/api/v1/commercial/mixed/simulate", headers, payload: input })
  assert.equal(stale.statusCode, 409, stale.body)
  assert.deepEqual((await convert()).json(), created[0]!.json(), "The original converted result remains replayable after catalog changes")
}
