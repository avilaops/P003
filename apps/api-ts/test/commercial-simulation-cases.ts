import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"
import { commercialFixture } from "./commercial-fixture.js"

export async function verifyCommercialSimulation(app: FastifyInstance, seed: Pool, tenant: string) {
  const { parameters, input } = commercialFixture(), product = randomUUID(), version = randomUUID()
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'SIMULATOR','Simulador','UN',1256323,'active')", [product, tenant])
  await seed.query("INSERT INTO product_costs(tenant_id,product_id,product_line,purchase_cost_cents,tax_credit_bps,packaging_cents,revision) VALUES($1,$2,'national',530606,2780,0,1)", [tenant, product])
  await seed.query("INSERT INTO commercial_settings(tenant_id,product_line,parameters,revision) VALUES($1,'national',$2,1)", [tenant, parameters])
  await seed.query("INSERT INTO price_table_versions(id,tenant_id,product_line,version,settings_revision,policy_snapshot,calculator_version,digest,published_by) SELECT $1,$2,'national',1,1,$3,'fixture',repeat('b',64),id FROM identities WHERE auth_subject='operator'", [version, tenant, parameters])
  await seed.query("INSERT INTO price_table_items(tenant_id,version_id,product_id,product_snapshot,cost_revision,cost_snapshot,price_without_ipi_cents,ipi_bps,price_with_ipi_cents) VALUES($1,$2,$3,$4,1,$5,1256323,1300,1419645)", [tenant, version, product, { sku: "SIMULATOR", name: "Simulador", unit: "UN", revision: 1 }, { purchaseCostCents: 530606, taxCreditBps: 2780, packagingCents: 0 }])
  await seed.query("UPDATE commercial_settings SET active_price_version_id=$2 WHERE tenant_id=$1 AND product_line='national'", [tenant, version])
  const headers = { authorization: "Bearer commercial-manager", "x-tenant-id": tenant }
  input.line = "national"; input.versionId = version; input.items[0]!.productId = product
  const simulate = (payload: unknown = input, authorization = headers.authorization) => app.inject({ method: "POST", url: "/api/v1/commercial/simulate", headers: { ...headers, authorization }, payload: payload as object })
  const response = await simulate()
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().sale.totalCents, 1419645)
  assert.equal(response.json().director, null)
  assert.match(response.json().digest, /^[a-f0-9]{64}$/)
  const privileged = await simulate(input, "Bearer operator")
  assert.equal(privileged.statusCode, 200, privileged.body)
  assert.equal(privileged.json().digest, response.json().digest)
  assert.equal(privileged.json().director.taxBps, 3225)
  assert.deepEqual((await simulate()).json(), response.json())
  assert.equal((await simulate({ ...input, versionId: randomUUID() })).statusCode, 412)
  assert.equal((await simulate({ ...input, items: [{ ...input.items[0], quantity: 0 }] })).statusCode, 422)
  assert.equal((await simulate({ ...input, unknown: true })).statusCode, 422)
  await seed.query("UPDATE commercial_approval_settings SET revision=revision+1 WHERE tenant_id=$1", [tenant])
  const changedRules = await simulate()
  assert.equal(changedRules.statusCode, 200, changedRules.body)
  assert.notEqual(changedRules.json().digest, response.json().digest, "The digest includes the approval revision even when totals stay equal")
  await seed.query("UPDATE product_costs SET revision=2 WHERE tenant_id=$1 AND product_id=$2", [tenant, product])
  assert.equal((await simulate()).statusCode, 409)
  await seed.query("UPDATE product_costs SET revision=1 WHERE tenant_id=$1 AND product_id=$2", [tenant, product])
  await seed.query("UPDATE commercial_settings SET revision=2 WHERE tenant_id=$1 AND product_line='national'", [tenant])
  assert.equal((await simulate()).statusCode, 409)
  await seed.query("UPDATE commercial_settings SET revision=1 WHERE tenant_id=$1 AND product_line='national'", [tenant])
  await seed.query("UPDATE products SET price_cents=1256324 WHERE tenant_id=$1 AND id=$2", [tenant, product])
  assert.equal((await simulate()).statusCode, 409)
}
