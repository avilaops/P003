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
      const client = await seed.connect()
      await client.query(`SET ROLE ${role}`)
      return { async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) { const result = await client.query<T>(sql, [...values]); return { rows: result.rows } }, release() { client.release() } }
    } }
    app = buildApp({ pool, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async () => Response.json({ sub: "reader", email: "reader@example.test" }) })
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
  } finally {
    await app?.close()
    await seed.end()
    await admin.query(`DROP DATABASE ${database}`)
    await admin.query(`DROP ROLE IF EXISTS ${role}`)
    await admin.end()
  }
})
