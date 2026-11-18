import test from "node:test"
import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import {stockFixture} from "./stock-fixture.js"

const admin=process.env.API_TS_TEST_ADMIN_URL
test("chooses the receiving and sales warehouse on each document line", {skip:!admin},async t=>{
  const {app,seed,tenant,close}=await stockFixture(admin!)
  t.after(close)
  const product=randomUUID(),site=randomUUID(),purchase=randomUUID(),sale=randomUUID(),receipt=randomUUID()
  await seed.query("UPDATE parties SET is_supplier=true WHERE tenant_id=$1",[tenant])
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT id,unnest(ARRAY['purchasing.orders.manage','purchasing.orders.read']) FROM roles WHERE code='editor'")
  await seed.query("INSERT INTO products(tenant_id,id,sku,name,unit,price_cents,status) VALUES($1,$2,'OR01','Reposição local','UN',100,'active')",[tenant,product])
  await seed.query("INSERT INTO warehouses(tenant_id,id,code,name,status,revision) VALUES($1,$2,'FILIAL','Depósito B','active',1)",[tenant,site])
  await seed.query("INSERT INTO stock_balances(tenant_id,product_id) VALUES($1,$2)",[tenant,product])
  await seed.query("UPDATE stock_location_settings SET enabled=true WHERE tenant_id=$1",[tenant])
  await seed.query("INSERT INTO purchase_orders(tenant_id,id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$1,'Fornecedor','52998224725','2027-10-10',100,'confirmed')",[tenant,purchase])
  await seed.query("INSERT INTO purchase_order_lines(tenant_id,order_id,product_id,line_number,sku,name,unit,quantity_micros,cost_cents,amount_cents) VALUES($1,$2,$3,1,'OR01','Reposição local','UN',1000000,100,100)",[tenant,purchase,product])
  const set=(kind:string,doc:string,previous:string|null,token="editor")=>app.inject({method:"PUT",url:"/api/v1/stock/document-locations/"+kind+"/"+doc,
    headers:{authorization:"Bearer fixture-"+token+"-token","x-tenant-id":tenant,"idempotency-key":randomUUID()},payload:{productId:product,warehouseId:site,previousWarehouseId:previous}})
  assert.equal((await set("purchase",purchase,null,"reader")).statusCode,403)
  const changed=await set("purchase",purchase,null)
  assert.equal(changed.statusCode,200,changed.body)
  assert.equal((await set("purchase",purchase,null)).statusCode,412)
  await seed.query("INSERT INTO purchase_receipts(tenant_id,id,order_id,reference,occurred_on,amount_cents) VALUES($1,$2,$3,'Recebimento','2026-11-18',100)",[tenant,receipt,purchase])
  await seed.query("UPDATE stock_balances SET quantity_micros=1000000 WHERE tenant_id=$1 AND product_id=$2",[tenant,product])
  await seed.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_purchase_receipt_id) VALUES($1,$2,$3,'receipt',1000000,1000000,'Recebimento de compra',$4)",[randomUUID(),tenant,product,receipt])
  await seed.query("INSERT INTO sales_orders(tenant_id,id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$1,'Cliente','52998224725','2027-01-02',100,'accepted')",[tenant,sale])
  await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,product_id,line_number,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,$3,1,'OR01','Reposição local','UN',1000000,100,100)",[tenant,sale,product])
  assert.equal((await set("sale",sale,null)).statusCode,200)
  await seed.query("UPDATE sales_orders SET status='confirmed' WHERE tenant_id=$1 AND id=$2",[tenant,sale])
  const positions=await seed.query("SELECT r.warehouse_id,r.quantity_micros AS reserved,p.quantity_micros AS quantity FROM stock_location_reservations r JOIN stock_positions p USING(tenant_id,warehouse_id,product_id) WHERE r.order_id=$1",[sale])
  assert.deepEqual(positions.rows,[{warehouse_id:site,reserved:"1000000",quantity:"1000000"}])
})
