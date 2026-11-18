import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { Pool } from "pg"
import type { LightMyRequestResponse } from "fastify"

import { buildApp } from "../src/app.js"
import { PgClientAdapter, type DatabasePool } from "../src/platform/database.js"
import { parseJson } from "../src/platform/json.js"
import { verifyOrderCommands } from "./order-command-cases.js"
import { verifyOrderTransitions } from "./order-transition-cases.js"
import { verifyProposalCommands } from "./proposal-command-cases.js"
import { verifyReports } from "./report-cases.js"
import { verifyCommercialApprovals } from "./commercial-approval-cases.js"
import { verifyCommercialSimulation } from "./commercial-simulation-cases.js"
import { verifyCommercialMixed } from "./commercial-mixed-cases.js"
import { verifyOpportunities } from "./opportunity-cases.js"
import { verifyCommercialMetrics } from "./commercial-metric-cases.js"
import { verifyLegacyPricing } from "./legacy-pricing-cases.js"
import { startRustContractBackend } from "./rust-contract-backend.js"
import { authContractProfile } from "./auth-contract-fixture.js"
import { verifyAuthContract } from "./auth-contract-cases.js"
import { verifyMcpDispatch } from "./mcp-dispatch-cases.js"
import { verifyCommercialProposals } from "./commercial-proposal-cases.js"
import { verifyNfeEmail } from "./nfe-email-cases.js"
import { verifyDocumentCopies } from "./document-copy-cases.js"
import { verifySalesMail } from "./sales-mail-cases.js"
import { verifyQualifiedReissue } from "./qualified-reissue-cases.js"

// Opt in with a disposable PostgreSQL administrator URL. The generated database
// and NOLOGIN role belong exclusively to this test and are removed afterwards.
const backends = ["typescript", ...(process.env.API_TS_TEST_RUST_BINARY ? ["rust"] : []), ...(process.env.API_TS_TEST_GATEWAY_BINARY ? ["gateway"] : [])]
for (const backend of backends) test(`${backend}: PostgreSQL migrations and RLS preserve registration and sales workflows across tenants`, { skip: !process.env.API_TS_TEST_ADMIN_URL }, async () => {
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL!)
  const suffix = randomUUID().replaceAll("-", ""), database = `api_ts_test_${suffix}`, role = `api_ts_role_${suffix}`
  const admin = new Pool({ connectionString: url.toString() })
  await admin.query(`CREATE DATABASE ${database}`)
  url.pathname = `/${database}`
  const seed = new Pool({ connectionString: url.toString() })
  const apiConnections = new Pool({ connectionString: url.toString() })
  let app: ReturnType<typeof buildApp> | undefined
  let privateApp: ReturnType<typeof buildApp> | undefined
  try {
    const directory = new URL("../../../migrations/", import.meta.url)
    for (const file of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
      await seed.query(await readFile(new URL(file, directory), "utf8"))
    }
    await seed.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    await seed.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`)
    const tenant = randomUUID(), other = randomUUID(), identity = randomUUID(), membership = randomUUID(), readerRole = randomUUID(), order = randomUUID(), proposal = randomUUID(), foreignOrder = randomUUID()
    // Historical catalog identifiers have the PostgreSQL UUID shape with a non-RFC variant.
    const product = "aa000000-0000-3000-2000-000000000001"
    await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa A','04252011000110'),($2,'Empresa B','52998224725')", [tenant, other])
    await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,'reader','reader@example.test','Leitor')", [identity])
    await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [membership, tenant, identity])
    await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'reader','Leitor')", [readerRole, tenant])
    await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, readerRole])
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'sales.orders.read'),($1,'sales.proposals.read')", [readerRole])
    await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) SELECT id,id,'fisica','Cliente','52998224725',true,false,'active' FROM tenants")
    await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'LD-1','Banco','UN',10000,'active')", [product, tenant])
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-01',10000,'draft'),($3,$4,$4,'Cliente externo','52998224725','2027-01-01',10000,'draft')", [order, tenant, foreignOrder, other])
    await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'LD-1','Banco','UN',1000000,10000,10000)", [tenant, order, product])
    await seed.query("INSERT INTO sales_order_checkouts(tenant_id,order_id,customer_snapshot,entry_amount_cents,manufacturing_days,delivery_notes,payment_notes,notes) VALUES($1,$2,$3,0,30,'Entrega','','')", [tenant, order, { legalName: "Cliente", stateRegistration: "123456" }])
    const proposalSeed = await seed.connect()
    try {
      await proposalSeed.query("BEGIN")
      await proposalSeed.query("INSERT INTO sales_proposals(id,tenant_id) VALUES($1,$2)", [proposal, tenant])
      await proposalSeed.query("INSERT INTO sales_proposal_versions(tenant_id,proposal_id,version,customer_id,customer_name,customer_tax_id,valid_until,payment_terms,delivery_terms,amount_cents,status,created_by) VALUES($1,$2,1,$1,'Cliente','52998224725','2100-01-01','À vista','Retirada',10000,'draft','reader')", [tenant, proposal])
      await proposalSeed.query("COMMIT")
    } finally { proposalSeed.release() }
    const pool: DatabasePool = { async connect() {
      const client = await apiConnections.connect()
      await client.query(`SET ROLE ${role}`)
      return new PgClientAdapter(client)
    } }
    const headers = { authorization: "Bearer reader", "x-tenant-id": tenant }
    if (backend !== "rust") privateApp = buildApp({ pool, userinfoUrl: "http://auth.test/userinfo", mcpResource: "https://erp.avilaops.com/mcp", fetchAuth: async (_url, init) => { const fixture = authContractProfile(new Headers(init?.headers).get("authorization")!.slice(7)); return Response.json(fixture.profile, { status: fixture.status }) } })
    if (backend === "gateway") {
      const origin = await privateApp!.listen({ port: 0, host: "127.0.0.1" })
      app = await startRustContractBackend(process.env.API_TS_TEST_GATEWAY_BINARY!, url.toString(), role, origin)
      const proof = await app.inject({ url: "/api/v1/preferences", headers })
      assert.equal(proof.headers["x-erp-backend"], "typescript", "Production Rust must dispatch migrated operations to TypeScript")
    } else app = backend === "rust" ? await startRustContractBackend(process.env.API_TS_TEST_RUST_BINARY!, url.toString(), role) : privateApp!
    await verifyAuthContract(app, tenant)
    const detail = await app.inject({ method: "GET", url: `/api/v1/orders/${order}`, headers })
    assert.equal(detail.statusCode, 200, detail.body)
    assert.equal(detail.json().items[0].unitPrice, "100.00")
    assert.equal(detail.json().canEdit, false)
    assert.equal(detail.json().checkout.manufacturingDays, 30)
    assert.equal(detail.json().checkout.confirmationCreatesReceivables, true)
    assert.equal(detail.json().checkout.stateRegistration, "123456")
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/orders/${foreignOrder}`, headers })).statusCode, 404)
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/orders/${foreignOrder}`, headers: { ...headers, "x-tenant-id": other } })).statusCode, 403)
    const snapshot = await app.inject({ method: "GET", url: `/api/v1/proposals/${proposal}?version=1`, headers })
    assert.equal(snapshot.statusCode, 200, snapshot.body)
    assert.equal(snapshot.json().versions.length, 1)
    const list = await app.inject({ method: "GET", url: "/api/v1/orders?sort=updated", headers })
    assert.equal(list.statusCode, 200, list.body)
    assert.equal(list.json().total, 1)
    for (const q of ["1e30", "1.0", "9223372036854775807", "9223372036854775808", "😀".repeat(160)]) {
      const result: LightMyRequestResponse = await app.inject({ method: "GET", url: `/api/v1/orders?q=${encodeURIComponent(q)}`, headers })
      assert.equal(result.statusCode, 200, result.body)
      assert.equal(result.json().total, 0, "Only positive i64 integer strings match an order number")
    }
    for (const query of ["limit=1.0", "limit=1e1", "offset=", "limit=0x10", "limit=1&limit=2", "q=middle%00control"]) {
      const result: LightMyRequestResponse = await app.inject({ method: "GET", url: `/api/v1/orders?${query}`, headers })
      assert.equal(result.statusCode, 422, result.body)
    }
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/proposals/${proposal}?version=1.0`, headers })).statusCode, 422)
    await seed.query(`GRANT INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`)
    if (backend === "typescript") await verifyNfeEmail(seed, pool, tenant, other, readerRole)
    if (backend === "typescript") await verifyDocumentCopies(seed, pool, other)
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'catalog.parties.read'),($1,'catalog.parties.manage')", [readerRole])
    const partyInput = { personType: "juridica", legalName: "Cliente novo", tradeName: null, taxId: "04252011000110", email: "client@example.test", phone: null, isCustomer: true, isSupplier: false, status: "active", addresses: [], contacts: [] }
    const key = randomUUID()
    const creates = await Promise.all([1, 2].map(() => app!.inject({ method: "POST", url: "/api/v1/parties", headers: { ...headers, "idempotency-key": key }, payload: partyInput })))
    for (const response of creates) assert.equal(response.statusCode, 201, response.body)
    assert.deepEqual(creates[0]!.json(), creates[1]!.json(), "Concurrent idempotent requests must return the same snapshot")
    const partyId = creates[0]!.json().data.id as string
    const edits = await Promise.all(["Nome A", "Nome B"].map(legalName => app!.inject({ method: "PUT", url: `/api/v1/parties/${partyId}`, headers: { ...headers, "if-match": '"1"' }, payload: { ...partyInput, legalName } })))
    assert.deepEqual(edits.map(response => response.statusCode).sort(), [200, 412], "Only one editor may consume a revision")
    const evidence = await seed.query("SELECT (SELECT count(*)::int FROM audit_log WHERE entity_id=$1) AS audits,(SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$1) AS events,(SELECT count(*)::int FROM domain_commands WHERE command_key=$2) AS commands", [partyId, key])
    assert.deepEqual(evidence.rows[0], { audits: 2, events: 2, commands: 1 })
    const changedReplay = await app.inject({ method: "POST", url: "/api/v1/parties", headers: { ...headers, "idempotency-key": key }, payload: { ...partyInput, legalName: "Outros dados" } })
    assert.equal(changedReplay.statusCode, 409, changedReplay.body)
    // Access revocation commits while a request waits for the tenant write lock.
    const accessChange = await seed.connect()
    let waiting: Promise<{ statusCode: number }> | undefined
    try {
      await accessChange.query("BEGIN")
      await accessChange.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenant])
      waiting = app.inject({ method: "PUT", url: `/api/v1/parties/${partyId}`, headers: { ...headers, "if-match": '"2"' }, payload: partyInput })
      // Start the thenable request before polling PostgreSQL for its lock wait.
      const pending = Promise.resolve(waiting)
      const deadline = Date.now() + 5000
      let observed = false
      while (Date.now() < deadline) {
        const state = await seed.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT id FROM tenants WHERE id=$1 FOR UPDATE') AS waiting")
        if (state.rows[0].waiting) { observed = true; break }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.ok(observed, "The command must wait for the same tenant lock as access management")
      await accessChange.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='catalog.parties.manage'", [readerRole])
      await accessChange.query("COMMIT")
      assert.equal((await pending).statusCode, 403, "Rights must be reloaded after waiting for the lock")
    } finally {
      await accessChange.query("ROLLBACK")
      accessChange.release()
      if (waiting) await waiting
    }
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'catalog.parties.manage'),($1,'catalog.products.read'),($1,'catalog.products.manage')", [readerRole])
    const productInput = { sku: "NEW-PRODUCT", name: "Produto concorrente", unit: "UN", ncm: null, cest: null, basePrice: "1234.56", status: "active" }
    const productKey = randomUUID()
    const products = await Promise.all([1, 2].map(() => app!.inject({ method: "POST", url: "/api/v1/products", headers: { ...headers, "idempotency-key": productKey }, payload: productInput })))
    for (const response of products) assert.equal(response.statusCode, 201, response.body)
    assert.deepEqual(products[0]!.json(), products[1]!.json())
    const productId = products[0]!.json().data.id as string
    assert.equal(products[0]!.json().data.basePrice, "1234.56")
    const productEdits = await Promise.all(["Produto A", "Produto B"].map(name => app!.inject({ method: "PUT", url: `/api/v1/products/${productId}`, headers: { ...headers, "if-match": '"1"' }, payload: { ...productInput, name } })))
    assert.deepEqual(productEdits.map(response => response.statusCode).sort(), [200, 412])
    // An outbox failure after INSERT must undo the party, audit and command too.
    await seed.query(`REVOKE INSERT ON outbox_events FROM ${role}`)
    const rollbackKey = randomUUID()
    const failed = await app.inject({ method: "POST", url: "/api/v1/parties", headers: { ...headers, "idempotency-key": rollbackKey }, payload: { ...partyInput, legalName: "Rollback", taxId: "11222333000181" } })
    assert.equal(failed.statusCode, 500, failed.body)
    const rolledBack = await seed.query("SELECT (SELECT count(*)::int FROM parties WHERE tenant_id=$1 AND legal_name='Rollback') AS parties,(SELECT count(*)::int FROM domain_commands WHERE command_key=$2) AS commands", [tenant, rollbackKey])
    assert.deepEqual(rolledBack.rows[0], { parties: 0, commands: 0 })
    // Platform authority is an explicit subject grant, including without membership.
    await seed.query("INSERT INTO identities(auth_subject,email,display_name) VALUES('operator','operator@example.test','Operador')")
    await seed.query("INSERT INTO platform_administrators(auth_subject,active,granted_by,reason) VALUES('operator',true,'test','Integration fixture')")
    const operatorHeaders = { authorization: "Bearer operator", "x-tenant-id": other }
    const operatorRead = await app.inject({ method: "GET", url: `/api/v1/orders/${foreignOrder}`, headers: operatorHeaders })
    assert.equal(operatorRead.statusCode, 200, operatorRead.body)
    assert.equal(operatorRead.json().canEdit, true)
    const settingsUrl = "/api/v1/registration-settings/parties"
    const defaultSettings = await app.inject({ method: "GET", url: settingsUrl, headers: operatorHeaders })
    assert.equal(defaultSettings.statusCode, 200, defaultSettings.body)
    assert.equal(defaultSettings.headers.etag, '"1"')
    const settingsEdits = await Promise.all([true, false].map(requireEmail => app!.inject({ method: "PUT", url: settingsUrl, headers: { ...operatorHeaders, "if-match": '"1"' }, payload: { requireEmail, requirePhone: false } })))
    assert.deepEqual(settingsEdits.map(response => response.statusCode).sort(), [200, 412])
    const persistedSettings = await app.inject({ method: "GET", url: settingsUrl, headers: operatorHeaders })
    assert.equal(persistedSettings.headers.etag, '"2"')
    const settingEvidence = await seed.query("SELECT (SELECT count(*)::int FROM registration_settings WHERE tenant_id=$1 AND section='parties') AS settings,(SELECT count(*)::int FROM audit_log WHERE tenant_id=$1 AND action='registration_settings.updated') AS audits", [other])
    assert.deepEqual(settingEvidence.rows[0], { settings: 1, audits: 1 })
    const untouchedSettings = await app.inject({ method: "GET", url: settingsUrl, headers })
    assert.equal(untouchedSettings.statusCode, 200, untouchedSettings.body)
    assert.equal(untouchedSettings.headers.etag, '"1"')
    assert.deepEqual(untouchedSettings.json().data, { requireEmail: false, requirePhone: false })
    const refs = new Map<string, string>()
    await seed.query(`GRANT INSERT ON outbox_events TO ${role}`)
    const legacyCategory = "aa000000-0000-3000-2000-000000000002"
    await seed.query("INSERT INTO product_categories(id,tenant_id,code,name,status,revision,sort_order) VALUES($1,$2,'LEGADO','Categoria histórica','active',1,0)", [legacyCategory, tenant])
    const legacyProductUrl = `/api/v1/products/${product}`
    const historicalProduct = await app.inject({ method: "GET", url: legacyProductUrl, headers })
    assert.equal(historicalProduct.statusCode, 200, historicalProduct.body)
    assert.equal(historicalProduct.json().data.id, product)
    assert.equal((await app.inject({ method: "GET", url: legacyProductUrl, headers: operatorHeaders })).statusCode, 404)
    const historicalUpdate = await app.inject({ method: "PUT", url: legacyProductUrl, headers: { ...headers, "if-match": historicalProduct.headers.etag as string }, payload: { ...productInput, sku: "LD-1", categoryId: legacyCategory } })
    assert.equal(historicalUpdate.statusCode, 200, historicalUpdate.body)
    assert.equal(historicalUpdate.json().data.id, product)
    assert.equal(historicalUpdate.json().data.categoryId, legacyCategory)
    const categoryFiltered = await app.inject({ method: "GET", url: `/api/v1/products?category_id=${legacyCategory}`, headers })
    assert.equal(categoryFiltered.statusCode, 200, categoryFiltered.body)
    assert.deepEqual(categoryFiltered.json().data.map((row: { id: string }) => row.id), [product])
    const categoryHeaders = { ...operatorHeaders, "x-tenant-id": tenant }
    const categoryUrl = `/api/v1/product-categories/${legacyCategory}`
    const categoryRead = await app.inject({ method: "GET", url: categoryUrl, headers: categoryHeaders })
    assert.equal(categoryRead.statusCode, 200, categoryRead.body)
    const legacyChild = { code: "LEGADO-FILHA", name: "Subcategoria", status: "active", parentId: legacyCategory, sortOrder: 1 }
    const historicalChild = await app.inject({ method: "POST", url: "/api/v1/product-categories", headers: { ...categoryHeaders, "idempotency-key": randomUUID() }, payload: legacyChild })
    assert.equal(historicalChild.statusCode, 201, historicalChild.body)
    assert.equal(historicalChild.json().data.parentId, legacyCategory)
    const categoryEdit = await app.inject({ method: "PUT", url: categoryUrl, headers: { ...categoryHeaders, "idempotency-key": randomUUID(), "if-match": '"1"' }, payload: { code: "LEGADO", name: "Categoria atualizada", status: "active", sortOrder: 0 } })
    assert.equal(categoryEdit.statusCode, 200, categoryEdit.body)
    assert.equal(categoryEdit.json().data.id, legacyCategory)
    if (backend !== "rust") {
      const malformedProduct = product.slice(1)
      assert.equal((await app.inject({ method: "GET", url: `/api/v1/products/${malformedProduct}`, headers })).statusCode, 404)
      assert.equal((await app.inject({ method: "GET", url: `/api/v1/products?category_id=${legacyCategory.slice(1)}`, headers })).statusCode, 422)
      const invalidCommand = await app.inject({ method: "POST", url: "/api/v1/products", headers: { ...headers, "idempotency-key": product }, payload: { ...productInput, sku: "INVALID-COMMAND" } })
      assert.equal(invalidCommand.statusCode, 422, invalidCommand.body)
      assert.equal(invalidCommand.json().title, "Chave de idempotência inválida")
    }
    for (const [resource, input] of [
      ["product-categories", { code: "FORCA", name: "Força", status: "active", notes: null, parentId: null, sortOrder: 1 }],
      ["product-groups", { code: "GRUPO", name: "Grupo", status: "active", notes: null }],
      ["tag-groups", { code: "CORES", name: "Cores", status: "active", notes: null }],
      ["tags", { code: "PRETO", name: "Preto", status: "active", notes: null, groupId: null }],
    ] as const) {
      const commandKey = randomUUID()
      const created: LightMyRequestResponse = await app.inject({ method: "POST", url: `/api/v1/${resource}`, headers: { ...operatorHeaders, "idempotency-key": commandKey }, payload: input })
      assert.equal(created.statusCode, 201, created.body)
      assert.equal(created.json().tenantId, other)
      assert.equal(created.json().canEdit, true)
      const referenceId = created.json().data.id as string
      refs.set(resource, referenceId)
      const replayed: LightMyRequestResponse = await app.inject({ method: "POST", url: `/api/v1/${resource}`, headers: { ...operatorHeaders, "idempotency-key": commandKey }, payload: input })
      assert.equal(replayed.statusCode, 201, replayed.body)
      assert.equal(replayed.headers["idempotency-replayed"], "true")
      assert.deepEqual(replayed.json(), created.json())
      const detail: LightMyRequestResponse = await app.inject({ method: "GET", url: `/api/v1/${resource}/${referenceId}`, headers: operatorHeaders })
      assert.deepEqual(detail.json(), created.json())
      const updateKey = randomUUID()
      const changed: LightMyRequestResponse = await app.inject({ method: "PUT", url: `/api/v1/${resource}/${referenceId}`, headers: { ...operatorHeaders, "idempotency-key": updateKey, "if-match": '"1"' }, payload: { ...input, name: "Atualizado" } })
      assert.equal(changed.statusCode, 200, changed.body)
      assert.equal(changed.headers.etag, '"2"')
      const repeated: LightMyRequestResponse = await app.inject({ method: "PUT", url: `/api/v1/${resource}/${referenceId}`, headers: { ...operatorHeaders, "idempotency-key": updateKey, "if-match": '"1"' }, payload: { ...input, name: "Atualizado" } })
      assert.equal(repeated.statusCode, 200, repeated.body)
      assert.equal(repeated.headers["idempotency-replayed"], "true")
      assert.deepEqual(repeated.json(), changed.json())
      const collection: LightMyRequestResponse = await app.inject({ method: "GET", url: `/api/v1/${resource}?category_id=${refs.get("product-categories")!}&limit=1`, headers: operatorHeaders })
      assert.equal(collection.statusCode, 200, collection.body)
      assert.equal(collection.json().data[0].id, referenceId)
      const storedCommand = await seed.query("SELECT scope,request FROM domain_commands WHERE command_key=$1", [commandKey])
      assert.deepEqual(storedCommand.rows[0], { scope: `${resource === "product-categories" ? "product_category" : resource === "product-groups" ? "product_group" : resource === "tag-groups" ? "tag_group" : "tag"}.created`, request: { id: null, revision: null, input } })
    }
    const categoryId = refs.get("product-categories")!
    const selfParent = await app.inject({ method: "PUT", url: `/api/v1/product-categories/${categoryId}`, headers: { ...operatorHeaders, "idempotency-key": randomUUID(), "if-match": '"2"' }, payload: { code: "FORCA", name: "Força", status: "active", parentId: categoryId, sortOrder: 1 } })
    assert.equal(selfParent.statusCode, 409, selfParent.body)
    const refWrite = (resource: string, payload: Record<string, unknown>, referenceId?: string, revision = 1) => app!.inject({ method: referenceId ? "PUT" : "POST", url: `/api/v1/${resource}${referenceId ? `/${referenceId}` : ""}`, headers: { ...operatorHeaders, "idempotency-key": randomUUID(), ...(referenceId ? { "if-match": `"${revision}"` } : {}) }, payload })
    const parentInput = { code: "FORCA", name: "Força", status: "active", parentId: null, sortOrder: 1 }
    const child = await refWrite("product-categories", { ...parentInput, code: "FILHA", parentId: categoryId })
    assert.equal(child.statusCode, 201, child.body)
    const childId = child.json().data.id as string
    assert.equal((await refWrite("product-categories", { ...parentInput, parentId: childId }, categoryId, 2)).statusCode, 409)
    assert.equal((await refWrite("product-categories", { ...parentInput, status: "archived" }, categoryId, 2)).statusCode, 409)
    assert.equal((await refWrite("product-categories", { ...parentInput, code: "FILHA", parentId: categoryId, status: "archived" }, childId)).statusCode, 200)
    assert.equal((await refWrite("product-categories", { ...parentInput, status: "archived" }, categoryId, 2)).statusCode, 200)
    assert.equal((await refWrite("product-categories", { ...parentInput, code: "OUTRA", parentId: categoryId })).statusCode, 409)
    const groupId = refs.get("tag-groups")!
    const tagInput = { code: "AZUL", name: "Azul", status: "active", groupId }
    const linked = await refWrite("tags", tagInput)
    assert.equal(linked.statusCode, 201, linked.body)
    const groupInput = { code: "CORES", name: "Cores", status: "archived" }
    assert.equal((await refWrite("tag-groups", groupInput, groupId, 2)).statusCode, 409)
    assert.equal((await refWrite("tags", { ...tagInput, status: "archived" }, linked.json().data.id as string)).statusCode, 200)
    assert.equal((await refWrite("tag-groups", groupInput, groupId, 2)).statusCode, 200)
    assert.equal((await refWrite("tags", { ...tagInput, code: "VERDE" })).statusCode, 409)
    const foreignGroup = randomUUID()
    await seed.query("INSERT INTO tag_groups(id,tenant_id,code,name,status,revision) VALUES($1,$2,'EXTERNO','Externo','active',1)", [foreignGroup, tenant])
    assert.equal((await refWrite("tags", { ...tagInput, code: "EXTERNA", groupId: foreignGroup })).statusCode, 409)
    const referenceEvents = await seed.query("SELECT action,entity_type,details FROM audit_log WHERE entity_id=$1 ORDER BY occurred_at", [categoryId])
    assert.deepEqual(referenceEvents.rows[0], { action: "product_category.created", entity_type: "product_categories", details: { revision: 1, previousRevision: null, status: "active" } })
    assert.equal(referenceEvents.rows.length, 3, "Rejected hierarchy commands must not create audit entries")
    const settingsChanged = await app.inject({ method: "PUT", url: settingsUrl, headers: { ...operatorHeaders, "if-match": '"2"' }, payload: { requireEmail: true, requirePhone: true } })
    assert.equal(settingsChanged.statusCode, 200, settingsChanged.body)
    const richParty = { ...partyInput, isSupplier: true, phone: "11999999999", fiscal: { taxpayerIndicator: "1", stateRegistration: "12345" }, addresses: [{ label: " Entrega ", postalCode: "01001-000", state: "sp", municipalityCode: "3550308", city: "São Paulo", street: "Praça", number: "1", district: "Centro", primary: true }], contacts: [{ name: " Maria ", email: "maria@example.test", primary: true }] }
    for (const missingContact of [{ ...richParty, email: null }, { ...richParty, phone: null }]) {
      const rejected: LightMyRequestResponse = await app.inject({ method: "POST", url: "/api/v1/parties", headers: { ...operatorHeaders, "idempotency-key": randomUUID() }, payload: missingContact })
      assert.equal(rejected.statusCode, 422, rejected.body)
    }
    const savedParty = await app.inject({ method: "POST", url: "/api/v1/parties", headers: { ...operatorHeaders, "idempotency-key": randomUUID() }, payload: richParty })
    assert.equal(savedParty.statusCode, 201, savedParty.body)
    const savedId = savedParty.json().data.id as string
    const savedData = savedParty.json().data
    assert.equal(savedData.addresses[0].postalCode, "01001000")
    assert.equal(savedData.contacts[0].name, "Maria")
    const updateInput = { ...partyInput, phone: richParty.phone, isSupplier: true }
    // Omission preserves metadata, explicit null clears fiscal, [] clears collections.
    const { addresses: _addresses, contacts: _contacts, ...withoutComplements } = updateInput
    const preserved = await app.inject({ method: "PUT", url: `/api/v1/parties/${savedId}`, headers: { ...operatorHeaders, "if-match": '"1"' }, payload: withoutComplements })
    assert.equal(preserved.statusCode, 200, preserved.body)
    assert.deepEqual(preserved.json().data.addresses, savedData.addresses)
    assert.deepEqual(preserved.json().data.contacts, savedData.contacts)
    assert.deepEqual(preserved.json().data.fiscal, savedData.fiscal)
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente novo','04252011000110','2027-01-01',10000,'draft')", [randomUUID(), other, savedId])
    const linkedDocument = await app.inject({ method: "PUT", url: `/api/v1/parties/${savedId}`, headers: { ...operatorHeaders, "if-match": '"2"' }, payload: { ...withoutComplements, taxId: "11222333000181" } })
    assert.equal(linkedDocument.statusCode, 409, linkedDocument.body)
    const clearing = await app.inject({ method: "PUT", url: `/api/v1/parties/${savedId}`, headers: { ...operatorHeaders, "if-match": '"2"' }, payload: { ...withoutComplements, fiscal: null, addresses: [], contacts: [] } })
    assert.equal(clearing.statusCode, 200, clearing.body)
    assert.deepEqual(clearing.json().data.addresses, [])
    assert.deepEqual(clearing.json().data.contacts, [])
    assert.equal(clearing.json().data.fiscal, null)
    const partyEvents = await seed.query("SELECT payload FROM outbox_events WHERE aggregate_id=$1 ORDER BY occurred_at", [savedId])
    assert.deepEqual(partyEvents.rows[0].payload, { revision: 1, isCustomer: true, isSupplier: true })
    assert.deepEqual(partyEvents.rows[1].payload, { previousRevision: 1, revision: 2, isCustomer: true, isSupplier: true })
    assert.equal(partyEvents.rows.length, 3)
    const photoBytes = Buffer.alloc(70000, 1)
    photoBytes.set([255, 216, 255], 0)
    photoBytes.set([255, 217], photoBytes.length - 2)
    const photoDataUrl = `data:image/jpeg;base64,${photoBytes.toString("base64")}`
    const activeCategory = await refWrite("product-categories", { ...parentInput, code: "NOVOS" })
    assert.equal(activeCategory.statusCode, 201, activeCategory.body)
    const newCategoryId = activeCategory.json().data.id as string
    const richProduct = { ...productInput, sku: "RICH-PRODUCT", ncm: "95069100", cest: "2805900", categoryId: newCategoryId, photoDataUrl, structureColors: ["Preto"], swingArmColors: ["Prata"], upholsteryColors: ["Azul"], armColors: ["Preto"], plateHolderType: " STANDARD ", finishingPalette: "dhz-combined" }
    const richKey = randomUUID()
    const productSaved = await app.inject({ method: "POST", url: "/api/v1/products", headers: { ...operatorHeaders, "idempotency-key": richKey }, payload: richProduct })
    assert.equal(productSaved.statusCode, 201, productSaved.body)
    const richId = productSaved.json().data.id as string
    assert.equal(productSaved.json().data.photoDataUrl, photoDataUrl)
    assert.deepEqual(productSaved.json().data.plateHolderTypes, ["Standard"])
    const richCommand = await seed.query("SELECT request FROM domain_commands WHERE command_key=$1", [richKey])
    assert.equal(Object.hasOwn(richCommand.rows[0].request, "armColors"), false)
    assert.equal(Object.hasOwn(richCommand.rows[0].request, "plateHolderType"), false)
    assert.deepEqual(richCommand.rows[0].request.plateHolderColors, ["Preto"])
    assert.equal((await refWrite("product-categories", { ...parentInput, code: "NOVOS", status: "archived" }, newCategoryId)).statusCode, 200)
    const productSettings = await app.inject({ method: "PUT", url: "/api/v1/registration-settings/products", headers: { ...operatorHeaders, "if-match": '"1"' }, payload: { requireNcm: true, requireCest: true, upholsteryConfigurable: false } })
    assert.equal(productSettings.statusCode, 200, productSettings.body)
    const productEdit = (payload: Record<string, unknown>, revision: number) => app!.inject({ method: "PUT", url: `/api/v1/products/${richId}`, headers: { ...operatorHeaders, "if-match": `"${revision}"` }, payload })
    const baseProduct = { ...productInput, sku: richProduct.sku, ncm: richProduct.ncm, cest: richProduct.cest }
    assert.equal((await productEdit({ ...baseProduct, ncm: null }, 1)).statusCode, 422)
    assert.equal((await productEdit({ ...baseProduct, upholsteryColors: ["Azul"] }, 1)).statusCode, 422)
    const productPreserved = await productEdit({ ...baseProduct, categoryId: null, photoDataUrl: null }, 1)
    assert.equal(productPreserved.statusCode, 200, productPreserved.body)
    assert.equal(productPreserved.json().data.categoryId, newCategoryId)
    assert.equal(productPreserved.json().data.photoDataUrl, photoDataUrl)
    assert.deepEqual(productPreserved.json().data.upholsteryColors, ["Azul"])
    const productCleared = await productEdit({ ...baseProduct, categoryId: "", photoDataUrl: "", structureColors: [], upholsteryColors: [], swingArmColors: [], plateHolderColors: [], plateHolderTypes: [], finishingPalette: "" }, 2)
    assert.equal(productCleared.statusCode, 200, productCleared.body)
    assert.equal(Object.hasOwn(productCleared.json().data, "categoryId"), false)
    assert.equal(productCleared.json().data.photoDataUrl, "")
    assert.deepEqual(productCleared.json().data.plateHolderTypes, [])
    await seed.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason) VALUES($1,$2,$3,'receipt',1000000,1000000,'Fixture integration')", [randomUUID(), other, richId])
    await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,1000000)", [other, richId])
    assert.equal((await productEdit({ ...baseProduct, unit: "KG" }, 3)).statusCode, 409)
    assert.equal((await productEdit({ ...baseProduct, status: "archived" }, 3)).statusCode, 409)
    await seed.query("UPDATE products SET plate_holder_type='olympic',plate_holder_types='{}' WHERE tenant_id=$1 AND id=$2", [other, richId])
    const legacyRead = await app.inject({ method: "GET", url: `/api/v1/products/${richId}`, headers: operatorHeaders })
    assert.equal(legacyRead.statusCode, 200, legacyRead.body)
    assert.deepEqual(legacyRead.json().data.plateHolderTypes, ["Olímpico"])
    const preferences = await app.inject({ method: "GET", url: "/api/v1/preferences", headers })
    assert.equal(preferences.statusCode, 200, preferences.body)
    assert.equal(preferences.json().revision, 1)
    const ownerKey = preferences.json().ownerKey as string
    const layout = { favoritePaths: ["/vendas/pedidos"], charts: ["Pedidos de venda"], period: "30D" }
    const preferencesSaved = await app.inject({ method: "PUT", url: "/api/v1/preferences", headers: { ...headers, "if-match": '"1"' }, payload: { ownerKey, productPageSize: 50, dashboardLayout: layout } })
    assert.equal(preferencesSaved.statusCode, 200, preferencesSaved.body)
    const preferencesRead = await app.inject({ method: "GET", url: "/api/v1/preferences", headers })
    assert.equal(preferencesRead.json().revision, 2, "Persisted bigint revisions must remain JSON numbers")
    const preferencesAgain = await app.inject({ method: "PUT", url: "/api/v1/preferences", headers: { ...headers, "if-match": '"2"' }, payload: { productPageSize: 100 } })
    assert.equal(preferencesAgain.statusCode, 200, preferencesAgain.body)
    assert.deepEqual(preferencesAgain.json().data.dashboardLayout, layout)
    const wrongOwner = await app.inject({ method: "PUT", url: "/api/v1/preferences", headers: { ...headers, "if-match": '"1"' }, payload: { ownerKey: "changed-company", productPageSize: 25 } })
    assert.equal(wrongOwner.statusCode, 409, wrongOwner.body)
    const otherOwner = await app.inject({ method: "GET", url: "/api/v1/preferences", headers: operatorHeaders })
    assert.equal(otherOwner.json().revision, 1)
    assert.notEqual(otherOwner.json().ownerKey, ownerKey)
    const uppercaseTenant = await app.inject({ method: "GET", url: "/api/v1/preferences", headers: { ...operatorHeaders, "x-tenant-id": other.toUpperCase() } })
    assert.deepEqual(uppercaseTenant.json(), otherOwner.json(), "UUID spelling must not change preference ownership")
    const preferenceRace = await Promise.all([10, 25].map(productPageSize => app!.inject({ method: "PUT", url: "/api/v1/preferences", headers: { ...headers, "if-match": '"03"' }, payload: { productPageSize, ownerKey: null, dashboardLayout: null } })))
    assert.deepEqual(preferenceRace.map(response => response.statusCode).sort(), [200, 412])
    for (const value of ['"0"', "3", 'W/"3"', '"-1"']) assert.equal((await app.inject({ method: "PUT", url: "/api/v1/preferences", headers: { ...headers, "if-match": value }, payload: { productPageSize: 25 } })).statusCode, 400)
    const preferenceEvidence = await seed.query("SELECT details FROM audit_log WHERE tenant_id=$1 AND identity_id=$2 AND action='preferences.updated' ORDER BY occurred_at", [tenant, identity])
    assert.equal(preferenceEvidence.rows.length, 3)
    assert.equal(preferenceEvidence.rows[2].details.previousRevision, 3)
    assert.equal(preferenceEvidence.rows[2].details.revision, 4)
    const highRevision = "9007199254740993"
    await seed.query("UPDATE personal_preferences SET revision=$3 WHERE tenant_id=$1 AND auth_subject=$2", [tenant, "reader", highRevision])
    const highRead = await app.inject({ method: "GET", url: "/api/v1/preferences", headers })
    assert.equal(highRead.headers.etag, `"${highRevision}"`)
    assert.ok(highRead.body.includes(`"revision":${highRevision}`))
    const highSaved = await app.inject({ method: "PUT", url: "/api/v1/preferences", headers: { ...headers, "if-match": `"${highRevision}"` }, payload: { productPageSize: 25 } })
    assert.equal(highSaved.statusCode, 200, highSaved.body)
    assert.equal(highSaved.headers.etag, '"9007199254740994"')
    const highAudit = await seed.query("SELECT details->>'previousRevision' AS previous,details->>'revision' AS next FROM audit_log WHERE tenant_id=$1 AND action='preferences.updated' ORDER BY occurred_at DESC LIMIT 1", [tenant])
    assert.deepEqual(highAudit.rows[0], { previous: highRevision, next: "9007199254740994" })
    const highGroup = refs.get("product-groups")!
    await seed.query("UPDATE product_groups SET revision=$2 WHERE id=$1", [highGroup, highRevision])
    const highKey = randomUUID(), highInput = { code: "GRUPO", name: "Grupo grande", status: "active" }
    const highCommand = () => app!.inject({ method: "PUT", url: `/api/v1/product-groups/${highGroup}`, headers: { ...operatorHeaders, "if-match": `"${highRevision}"`, "idempotency-key": highKey }, payload: highInput })
    const highChanged = await highCommand()
    assert.equal(highChanged.statusCode, 200, highChanged.body)
    const highReplay = await highCommand()
    assert.equal(highReplay.statusCode, 200, highReplay.body)
    assert.equal(highReplay.headers["idempotency-replayed"], "true")
    assert.deepEqual(parseJson(highReplay.body), parseJson(highChanged.body))
    assert.ok(highReplay.body.includes('"revision":9007199254740994'))
    const exactStored = await seed.query("SELECT request->>'revision' AS previous,result->'data'->>'revision' AS next FROM domain_commands WHERE command_key=$1", [highKey])
    assert.deepEqual(exactStored.rows[0], { previous: highRevision, next: "9007199254740994" })
    for (const [table, endpoint, recordId, payload] of [
      ["parties", "parties", partyId, partyInput], ["products", "products", productId, productInput],
    ] as const) {
      await seed.query(`UPDATE ${table} SET revision=$2 WHERE id=$1`, [recordId, highRevision])
      const response: LightMyRequestResponse = await app.inject({ method: "PUT", url: `/api/v1/${endpoint}/${recordId}`, headers: { ...headers, "if-match": `"${highRevision}"` }, payload })
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.headers.etag, '"9007199254740994"')
      assert.ok(response.body.includes('"revision":9007199254740994'))
    }
    await seed.query("UPDATE registration_settings SET revision=$2 WHERE tenant_id=$1 AND section='products'", [other, highRevision])
    const highSettings = await app.inject({ method: "PUT", url: "/api/v1/registration-settings/products", headers: { ...operatorHeaders, "if-match": `"${highRevision}"` }, payload: { requireNcm: false, requireCest: false } })
    assert.equal(highSettings.statusCode, 200, highSettings.body)
    assert.equal(highSettings.headers.etag, '"9007199254740994"')
    await seed.query("UPDATE personal_preferences SET revision=9223372036854775807 WHERE tenant_id=$1 AND auth_subject='reader'", [tenant])
    assert.equal((await app.inject({ method: "PUT", url: "/api/v1/preferences", headers: { ...headers, "if-match": '"9223372036854775807"' }, payload: { productPageSize: 25 } })).statusCode, 500)
    assert.equal((await app.inject({ method: "PUT", url: "/api/v1/preferences", headers: { ...headers, "if-match": '"9223372036854775808"' }, payload: { productPageSize: 25 } })).statusCode, 400)
    assert.equal((await seed.query("SELECT revision::text FROM personal_preferences WHERE tenant_id=$1 AND auth_subject='reader'", [tenant])).rows[0].revision, "9223372036854775807")
    await verifyOrderCommands(app, seed, other, role)
    await verifyOrderTransitions(app, seed, other, role)
    await verifyProposalCommands(app, seed, other, role)
    await verifyReports(app, seed, role)
    await verifyCommercialApprovals(app, seed, other, role)
    await verifyLegacyPricing(app, seed, other, role)
    await verifyCommercialSimulation(app, seed, other, role)
    await verifyCommercialMixed(app, seed, other, role)
    await verifyOpportunities(app, seed, other, role)
    await verifyCommercialMetrics(app, seed)
    if (backend !== "rust") await verifyCommercialProposals(app, seed, role)
    if (backend === "typescript") await verifyMcpDispatch(app, seed)
    if (backend === "gateway") await verifyMcpDispatch(app, seed, true)
    await seed.query("UPDATE platform_administrators SET active=false WHERE auth_subject='operator'")
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/orders/${foreignOrder}`, headers: operatorHeaders })).statusCode, 403)
    // A manage grant alone does not imply the read grant required by Rust writes.
    await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='catalog.products.read'", [readerRole])
    const manageOnly = await app.inject({ method: "PUT", url: `/api/v1/products/${productId}`, headers: { ...headers, "if-match": '"2"' }, payload: productInput })
    assert.equal(manageOnly.statusCode, 403, manageOnly.body)
    if (backend === "typescript") await verifySalesMail(seed, pool, tenant, readerRole, order, proposal)
    if (backend === "typescript") await verifyQualifiedReissue(seed, pool, tenant, readerRole)
  } finally {
    await app?.close()
    if (privateApp && privateApp !== app) await privateApp.close()
    await apiConnections.end()
    await seed.end()
    await admin.query(`DROP DATABASE ${database}`)
    await admin.query(`DROP ROLE IF EXISTS ${role}`)
    await admin.end()
  }
})
