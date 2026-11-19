import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import test from "node:test"
import {stockFixture} from "./stock-fixture.js"
const admin=process.env.API_TS_TEST_ADMIN_URL
test("gross realized margin follows stock costs and current permissions on order completion replay", {skip:!admin},async t=>{
  const {app,tenant,seed,close}=await stockFixture(admin!);t.after(close)
  const product=randomUUID(),order=randomUUID()
  const headers={authorization:"Bearer fixture-editor-token","x-tenant-id":tenant}
  const post=(path:string,payload:object)=>app.inject({method:"POST",url:"/api/v1/stock/"+path,headers:{...headers,"idempotency-key":randomUUID()},payload})
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'MARGEM','Peça','UN',1500,'active')",[product,tenant])
  const entered=await post("movements",{productId:product,direction:"receipt",quantity:"1.000000",unitCost:"10.000000",reason:"Compra de peça"})
  assert.equal(entered.statusCode,201,entered.body)
  await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-02',1500,'confirmed')",[order,tenant])
  await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'MARGEM','Peça','UN',1000000,1500,1500)",[tenant,order,product])
  const get=async()=>{const r=await app.inject({method:"GET",url:"/api/v1/orders/"+order,headers}); assert.equal(r.statusCode,200,r.body);return r.json().realizedMargin}
  const grant=async(permission:string)=>seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT id,$2 FROM roles WHERE tenant_id=$1 AND code='editor'",[tenant,permission])
  const required=["sales.approvals.director","platform.company.manage"]
  for(const permission of required)await grant(permission)
  const key=randomUUID()
  const complete=()=>app.inject({method:"POST",url:"/api/v1/orders/"+order+"/complete",headers:{...headers,"if-match":'"1"',"idempotency-key":key}})
  const written=await complete()
  assert.equal(written.statusCode,200,written.body)
  const {realizedMargin:initialMargin,...visible}=written.json()
  assert.deepEqual(initialMargin,{revenue:"15.00",cost:"10.00",grossProfit:"5.00",marginPercent:"33.33"})
  for(const permission of required){
    await seed.query("DELETE FROM role_permissions p USING roles r WHERE p.role_id=r.id AND r.tenant_id=$1 AND r.code='editor' AND p.permission_code=$2",[tenant,permission])
    assert.equal(await get(),undefined)
    const reduced=await complete()
    assert.equal(reduced.statusCode,200,reduced.body)
    assert.equal(reduced.headers.etag,written.headers.etag)
    assert.deepEqual(reduced.json(),visible)
    await grant(permission)
  }
  assert.deepEqual((await complete()).json(),written.json())
  const saved=(await seed.query("SELECT result FROM domain_commands WHERE tenant_id=$1 AND command_key=$2 AND scope='order.complete'",[tenant,key])).rows
  assert.deepEqual(saved,[{result:written.json()}])
  const movements=(await seed.query("SELECT id FROM stock_movements WHERE tenant_id=$1 AND source_order_id=$2 AND direction='issue'",[tenant,order])).rows
  assert.equal(movements.length,1)
  const issue=movements[0].id
  assert.equal((await seed.query("SELECT count(*)::int AS titles FROM receivables WHERE tenant_id=$1 AND order_id=$2",[tenant,order])).rows[0].titles,1)
  assert.deepEqual(await get(),initialMargin)
  const basis={kind:"receipt",productId:product,movementId:entered.json().id,freight:"3.00",recoverableTax:"1.00",reason:"Rateio da nota",revision:1}
  const update=await post("periods/basis",basis);assert.equal(update.statusCode,200,update.body)
  assert.equal((await post("periods/basis",basis)).statusCode,412)
  const source=await app.inject({method:"GET",url:"/api/v1/stock/periods/basis?productId="+product+"&movementId="+entered.json().id,headers})
  assert.deepEqual([source.json().revision,source.json().freight,source.json().recoverableTax],[2,"3.00","1.00"])
  assert.deepEqual(await get(),{revenue:"15.00",cost:"12.00",grossProfit:"3.00",marginPercent:"20.00"})
  assert.deepEqual((await complete()).json(),written.json())
  await seed.query("UPDATE stock_balances SET quantity_micros=1000000 WHERE tenant_id=$1 AND product_id=$2",[tenant,product])
  await seed.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,reverses_id) VALUES($1,$2,$3,'receipt',1000000,1000000,'Devolução integral',$4)",[randomUUID(),tenant,product,issue])
  assert.deepEqual(await get(),{revenue:"0.00",cost:"0.00",grossProfit:"0.00",marginPercent:null})
})
