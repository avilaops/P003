import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"

export async function verifyTransitionGuards(app: FastifyInstance, seed: Pool, tenant: string, product: string, method: string) {
  const headers = { authorization: "Bearer operator", "x-tenant-id": tenant }
  const transition = (id: string, action: string, revision = 1, key = randomUUID(), token = "operator") => app.inject({ method: "POST", url: `/api/v1/orders/${id}/${action}`, headers: { ...headers, authorization: `Bearer ${token}`, "idempotency-key": key, "if-match": `"${revision}"` } })
  const create = async (status = "draft", schedule = false) => {
    const id = randomUUID()
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-01',10000,$3)", [id, tenant, status])
    await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'TRANSITION','Equipamento','UN',1000000,10000,10000)", [tenant, id, product])
    if (schedule) {
      await seed.query("INSERT INTO sales_order_checkouts(tenant_id,order_id,customer_snapshot,entry_amount_cents,delivery_notes,payment_notes,notes) VALUES($1,$2,'{\"legalName\":\"Cliente\"}',0,'','','')", [tenant, id])
      await seed.query("INSERT INTO sales_order_installments(id,tenant_id,order_id,number,kind,payment_method_id,payment_method,due_on,amount_cents) VALUES($1,$2,$3,1,'balance',$4,$5,'2027-01-01',10000)", [randomUUID(), tenant, id, method, { id: method, code: "TRANSITION", name: "Pix", modality: "pix" }])
    }
    return id
  }
  await seed.query("UPDATE stock_balances SET quantity_micros=50000000 WHERE tenant_id=$1 AND product_id=$2", [tenant, product])
  const id = await create()
  await seed.query("INSERT INTO sales_settings(tenant_id,minimum_order_amount_cents,maximum_payment_term_days,require_customer_contact,revision) VALUES($1,10001,3650,false,1)", [tenant])
  assert.equal((await transition(id, "confirm")).statusCode, 409, "Minimum amount must apply")
  await seed.query("UPDATE sales_settings SET minimum_order_amount_cents=0,maximum_payment_term_days=0 WHERE tenant_id=$1", [tenant])
  assert.equal((await transition(id, "confirm")).statusCode, 409, "Payment term must apply")
  // Saving a draft enforces the same limit, before the order reaches confirmation.
  const save = (dueDate: string) => app.inject({ method: "PUT", url: `/api/v1/orders/${id}`, headers: { ...headers, "idempotency-key": randomUUID(), "if-match": '"1"' }, payload: { customerId: tenant, dueDate, items: [{ productId: product, quantity: "1.000000" }] } })
  const lateDraft = await save("2027-01-01")
  assert.equal(lateDraft.statusCode, 409, lateDraft.body)
  assert.equal(lateDraft.json().title, "Vencimento excede o prazo máximo configurado em Preferências / Vendas")
  assert.equal((await seed.query("SELECT revision::int AS revision FROM sales_orders WHERE id=$1", [id])).rows[0].revision, 1)
  await seed.query("UPDATE sales_settings SET maximum_payment_term_days=3650,require_customer_contact=true WHERE tenant_id=$1", [tenant])
  await seed.query("UPDATE parties SET email=NULL,phone=NULL WHERE tenant_id=$1 AND id=$1", [tenant])
  assert.equal((await transition(id, "confirm")).statusCode, 409, "Contact is required by saved settings")
  await seed.query("UPDATE parties SET email='cliente@example.test',status='archived' WHERE tenant_id=$1 AND id=$1", [tenant])
  assert.equal((await transition(id, "confirm")).statusCode, 409, "Archived customer cannot confirm")
  await seed.query("UPDATE parties SET status='active' WHERE tenant_id=$1 AND id=$1", [tenant])
  await seed.query("UPDATE products SET status='archived' WHERE tenant_id=$1 AND id=$2", [tenant, product])
  assert.equal((await transition(id, "confirm")).statusCode, 409, "Archived product cannot confirm")
  await seed.query("UPDATE products SET status='active',unit='KG' WHERE tenant_id=$1 AND id=$2", [tenant, product])
  assert.equal((await transition(id, "confirm")).statusCode, 409, "Historical unit must be preserved")
  await seed.query("UPDATE products SET unit='UN' WHERE tenant_id=$1 AND id=$2", [tenant, product])
  const version = (await seed.query("SELECT active_price_version_id FROM commercial_settings WHERE tenant_id=$1 AND product_line='imported'", [tenant])).rows[0].active_price_version_id
  await seed.query("INSERT INTO order_pricing_snapshots(tenant_id,order_id,version_id,snapshot,needs_approval) VALUES($1,$2,$3,'{}',true)", [tenant, id, version])
  assert.equal((await transition(id, "confirm")).statusCode, 409, "Simulation approval is required")
  await seed.query("UPDATE order_pricing_snapshots SET approved_by='operator',approved_at=now(),approval_reason='Aprovação explícita' WHERE tenant_id=$1 AND order_id=$2", [tenant, id])
  await seed.query("INSERT INTO commercial_order_quotes(tenant_id,order_id,price_version_id,public_snapshot,private_snapshot,approval_rules,approval_status,requires_director,created_by) SELECT $1,$2,$3,'{}','{}','{}','pending',false,id FROM identities WHERE auth_subject='operator'", [tenant, id, version])
  assert.equal((await transition(id, "confirm")).statusCode, 409, "Quote approval is required independently")
  await seed.query("UPDATE commercial_order_quotes SET approval_status='approved' WHERE tenant_id=$1 AND order_id=$2", [tenant, id])
  const confirmed = await transition(id, "confirm")
  assert.equal(confirmed.statusCode, 200, confirmed.body)
  // A production draft blocks completion until an authorized production NF-e exists.
  const fiscal = randomUUID()
  await seed.query("INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents) VALUES($1,$2,'production',55,1,1,'{}',$3,10000)", [tenant, fiscal, { sourceOrderId: id }])
  assert.equal((await transition(id, "complete", 2)).statusCode, 409)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM stock_movements WHERE source_order_id=$1", [id])).rows[0].count, 0)
  await seed.query("INSERT INTO fiscal_nfe_documents(tenant_id,id,source_order_id,environment,status,series,number,issued_at,random_code,signed_xml,access_key,protocol,authorized_xml) VALUES($1,$2,$3,'production','authorized',1,1,'2026-11-16T00:00:00-03:00','12345678','<xml/>',repeat('1',44),'protocol','<xml/>')", [tenant, fiscal, id])
  const completed = await transition(id, "complete", 2)
  assert.equal(completed.statusCode, 200, completed.body)

  const paid = await create("draft", true)
  const accepted = await transition(paid, "accept")
  assert.equal(accepted.statusCode, 200, accepted.body)
  const receipt = randomUUID(), title = (await seed.query("SELECT id FROM receivables WHERE tenant_id=$1 AND order_id=$2", [tenant, paid])).rows[0].id
  await seed.query("INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on) VALUES($1,$2,$3,'receipt',100,'cash','Recebimento teste','2026-11-16')", [receipt, tenant, title])
  const deniedCancel = await transition(paid, "cancel", 2)
  assert.equal(deniedCancel.statusCode, 409, deniedCancel.body)
  assert.equal((await seed.query("SELECT status FROM receivables WHERE id=$1", [title])).rows[0].status, "open")
  await seed.query("INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on,reverses_id) VALUES($1,$2,$3,'reversal',100,'cash','Estorno explícito','2026-11-16',$4)", [randomUUID(), tenant, title, receipt])
  // Accepted terms remain frozen even after a policy becomes stricter.
  await seed.query("UPDATE sales_settings SET minimum_order_amount_cents=999999 WHERE tenant_id=$1", [tenant])
  const fulfilled = await transition(paid, "confirm", 2)
  assert.equal(fulfilled.statusCode, 200, fulfilled.body)
  const cancelled = await transition(paid, "cancel", 3)
  assert.equal(cancelled.statusCode, 200, cancelled.body)

  // Cancelling an order with consumed components restores them once and checks
  // production/inventory rights again before replaying its original response.
  const productionOrder = await create("accepted"), stage = randomUUID(), job = randomUUID(), movement = randomUUID()
  await seed.query("INSERT INTO production_stages(id,tenant_id,name,kind,position) VALUES($1,$2,'Corte','andamento',1)", [stage, tenant])
  await seed.query("INSERT INTO production_orders(id,tenant_id,order_id,product_id,sku,name,unit,quantity_micros,stage_id) VALUES($1,$2,$3,$4,'TRANSITION','Equipamento','UN',1000000,$5)", [job, tenant, productionOrder, product, stage])
  await seed.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,production_order_id) VALUES($1,$2,$3,'issue',1000000,47000000,'Consumo produção',$4)", [movement, tenant, product, job])
  await seed.query("UPDATE stock_balances SET quantity_micros=47000000 WHERE tenant_id=$1 AND product_id=$2", [tenant, product])
  await seed.query("INSERT INTO production_consumptions(tenant_id,production_order_id,stock_movement_id,product_id,sku,name,unit,quantity_micros,unit_cost_cents,amount_cents) VALUES($1,$2,$3,$4,'TRANSITION','Equipamento','UN',1000000,0,0)", [tenant, job, movement, product])
  const identity = randomUUID(), membership = randomUUID(), permissionRole = randomUUID()
  await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,'transition-seller','seller@example.test','Vendedor')", [identity])
  await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [membership, tenant, identity])
  await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'TRANSITION','Transições')", [permissionRole, tenant])
  await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, permissionRole])
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])", [permissionRole, ["sales.orders.read", "sales.orders.manage", "production.read", "production.manage"]])
  const cancellationKey = randomUUID()
  assert.equal((await transition(productionOrder, "cancel", 1, cancellationKey, "transition-seller")).statusCode, 403)
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'inventory.stock.read'),($1,'inventory.stock.manage')", [permissionRole])
  const cancelledProduction = await transition(productionOrder, "cancel", 1, cancellationKey, "transition-seller")
  assert.equal(cancelledProduction.statusCode, 200, cancelledProduction.body)
  assert.equal((await seed.query("SELECT status FROM production_orders WHERE id=$1", [job])).rows[0].status, "cancelled")
  assert.equal((await seed.query("SELECT quantity_micros::text AS quantity FROM stock_balances WHERE tenant_id=$1 AND product_id=$2", [tenant, product])).rows[0].quantity, "48000000")
  assert.deepEqual((await transition(productionOrder, "cancel", 1, cancellationKey, "transition-seller")).json(), cancelledProduction.json())
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM stock_movements WHERE reverses_id=$1", [movement])).rows[0].count, 1)
  await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='inventory.stock.manage'", [permissionRole])
  assert.equal((await transition(productionOrder, "cancel", 1, cancellationKey, "transition-seller")).statusCode, 403)
}
