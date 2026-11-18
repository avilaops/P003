import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import test from "node:test"
import {stockFixture} from "./stock-fixture.js"

const admin=process.env.API_TS_TEST_ADMIN_URL
test("purchase suggestions account for reservations, demand, open receipts and lot size", {skip:!admin}, async t=>{
  const {app,seed,tenant,otherTenant,close}=await stockFixture(admin!)
  t.after(close)
  const product=randomUUID(),purchase=randomUUID()
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'REP','Reposição','KG',100,'active')",[product,tenant])
  await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,8000000)",[tenant,product])
  const headers={authorization:"Bearer fixture-editor-token","x-tenant-id":tenant,"idempotency-key":randomUUID()}
  const url="/api/v1/stock/replenishment/"+product
  const payload={minimum:"10.000000",reorderPoint:"15.000000",purchaseLot:"5.000000",leadDays:7,revision:1}
  const set=await app.inject({method:"PUT",url,headers,payload})
  assert.equal(set.statusCode,200,set.body)
  assert.equal((await app.inject({method:"PUT",url,headers:{...headers,authorization:"Bearer fixture-reader-token"},payload})).statusCode,403)
  assert.equal((await app.inject({method:"GET",url,headers:{...headers,"x-tenant-id":otherTenant}})).statusCode,404)
  for(const [status,qty] of [["accepted",4],["confirmed",3]] as const){
    const order=randomUUID()
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-02',$3,$4)",[order,tenant,qty*100,status])
    await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'REP','Reposição','KG',$4,100,$5)",[tenant,order,product,qty*1e6,qty*100])
  }
  await seed.query("UPDATE parties SET is_supplier=true WHERE tenant_id=$1 AND id=$1",[tenant])
  await seed.query("INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Fornecedor','52998224725','2027-01-03',500,'partially_received')",[purchase,tenant])
  await seed.query("INSERT INTO purchase_order_lines(tenant_id,order_id,product_id,line_number,sku,name,unit,quantity_micros,received_micros,cost_cents,amount_cents) VALUES($1,$2,$3,1,'REP','Reposição','KG',5000000,2000000,100,500)",[tenant,purchase,product])
  const list=async()=>{
    const response=await app.inject({method:"GET",url:"/api/v1/stock/replenishment",headers})
    assert.equal(response.statusCode,200,response.body)
    return response.json().data[0]
  }
  let row=await list()
  assert.deepEqual([row.available,row.acceptedDemand,row.openPurchases,row.netNeed,row.suggested],["5.000000","4.000000","3.000000","6.000000","10.000000"])
  await seed.query("UPDATE purchase_orders SET status='closed' WHERE id=$1 AND tenant_id=$2",[purchase,tenant])
  row=await list()
  assert.deepEqual([row.openPurchases,row.netNeed,row.suggested],["0.000000","9.000000","10.000000"])
  const precision=await app.inject({method:"PUT",url,headers:{...headers,"idempotency-key":randomUUID()},
    payload:{...payload,revision:2,minimum:"200000000001.000001",reorderPoint:"200000000002.000000",purchaseLot:"100000000000.000000"}})
  assert.equal(precision.statusCode,200,precision.body)
  row=await list()
  assert.equal(row.suggested,"300000000000.000000")
})
