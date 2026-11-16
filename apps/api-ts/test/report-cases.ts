import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"

export async function verifyReports(app: FastifyInstance, seed: Pool, databaseRole: string) {
  await seed.query(`GRANT USAGE ON SCHEMA system_config TO ${databaseRole}; GRANT EXECUTE ON FUNCTION system_config.has_permission(text) TO ${databaseRole}; GRANT SELECT,INSERT,UPDATE ON system_config.report_definitions TO ${databaseRole}`)
  const tenant = randomUUID(), editor = randomUUID(), viewer = randomUUID(), editorRole = randomUUID(), viewerRole = randomUUID(), product = randomUUID(), currentOrder = randomUUID(), title = randomUUID(), receipt = randomUUID()
  await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Relatórios','11222333000181')", [tenant])
  for (const [id, subject, permissionRole, permissions] of [[editor, "reports-editor", editorRole, ["system.reports.read", "system.reports.manage", "catalog.products.read", "sales.orders.read", "finance.receivables.read", "finance.payables.read"]], [viewer, "reports-viewer", viewerRole, ["system.reports.read", "catalog.products.read"]]] as const) {
    const membership = randomUUID()
    await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,$2,$3,'Relatórios')", [id, subject, `${subject}@example.test`])
    await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [membership, tenant, id])
    await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,$3,'Relatórios')", [permissionRole, tenant, subject])
    await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, permissionRole])
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])", [permissionRole, permissions])
  }
  await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Cliente','52998224725',true,false,'active')", [tenant])
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'REPORT','Relatório','UN',10000,'active')", [product, tenant])
  for (const [id, amount, status, age] of [[currentOrder, 10000, "draft", "0 days"], [randomUUID(), 20000, "completed", "0 days"], [randomUUID(), 99000, "cancelled", "0 days"], [randomUUID(), 50000, "draft", "2 years"]] as const) {
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status,created_at) VALUES($1,$2,$2,'Cliente','52998224725',CURRENT_DATE,$3,$4,now()-$5::interval)", [id, tenant, amount, status, age])
  }
  await seed.query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente',CURRENT_DATE,10000,'open')", [title, tenant, currentOrder])
  await seed.query("INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on) VALUES($1,$2,$3,'receipt',2500,'cash','Parcial',CURRENT_DATE)", [receipt, tenant, title])
  const headers = { authorization: "Bearer reports-editor", "x-tenant-id": tenant }, viewerHeaders = { ...headers, authorization: "Bearer reports-viewer" }
  const dashboard = await app.inject({ method: "GET", url: "/api/v1/dashboard?period=30D", headers })
  assert.equal(dashboard.statusCode, 200, dashboard.body)
  assert.deepEqual(dashboard.json().sales, { orders: 2, cancelled: 1, amount: "300.00", average: "150.00" })
  assert.equal(dashboard.json().salesSeries[0].orders, 2)
  assert.equal(dashboard.json().receivables, "75.00")
  assert.equal(dashboard.json().purchasePayables, "0.00")
  assert.equal(dashboard.json().products, 1)
  assert.equal(dashboard.json().customers, null)
  await seed.query("INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on,reverses_id) VALUES($1,$2,$3,'reversal',2500,'cash','Estorno parcial',CURRENT_DATE,$4)", [randomUUID(), tenant, title, receipt])
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/dashboard", headers })).json().receivables, "100.00")
  const limited = await app.inject({ method: "GET", url: "/api/v1/dashboard", headers: viewerHeaders })
  assert.equal(limited.statusCode, 200, limited.body)
  for (const field of ["sales", "salesSeries", "receivables", "purchasePayables", "customers"]) assert.equal(limited.json()[field], null)
  for (const period of ["7D", "30D", "3M", "6M", "12M"]) assert.equal((await app.inject({ method: "GET", url: `/api/v1/dashboard?period=${period}`, headers })).statusCode, 200)
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/dashboard?period=invalid", headers })).statusCode, 422)
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/dashboard?unknown=true", headers })).statusCode, 422)
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/dashboard", headers: { ...headers, "x-tenant-id": randomUUID() } })).statusCode, 403)

  const url = "/api/v1/system/custom-reports", input = { name: " Produtos ativos ", dataset: "products", columns: ["name", "code", "name"], filters: { status: "active" } }
  const created = await app.inject({ method: "POST", url, headers, payload: input })
  assert.equal(created.statusCode, 201, created.body)
  assert.equal(created.json().data.name, "Produtos ativos")
  assert.equal(created.json().data.visibility, "private")
  assert.deepEqual(created.json().data.columns, ["name", "code"])
  const id = created.json().data.id as string
  assert.equal(created.headers.etag, '"1"')
  const foreignTenant = (await seed.query("SELECT id FROM tenants WHERE id<>$1 ORDER BY id LIMIT 1", [tenant])).rows[0].id
  const foreignEdit = await app.inject({ method: "PUT", url: `${url}/${id}`, headers: { authorization: "Bearer operator", "x-tenant-id": foreignTenant, "if-match": '"1"' }, payload: input })
  assert.equal(foreignEdit.statusCode, 404, foreignEdit.body)
  const noMembership = await app.inject({ method: "POST", url, headers: { ...headers, authorization: "Bearer operator" }, payload: input })
  assert.equal(noMembership.statusCode, 403, noMembership.body)
  assert.equal((await app.inject({ method: "GET", url, headers })).json().data.length, 1)
  assert.equal((await app.inject({ method: "GET", url, headers: viewerHeaders })).json().data.length, 0, "Private reports are owner scoped by RLS")
  assert.equal((await app.inject({ method: "POST", url, headers: viewerHeaders, payload: input })).statusCode, 403)
  const shared = { ...input, visibility: "tenant" }
  assert.equal((await app.inject({ method: "PUT", url: `${url}/${id}`, headers, payload: shared })).statusCode, 428)
  const edits = await Promise.all(["Produtos A", "Produtos B"].map(name => app.inject({ method: "PUT", url: `${url}/${id}`, headers: { ...headers, "if-match": '"1"' }, payload: { ...shared, name } })))
  assert.deepEqual(edits.map(response => response.statusCode).sort(), [200, 412])
  const visible = await app.inject({ method: "GET", url, headers: viewerHeaders })
  assert.equal(visible.json().data.length, 1)
  assert.equal(visible.json().canEdit, false)
  await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='catalog.products.read'", [viewerRole])
  assert.equal((await app.inject({ method: "GET", url, headers: viewerHeaders })).json().data.length, 0, "Dataset rights also apply to shared reports")
  for (const invalid of [{ dataset: "sql" }, { columns: ["raw_sql"] }, { filters: { status: {} } }, { filters: { unknown: "x" } }, { name: "😀".repeat(31) }, { visibility: "public" }, { sql: "SELECT 1" }]) {
    const response = await app.inject({ method: "POST", url, headers, payload: { ...input, ...invalid } })
    assert.equal(response.statusCode, 422, response.body)
  }
  assert.equal((await app.inject({ method: "POST", url, headers, payload: { name: "Pessoas", dataset: "parties", columns: ["name"] } })).statusCode, 403)
  const evidence = await seed.query("SELECT (SELECT count(*)::int FROM audit_log WHERE entity_id=$1) AS audits,(SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$1) AS events", [id])
  assert.deepEqual(evidence.rows[0], { audits: 2, events: 2 })
  await seed.query(`REVOKE INSERT ON outbox_events FROM ${databaseRole}`)
  assert.equal((await app.inject({ method: "POST", url, headers, payload: { ...input, name: "Rollback" } })).statusCode, 500)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM system_config.report_definitions WHERE tenant_id=$1 AND name='Rollback'", [tenant])).rows[0].count, 0)
  await seed.query(`GRANT INSERT ON outbox_events TO ${databaseRole}`)
  const exact = await app.inject({ method: "POST", url, headers: { ...headers, "content-type": "application/json" }, payload: '{"name":"Inteiro exato","dataset":"products","columns":["status"],"filters":{"status":9007199254740993}}' })
  assert.equal(exact.statusCode, 201, exact.body)
  assert.ok(exact.body.includes('"status":9007199254740993'), "A numeric filter must keep its original integer token")
  const exactId = exact.json().data.id
  assert.equal((await seed.query("SELECT filters->>'status' AS value FROM system_config.report_definitions WHERE tenant_id=$1 AND id=$2", [tenant, exactId])).rows[0].value, "9007199254740993")
  const unbounded = await app.inject({ method: "POST", url, headers: { ...headers, "content-type": "application/json" }, payload: '{"name":"Número inválido","dataset":"products","columns":["status"],"filters":{"status":1e400}}' })
  assert.equal(unbounded.statusCode, 422, unbounded.body)
}
