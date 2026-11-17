import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"
import { commercialFixture } from "./commercial-fixture.js"

export async function verifyCommercialProposals(app: FastifyInstance, seed: Pool) {
  const tenant = randomUUID(), product = randomUUID(), version = randomUUID()
  const { parameters, rules } = commercialFixture()
  const headers = { authorization: "Bearer operator", "x-tenant-id": tenant }
  await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Orçamentos completos','99999999000100')", [tenant])
  await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,email,is_customer,is_supplier,status,addresses) VALUES($1,$1,'fisica','Cliente aprovado','52998224725','customer@example.test',true,false,'active','[{\"state\":\"SP\"}]')", [tenant])
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'COMPLETE','Máquina completa','UN',1256323,'active')", [product, tenant])
  await seed.query("INSERT INTO product_catalog_profiles(tenant_id,product_id,collection,muscle_group,technical_category,dimensions_mm,description,weight,weight_stack,public_path) VALUES($1,$2,'core','Pernas','Bateria de pesos',ARRAY[1500,1200,1400],'Ficha original','150 kg','100 kg','/loja/maquina/')", [tenant, product])
  await seed.query("INSERT INTO commercial_approval_settings(tenant_id,revision,rules) VALUES($1,1,$2)", [tenant, rules])
  await seed.query("INSERT INTO product_costs(tenant_id,product_id,product_line,purchase_cost_cents,tax_credit_bps,packaging_cents,revision) VALUES($1,$2,'national',530606,2780,0,1)", [tenant, product])
  await seed.query("INSERT INTO commercial_settings(tenant_id,product_line,parameters,revision) VALUES($1,'national',$2,1)", [tenant, parameters])
  await seed.query("INSERT INTO price_table_versions(id,tenant_id,product_line,version,settings_revision,policy_snapshot,calculator_version,digest,published_by) SELECT $1,$2,'national',1,1,$3,'fixture',repeat('e',64),id FROM identities WHERE auth_subject='operator'", [version, tenant, parameters])
  await seed.query("INSERT INTO price_table_items(tenant_id,version_id,product_id,product_snapshot,cost_revision,cost_snapshot,price_without_ipi_cents,ipi_bps,price_with_ipi_cents) VALUES($1,$2,$3,$4,1,$5,1256323,1300,1419645)", [tenant, version, product, { sku: "COMPLETE", name: "Máquina completa", unit: "UN", revision: 1 }, { purchaseCostCents: 530606, taxCreditBps: 2780, packagingCents: 0 }])
  await seed.query("UPDATE commercial_settings SET active_price_version_id=$2 WHERE tenant_id=$1 AND product_line='national'", [tenant, version])
  const simulation = { destinationState: "SP", taxpayer: false, discount: { kind: "percent", value: 0 }, freightCents: 0, downPaymentCents: null, items: [{ line: "national", versionId: version, productId: product, quantity: 1, structureColor: null, swingArmColor: null, upholsteryColor: null, plateHolderColor: null, plateHolderType: null }] }
  const quoted = await app.inject({ method: "POST", url: "/api/v1/commercial/mixed/simulate", headers, payload: simulation })
  assert.equal(quoted.statusCode, 200, quoted.body)
  const input = { customerId: tenant, validUntil: "2100-01-01", paymentTerms: "Entrada e saldo", deliveryTerms: "Entrega SP em 45 dias úteis", notes: "Acordo preservado", items: [{ productId: product, quantity: "1.000000", unitPrice: "14196.45" }] }
  const save = (payload: object, key = randomUUID()) => app.inject({ method: "POST", url: "/api/v1/proposals", headers: { ...headers, "idempotency-key": key }, payload })
  const unpriced = await save({ ...input, items: [{ ...input.items[0], unitPrice: "1.00" }] })
  assert.equal(unpriced.statusCode, 409, `Published equipment must not enter an uncalculated proposal: ${unpriced.body}`)
  const commercial = { simulation, digest: quoted.json().digest }
  assert.equal((await save({ ...input, commercial: { ...commercial, digest: "outdated" } })).statusCode, 412)
  assert.equal((await save({ ...input, commercial, items: [{ ...input.items[0], unitPrice: "1.00" }] })).statusCode, 409)
  assert.equal((await save({ ...input, commercial, items: [{ ...input.items[0], quantity: "2.000000" }] })).statusCode, 409)
  const dishonest = { ...simulation, taxpayer: true }
  const dishonestQuote = await app.inject({ method: "POST", url: "/api/v1/commercial/mixed/simulate", headers, payload: dishonest })
  assert.equal((await save({ ...input, commercial: { simulation: dishonest, digest: dishonestQuote.json().digest } })).statusCode, 409, "PF cannot silently use contributor pricing")
  const key = randomUUID(), created = await save({ ...input, commercial }, key)
  assert.equal(created.statusCode, 201, created.body)
  assert.equal(created.json().commercial.sale.totalCents, 1419645)
  assert.equal(created.json().commercial.personType, "fisica")
  assert.equal(created.json().items[0].technical.weightStack, "100 kg")
  assert.deepEqual(created.json().items[0].technical.dimensionsMm, [1500, 1200, 1400])
  const id = created.json().data.id
  const sellerRole = randomUUID(), membership = randomUUID()
  await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) SELECT $1,$2,id FROM identities WHERE auth_subject='proposal-seller'", [membership, tenant])
  await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'COMPLETE_SELLER','Vendedor')", [sellerRole, tenant])
  await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, sellerRole])
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])", [sellerRole, ["sales.proposals.read", "sales.proposals.manage", "sales.proposals.decide", "sales.orders.read", "sales.orders.manage"]])
  const sellerHeaders = { ...headers, authorization: "Bearer proposal-seller" }
  const seller = await app.inject({ url: `/api/v1/proposals/${id}`, headers: sellerHeaders })
  assert.equal(seller.statusCode, 200, seller.body)
  assert.equal(seller.json().director, null)
  assert.ok(!/purchaseCostCents|equipmentCostCents|netProfitCents|taxesCents/.test(seller.body), "Seller must not receive private cost composition")
  const foreignTenant = (await seed.query("SELECT id FROM tenants WHERE id<>$1 LIMIT 1", [tenant])).rows[0].id
  assert.equal((await app.inject({ url: `/api/v1/proposals/${id}`, headers: { ...headers, "x-tenant-id": foreignTenant } })).statusCode, 404, "Other-tenant lookup must not expose a proposal")
  assert.deepEqual((await save({ ...input, commercial }, key)).json(), created.json(), "Lost-response replay keeps the same proposal")
  await seed.query("UPDATE product_catalog_profiles SET weight_stack='120 kg' WHERE tenant_id=$1 AND product_id=$2", [tenant, product])
  const detail = await app.inject({ url: `/api/v1/proposals/${id}`, headers })
  assert.equal(detail.json().items[0].technical.weightStack, "100 kg", "Saved proposal must not adopt later catalogue changes")
  const sent = await app.inject({ method: "POST", url: `/api/v1/proposals/${id}/send`, headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' }, payload: {} })
  assert.equal(sent.statusCode, 200, sent.body)
  await assert.rejects(seed.query("UPDATE sales_proposal_lines SET technical_snapshot='{}' WHERE tenant_id=$1 AND proposal_id=$2", [tenant, id]), /immutable|Published proposal lines/)
  await assert.rejects(seed.query("UPDATE sales_proposal_versions SET commercial_private='{}' WHERE tenant_id=$1 AND proposal_id=$2", [tenant, id]), /immutable/)
}
