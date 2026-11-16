import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"

export async function verifyCommercialMetrics(app: FastifyInstance, seed: Pool) {
  const tenant = randomUUID(), identity = randomUUID(), membership = randomUUID(), role = randomUUID(), staff = randomUUID()
  await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Métricas','99888777000166')", [tenant])
  await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,'metrics-reader','metrics@example.test','Métricas')", [identity])
  await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [membership, tenant, identity])
  await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'METRICS','Métricas')", [role, tenant])
  await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, role])
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'sales.orders.read')", [role])
  await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Cliente','52998224725',true,false,'active')", [tenant])
  const ids: string[] = []
  for (const [status, amount, occurred, discount] of [["draft", 10000, null, null], ["accepted", 20000, null, null], ["confirmed", 30000, null, null], ["completed", 30000, "2026-11-05T12:00:00Z", 1000], ["completed", 40000, "2026-10-31T12:00:00Z", null], ["completed", 50000, "2026-12-01T02:00:00Z", 2000], ["completed", 60000, "2026-12-01T03:00:00Z", null], ["cancelled", 70000, null, null]] as const) {
    const id = randomUUID(); ids.push(id)
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status,created_at) VALUES($1,$2,$2,'Cliente','52998224725','2026-11-01',$3,$4,'2020-01-01')", [id, tenant, amount, status])
    if (occurred) await seed.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,entity_id,details,occurred_at) VALUES($1,$2,'order.completed','sales_order',$3,'{}',$4)", [tenant, identity, id, occurred])
    if (discount !== null || status === "draft") await seed.query("INSERT INTO commercial_order_quotes(tenant_id,order_id,price_version_id,public_snapshot,private_snapshot,approval_rules,approval_status,requires_director,created_by) VALUES($1,$2,NULL,$3,'{}','{}',$4,false,$5)", [tenant, id, { sale: { discountBps: discount } }, status === "draft" ? "pending" : "not_required", identity])
  }
  const headers = { authorization: "Bearer metrics-reader", "x-tenant-id": tenant }, prefix = "/api/v1/commercial/metrics"
  const orders = await app.inject({ method: "GET", url: `${prefix}/orders?month=2026-11`, headers })
  assert.equal(orders.statusCode, 200, orders.body)
  assert.deepEqual(orders.json().data, { month: "2026-11", openCents: 60000, openCount: 3, completedCents: 80000, completedCount: 2, pendingApprovalCount: 1, averageDiscountBps: 1500 })
  assert.equal((await app.inject({ method: "GET", url: `${prefix}/commissions?month=2026-11`, headers })).statusCode, 403)
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'finance.commissions.read')", [role])
  await seed.query("INSERT INTO staff(id,tenant_id,code,name,is_employee,is_seller,status) VALUES($1,$2,'METRICS','Vendedor',false,true,'active')", [staff, tenant])
  await seed.query("INSERT INTO commission_accounts(tenant_id,seller_staff_id) VALUES($1,$2)", [tenant, staff])
  for (const [month, amount] of [["2026-11-01", 1000], ["2026-10-01", -200]] as const) await seed.query("INSERT INTO commission_entries(id,tenant_id,seller_staff_id,seller_name,kind,competence,payment_due,base_cents,payment_day,amount_cents,reason) VALUES($1,$2,$3,'Vendedor','adjustment',$4,'2026-12-10',0,10,$5,'Ajuste de teste')", [randomUUID(), tenant, staff, month, amount])
  const accepted = ids[1]!, title = randomUUID(), receipt = randomUUID()
  await seed.query("UPDATE sales_orders SET status='draft' WHERE tenant_id=$1 AND id=$2", [tenant, accepted])
  await seed.query("INSERT INTO order_commission_terms(tenant_id,order_id,seller_staff_id,seller_name,commission_rate,ipi_rate,payment_day) VALUES($1,$2,$3,'Vendedor',50000,130000,10)", [tenant, accepted, staff])
  await seed.query("UPDATE sales_orders SET status='accepted' WHERE tenant_id=$1 AND id=$2", [tenant, accepted])
  await seed.query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','2026-12-01',20000,'open')", [title, tenant, accepted])
  await seed.query("INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on) VALUES($1,$2,$3,'receipt',5000,'cash','Parcial','2026-11-16')", [receipt, tenant, title])
  const commissions = await app.inject({ method: "GET", url: `${prefix}/commissions?month=2026-11`, headers })
  assert.equal(commissions.statusCode, 200, commissions.body)
  assert.deepEqual(commissions.json().data, { month: "2026-11", receivedBaseCents: 0, commissionCents: 1000, sellerCount: 1, outstandingCents: 800, futureCents: 664 })
  await seed.query("INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on,reverses_id) VALUES($1,$2,$3,'reversal',5000,'cash','Estorno parcial','2026-11-16',$4)", [randomUUID(), tenant, title, receipt])
  assert.equal((await app.inject({ method: "GET", url: `${prefix}/commissions?month=2026-11`, headers })).json().data.futureCents, 885)
  for (const query of ["?month=2026-13", "?month=2026-1", "?unknown=true", "?month=2026-11&month=2026-12"]) assert.equal((await app.inject({ method: "GET", url: `${prefix}/orders${query}`, headers })).statusCode, 422)
  assert.equal((await app.inject({ method: "GET", url: `${prefix}/orders`, headers: { ...headers, "x-tenant-id": randomUUID() } })).statusCode, 403)
}
