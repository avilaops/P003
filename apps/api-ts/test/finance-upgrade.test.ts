import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { copyFile, mkdtemp, readdir, rmdir, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { buildApp } from "../src/app.js"
import { PostgresPool } from "../src/platform/database.js"
import { runMigrations } from "../src/platform/migrations.js"

test("atualiza carteira anterior com baixa parcial e preserva a origem do saldo", {
  skip: !process.env.API_TS_TEST_ADMIN_URL,
}, async () => {
  const directory = fileURLToPath(new URL("../../../migrations/", import.meta.url))
  const baseline = await mkdtemp(join(tmpdir(), "finance-upgrade-"))
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL!)
  const database = "finance_upgrade_" + randomUUID().replaceAll("-", "")
  const admin = new Pool({ connectionString: url.toString() })
  await admin.query("CREATE DATABASE " + database)
  url.pathname = "/" + database
  const db = new Pool({ connectionString: url.toString() })
  const apiPool = new PostgresPool(url.toString(), 2)
  const app = buildApp({ pool: apiPool, userinfoUrl: "https://example.test/auth",
    fetchAuth: async () => Response.json({ sub: "historico", email: "operador@example.test" }) })
  try {
    for (const name of await readdir(directory)) {
      if (name.endsWith(".sql") && name < "202611180001") await copyFile(join(directory, name), join(baseline, name))
    }
    assert.ok((await runMigrations(db, { directory: baseline })).applied.length > 0)
    const tenant = randomUUID(), customer = randomUUID(), order = randomUUID(), title = randomUUID()
    const identity = randomUUID(), membership = randomUUID(), role = randomUUID()
    await db.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa histórica','04252011000110')", [tenant])
    await db.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,'historico','operador@example.test','Operador')", [identity])
    await db.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [membership, tenant, identity])
    await db.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'admin','Administrador')", [role, tenant])
    await db.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, role])
    await db.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'finance.receivables.read')", [role])
    await db.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'juridica','Cliente','04252011000110',true,false,'active')", [customer, tenant])
    await db.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','04252011000110',current_date,100000,'completed')", [order, tenant, customer])
    await db.query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente',current_date,100000,'open')", [title, tenant, order])
    await db.query("INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on) VALUES(gen_random_uuid(),$1,$2,'receipt',40000,'other','baixa anterior',current_date-1)", [tenant, title])
    const upgrade = await runMigrations(db, { directory })
    assert.ok(upgrade.applied.includes("202611180001"))
    assert.deepEqual((await runMigrations(db, { directory })).applied, [])
    const headers = { authorization: "Bearer historico", "x-tenant-id": tenant }
    const res = await app.inject({ method: "GET", url: "/api/v1/receivables/" + title, headers })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.json().data.outstandingAmount, "600.00")
    assert.equal(res.json().payments[0].financialEffect, "unclassified")
    const report = await app.inject({ method: "GET", url: "/api/v1/finance/portfolio", headers })
    assert.equal(report.statusCode, 200, report.body)
    assert.equal(report.json().totals.receivable, "600.00")
    assert.equal((await db.query("SELECT count(*) FROM financial_account_entries WHERE tenant_id=$1", [tenant])).rows[0].count, "0")
    const grants = await db.query("SELECT permission_code FROM role_permissions WHERE role_id=$1 AND permission_code=ANY($2) ORDER BY 1", [role, ["finance.collections.manage", "finance.reconciliation.close", "finance.discounts.approve"]])
    assert.equal(grants.rowCount, 3)
  } finally {
    await app.close()
    await apiPool.close()
    await db.end()
    await admin.query("DROP DATABASE " + database)
    await admin.end()
    for (const name of await readdir(baseline)) await unlink(join(baseline, name))
    await rmdir(baseline)
  }
})
