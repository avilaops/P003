import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import test from "node:test"
import {stockFixture} from "./stock-fixture.js"
const admin=process.env.API_TS_TEST_ADMIN_URL
test("gross realized margin follows revised issue costs, customer returns and director permission", {skip:!admin},async t=>{
  const {app,tenant,seed,close}=await stockFixture(admin!);t.after(close)
  const product=randomUUID(),order=randomUUID(),issue=randomUUID()
  const headers={authorization:"Bearer fixture-editor-token","x-tenant-id":tenant}
  const post=(path:string,payload:object)=>app.inject({method:"POST",url:"/api/v1/stock/"+path,headers:{...headers,"idempotency-key":randomUUID()},payload})
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'MARGEM','Peça','UN',1500,'active')",[product,tenant])
  const entered=await post("movements",{productId:product,direction:"receipt",quantity:"1.000000",unitCost:"10.000000",reason:"Compra de peça"})
  assert.equal(entered.statusCode,201,entered.body)
  await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-02',1500,'completed')",[order,tenant])
  await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'MARGEM','Peça','UN',1000000,1500,1500)",[tenant,order,product])
  await seed.query("UPDATE stock_balances SET quantity_micros=0 WHERE tenant_id=$1 AND product_id=$2",[tenant,product])
  await seed.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_order_id) VALUES($1,$2,$3,'issue',1000000,0,'Venda faturada',$4)",[issue,tenant,product,order])
  const get=async()=>{const r=await app.inject({method:"GET",url:"/api/v1/orders/"+order,headers}); assert.equal(r.statusCode,200,r.body);return r.json().realizedMargin}
  assert.equal(await get(),undefined)
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT id,unnest(ARRAY['sales.approvals.director','platform.company.manage']) FROM roles WHERE code='editor'")
  assert.deepEqual(await get(),{revenue:"15.00",cost:"10.00",grossProfit:"5.00",marginPercent:"33.33"})
  const basis={kind:"receipt",productId:product,movementId:entered.json().id,freight:"3.00",recoverableTax:"1.00",reason:"Rateio da nota",revision:1}
  const update=await post("periods/basis",basis);assert.equal(update.statusCode,200,update.body)
  assert.equal((await post("periods/basis",basis)).statusCode,412)
  const source=await app.inject({method:"GET",url:"/api/v1/stock/periods/basis?productId="+product+"&movementId="+entered.json().id,headers})
  assert.deepEqual([source.json().revision,source.json().freight,source.json().recoverableTax],[2,"3.00","1.00"])
  assert.deepEqual(await get(),{revenue:"15.00",cost:"12.00",grossProfit:"3.00",marginPercent:"20.00"})
  await seed.query("UPDATE stock_balances SET quantity_micros=1000000 WHERE tenant_id=$1 AND product_id=$2",[tenant,product])
  await seed.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,reverses_id) VALUES($1,$2,$3,'receipt',1000000,1000000,'Devolução integral',$4)",[randomUUID(),tenant,product,issue])
  assert.deepEqual(await get(),{revenue:"0.00",cost:"0.00",grossProfit:"0.00",marginPercent:null})
})
