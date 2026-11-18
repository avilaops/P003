import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"
import { commercialFixture } from "./commercial-fixture.js"

export async function verifyCommercialProposals(app: FastifyInstance, seed: Pool, databaseRole: string) {
  const tenant = randomUUID(), product = "aa000000-0000-3000-2000-000000000007", version = randomUUID()
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
  const colored = {...simulation.items[0]!, structureColor: "Preto"}
  const refusedMixed = await app.inject({method: "POST", url: "/api/v1/commercial/mixed/simulate", headers, payload: {...simulation, items: [colored]}})
  assert.equal(refusedMixed.statusCode, 422, refusedMixed.body)
  const {line, versionId, ...coloredItem} = colored
  const refusedSingle = await app.inject({method: "POST", url: "/api/v1/commercial/simulate", headers, payload: {...simulation, line, versionId, items: [coloredItem]}})
  assert.equal(refusedSingle.statusCode, 422, refusedSingle.body)
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
  assert.equal(created.json().items[0].productId, product)
  assert.equal(created.json().items[0].technical.weightStack, "100 kg")
  assert.deepEqual(created.json().items[0].technical.dimensionsMm, [1500, 1200, 1400])
  const removedProfile = (await seed.query("DELETE FROM product_catalog_profiles c WHERE tenant_id=$1 AND product_id=$2 RETURNING to_jsonb(c) AS data", [tenant, product])).rows[0].data
  const unknownTechnical = await save({ ...input, commercial })
  assert.equal(unknownTechnical.statusCode, 201, unknownTechnical.body)
  assert.ok(unknownTechnical.json().items[0].technical, "New quoted equipment without a profile must freeze unknown technical data")
  const unknownId = unknownTechnical.json().data.id
  await seed.query("UPDATE sales_proposal_lines SET technical_snapshot=NULL WHERE tenant_id=$1 AND proposal_id=$2", [tenant, unknownId])
  const unknownConversion = await app.inject({ method: "POST", url: `/api/v1/proposals/${unknownId}/approve-order`, headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' }, payload: { dueDate: "2027-01-01" } })
  assert.equal(unknownConversion.statusCode, 200, unknownConversion.body)
  await seed.query("INSERT INTO product_catalog_profiles SELECT (jsonb_populate_record(NULL::product_catalog_profiles,$1::jsonb)).*", [removedProfile])
  const unknownOrder = await app.inject({ url: `/api/v1/orders/${unknownConversion.json().data.orderId}`, headers })
  assert.equal(unknownOrder.json().items[0].equipmentWeight, null, "Previously unknown quoted data must not adopt a profile added later")
  const id = created.json().data.id
  const sellerRole = randomUUID(), membership = randomUUID()
  await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) SELECT $1,$2,id FROM identities WHERE auth_subject='proposal-seller'", [membership, tenant])
  await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'COMPLETE_SELLER','Vendedor')", [sellerRole, tenant])
  await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, sellerRole])
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])", [sellerRole, ["sales.proposals.read", "sales.proposals.manage", "sales.proposals.decide", "sales.orders.read", "sales.orders.manage"]])
  const sellerHeaders = { ...headers, authorization: "Bearer proposal-seller" }
  const privatePermissions = ["platform.company.manage", "sales.approvals.director"]
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])", [sellerRole, privatePermissions])
  const replayCreateKey = randomUUID(), replayUpdateKey = randomUUID(), replaySendKey = randomUUID()
  const replayBody = { ...input, commercial }
  const requestReplay = (method: "POST" | "PUT", url: string, key: string, payload: object, revision?: string) => app.inject({ method, url, headers: { ...sellerHeaders, "idempotency-key": key, ...(revision ? { "if-match": revision } : {}) }, payload })
  const privateCreate = await requestReplay("POST", "/api/v1/proposals", replayCreateKey, replayBody)
  assert.equal(privateCreate.statusCode, 201, privateCreate.body)
  assert.ok(privateCreate.json().director?.equipmentCostCents)
  const replayId = privateCreate.json().data.id
  const privateUpdate = await requestReplay("PUT", `/api/v1/proposals/${replayId}`, replayUpdateKey, replayBody, '"1"')
  assert.equal(privateUpdate.statusCode, 200, privateUpdate.body)
  const privateSend = await requestReplay("POST", `/api/v1/proposals/${replayId}/send`, replaySendKey, {}, '"2"')
  assert.equal(privateSend.statusCode, 200, privateSend.body)
  for (const permission of privatePermissions) {
    await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code=$2", [sellerRole, permission])
    const replays = [await requestReplay("POST", "/api/v1/proposals", replayCreateKey, replayBody), await requestReplay("PUT", `/api/v1/proposals/${replayId}`, replayUpdateKey, replayBody, '"1"'), await requestReplay("POST", `/api/v1/proposals/${replayId}/send`, replaySendKey, {}, '"2"')]
    for (const response of replays) {
      assert.ok(response.statusCode === 200 || response.statusCode === 201, response.body)
      assert.equal(response.json().director, null, "Replay must reapply current financial permissions")
      assert.ok(!/equipmentCostCents|netProfitCents/.test(response.body))
    }
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)", [sellerRole, permission])
  }
  await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code=ANY($2::text[])", [sellerRole, privatePermissions])
  await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='sales.orders.read'", [sellerRole])
  const proposalOnlyTable = await app.inject({ url: "/api/v1/commercial/tables/national", headers: sellerHeaders })
  assert.equal(proposalOnlyTable.statusCode, 200, "Proposal managers can price proposals without order-read permission")
  const proposalOnlySimulation = await app.inject({ method: "POST", url: "/api/v1/commercial/mixed/simulate", headers: sellerHeaders, payload: simulation })
  assert.equal(proposalOnlySimulation.statusCode, 200, proposalOnlySimulation.body)
  assert.equal(proposalOnlySimulation.json().director, null)
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'sales.orders.read')", [sellerRole])
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
  const convert = (key = randomUUID()) => app.inject({ method: "POST", url: `/api/v1/proposals/${id}/approve-order`, headers: { ...headers, "idempotency-key": key, "if-match": '"2"' }, payload: { dueDate: "2027-01-01" } })
  await seed.query("UPDATE parties SET revision=2 WHERE tenant_id=$1 AND id=$1", [tenant])
  assert.equal((await convert()).statusCode, 409, "A changed customer must be reviewed before approving the old agreement")
  await seed.query("UPDATE parties SET revision=1 WHERE tenant_id=$1 AND id=$1", [tenant])
  await seed.query("UPDATE commercial_settings SET revision=2 WHERE tenant_id=$1 AND product_line='national'", [tenant])
  assert.equal((await convert()).statusCode, 409, "A stale published policy must not be formalized")
  await seed.query("UPDATE commercial_settings SET revision=1 WHERE tenant_id=$1 AND product_line='national'", [tenant])
  const before = (await seed.query("SELECT count(*)::int AS count FROM sales_orders WHERE tenant_id=$1", [tenant])).rows[0].count
  await seed.query(`REVOKE INSERT ON commercial_order_quotes FROM ${databaseRole}`)
  const failed = await convert()
  assert.equal(failed.statusCode, 500, failed.body)
  assert.equal((await seed.query("SELECT order_id FROM sales_proposals WHERE id=$1", [id])).rows[0].order_id, null)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM sales_orders WHERE tenant_id=$1", [tenant])).rows[0].count, before)
  await seed.query(`GRANT INSERT ON commercial_order_quotes TO ${databaseRole}`)
  const conversionKey = randomUUID(), converted = await Promise.all([convert(conversionKey), convert(conversionKey)])
  for (const response of converted) assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(converted[0].json(), converted[1].json())
  const orderId = converted[0].json().data.orderId
  const orderQuote = await app.inject({ url: `/api/v1/commercial/orders/${orderId}`, headers })
  assert.equal(orderQuote.statusCode, 200, orderQuote.body)
  assert.equal(orderQuote.json().data.sale.totalCents, 1419645)
  assert.equal(orderQuote.json().approvalStatus, "not_required")
  const order = await app.inject({ url: `/api/v1/orders/${orderId}`, headers })
  assert.equal(order.json().pricingOrigin, true)
  assert.equal(order.json().items[0].unitPrice, "14196.45")
  await seed.query("UPDATE product_catalog_profiles SET weight='180 kg' WHERE tenant_id=$1 AND product_id=$2", [tenant, product])
  const frozenOrder = await app.inject({ url: `/api/v1/orders/${orderId}`, headers })
  assert.equal(frozenOrder.json().items[0].equipmentWeight, "150 kg", "Converted order must use agreed technical weight")
  assert.equal(order.json().proposalAgreement.paymentTerms, input.paymentTerms)
  assert.equal(order.json().proposalAgreement.deliveryTerms, input.deliveryTerms)
  assert.equal(order.json().proposalAgreement.notes, input.notes)
  assert.equal(order.json().proposalAgreement.customer.email, "customer@example.test")
  assert.equal(order.json().checkout, undefined, "Textual agreement must not fabricate installments")
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM sales_order_checkouts WHERE tenant_id=$1 AND order_id=$2", [tenant, orderId])).rows[0].count, 0)
  await seed.query("UPDATE parties SET email='changed@example.test' WHERE tenant_id=$1 AND id=$1", [tenant])
  const agreedCustomer = await app.inject({ url: `/api/v1/orders/${orderId}`, headers })
  assert.equal(agreedCustomer.json().proposalAgreement.customer.email, "customer@example.test")
  await seed.query("UPDATE parties SET email='customer@example.test' WHERE tenant_id=$1 AND id=$1", [tenant])
  await seed.query("UPDATE sales_order_lines SET technical_snapshot=technical_snapshot-'weight' WHERE tenant_id=$1 AND order_id=$2", [tenant, orderId])
  assert.equal((await app.inject({ url: `/api/v1/orders/${orderId}`, headers })).json().items[0].equipmentWeight, null, "Frozen unknown weight must not be replaced by later catalogue data")
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM sales_orders WHERE tenant_id=$1", [tenant])).rows[0].count, before + 1)
  const discounted = { ...simulation, discount: { kind: "percent", value: 5000 } }
  const discountedQuote = await app.inject({ method: "POST", url: "/api/v1/commercial/mixed/simulate", headers: sellerHeaders, payload: discounted })
  assert.equal(discountedQuote.statusCode, 200, discountedQuote.body)
  const excess = await app.inject({ method: "POST", url: "/api/v1/proposals", headers: { ...sellerHeaders, "idempotency-key": randomUUID() }, payload: { ...input, items: [{ ...input.items[0], unitPrice: null }], commercial: { simulation: discounted, digest: discountedQuote.json().digest } } })
  assert.equal(excess.statusCode, 201, excess.body)
  const excessId = excess.json().data.id
  const sendExcess = (auth: string) => app.inject({ method: "POST", url: `/api/v1/proposals/${excessId}/send`, headers: { ...headers, authorization: `Bearer ${auth}`, "idempotency-key": randomUUID(), "if-match": '"1"' }, payload: {} })
  assert.equal((await sendExcess("proposal-seller")).statusCode, 409, "Seller must not formalize a proposal beyond commercial authority")
  const directorSent = await sendExcess("operator")
  assert.equal(directorSent.statusCode, 200, directorSent.body)
  const accepted = await app.inject({ method: "POST", url: `/api/v1/proposals/${excessId}/accept`, headers: { ...sellerHeaders, "idempotency-key": randomUUID(), "if-match": '"2"' }, payload: {} })
  assert.equal(accepted.statusCode, 200, accepted.body)
  const revised = await app.inject({ method: "POST", url: `/api/v1/proposals/${excessId}/revise`, headers: { ...sellerHeaders, "idempotency-key": randomUUID(), "if-match": '"3"' } })
  assert.equal(revised.statusCode, 200, revised.body)
  assert.equal(revised.json().data.version, 2)
  assert.equal(revised.json().items[0].technical.weightStack, "120 kg")
  const sendRevised = await app.inject({ method: "POST", url: `/api/v1/proposals/${excessId}/send`, headers: { ...sellerHeaders, "idempotency-key": randomUUID(), "if-match": '"4"' }, payload: {} })
  assert.equal(sendRevised.statusCode, 409, "A new proposal version requires its own commercial approval")
  const fiscalBypass = await app.inject({ method: "POST", url: "/api/v1/commercial/mixed/orders", headers: { ...headers, "idempotency-key": randomUUID() }, payload: { customerId: tenant, dueDate: "2027-01-01", simulation: dishonest, digest: dishonestQuote.json().digest } })
  assert.equal(fiscalBypass.statusCode, 409, "Direct order conversion must apply the same PF fiscal rule as proposals")
  const approvalBeforeCheck = (await seed.query("SELECT commercial_approval FROM sales_proposal_versions WHERE tenant_id=$1 AND proposal_id=$2 AND version=2", [tenant, excessId])).rows[0].commercial_approval
  const mailLock = await seed.connect()
  let check: Awaited<ReturnType<typeof app.inject>> | undefined
  try {
    await mailLock.query("BEGIN")
    await mailLock.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenant])
    check = await Promise.race([
      app.inject({ method: "POST", url: `/api/v1/proposals/${excessId}/commercial-validation`, headers, payload: {} }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error("Read-only commercial check waited for the native mail transaction lock")), 1500); timer.unref() }),
    ])
  } finally { await mailLock.query("ROLLBACK"); mailLock.release() }
  assert.equal(check.statusCode, 200, check.body)
  assert.equal(check.json().approvalCandidate.by, "operator")
  assert.ok(!/purchaseCostCents|equipmentCostCents|netProfitCents/.test(check.body))
  assert.equal((await seed.query("SELECT commercial_approval FROM sales_proposal_versions WHERE tenant_id=$1 AND proposal_id=$2 AND version=2", [tenant, excessId])).rows[0].commercial_approval, approvalBeforeCheck, "Checking from native SMTP must not commit a separate approval")
  const sellerCheck = await app.inject({ method: "POST", url: `/api/v1/proposals/${excessId}/commercial-validation`, headers: sellerHeaders, payload: {} })
  assert.equal(sellerCheck.statusCode, 409, "Native mail must receive the same authority refusal")
}
