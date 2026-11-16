import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { Pool } from "pg"

import { buildApp } from "../src/app.js"
import type { DatabasePool } from "../src/platform/database.js"

// Opt in with a disposable PostgreSQL administrator URL. The generated database
// and NOLOGIN role belong exclusively to this test and are removed afterwards.
test("PostgreSQL migrations and RLS support sales detail queries and tenant isolation", { skip: !process.env.API_TS_TEST_ADMIN_URL }, async () => {
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL!)
  const suffix = randomUUID().replaceAll("-", ""), database = `api_ts_test_${suffix}`, role = `api_ts_role_${suffix}`
  const admin = new Pool({ connectionString: url.toString() })
  await admin.query(`CREATE DATABASE ${database}`)
  url.pathname = `/${database}`
  const seed = new Pool({ connectionString: url.toString() })
  const apiConnections = new Pool({ connectionString: url.toString() })
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const directory = new URL("../../../migrations/", import.meta.url)
    for (const file of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
      await seed.query(await readFile(new URL(file, directory), "utf8"))
    }
    await seed.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    await seed.query(`GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`)
    const tenant = randomUUID(), other = randomUUID(), identity = randomUUID(), membership = randomUUID(), readerRole = randomUUID(), product = randomUUID(), order = randomUUID(), proposal = randomUUID(), foreignOrder = randomUUID()
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
      return { async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) { const result = await client.query<T>(sql, [...values]); return { rows: result.rows } }, release() { client.release() } }
    } }
    app = buildApp({ pool, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async (_url, init) => Response.json({ sub: new Headers(init?.headers).get("authorization")?.slice(7), email: "reader@example.test" }) })
    const headers = { authorization: "Bearer reader", "x-tenant-id": tenant }
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
    await seed.query(`GRANT INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`)
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
    await seed.query("UPDATE platform_administrators SET active=false WHERE auth_subject='operator'")
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/orders/${foreignOrder}`, headers: operatorHeaders })).statusCode, 403)
    // A manage grant alone does not imply the read grant required by Rust writes.
    await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='catalog.products.read'", [readerRole])
    const manageOnly = await app.inject({ method: "PUT", url: `/api/v1/products/${productId}`, headers: { ...headers, "if-match": '"2"' }, payload: productInput })
    assert.equal(manageOnly.statusCode, 403, manageOnly.body)
  } finally {
    await app?.close()
    await apiConnections.end()
    await seed.end()
    await admin.query(`DROP DATABASE ${database}`)
    await admin.query(`DROP ROLE IF EXISTS ${role}`)
    await admin.end()
  }
})
