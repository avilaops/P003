import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { stockFixture } from "./stock-fixture.js"

const admin=process.env.API_TS_TEST_ADMIN_URL
test("versioned production reserves components, consumes losses and receives valued finished goods once", {skip:!admin}, async t=>{
  const {app,seed,tenant,close}=await stockFixture(admin!)
  t.after(close)
  const component=randomUUID(),product=randomUUID(),order=randomUUID()
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT id,unnest(ARRAY['production.read','production.manage']) FROM roles WHERE code='editor'")
  await seed.query(`INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES ($1,$3,'PERFIL','Perfil','M',300,'active'),($2,$3,'BANCO','Banco','UN',5000,'active')`,[component,product,tenant])
  await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Academia','52998224725','2027-01-02',15000,'accepted')",[order,tenant])
  await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'BANCO','Banco','UN',3000000,5000,15000)",[tenant,order,product])
  const headers={authorization:"Bearer fixture-editor-token","x-tenant-id":tenant}
  const post=(url:string,payload:object,rev=1,key=randomUUID().toString())=>app.inject({method:"POST",url:"/api/v1/"+url,headers:{...headers,"if-match":'"'+rev+'"',"idempotency-key":key},payload})
  const get=(url:string)=>app.inject({method:"GET",url:"/api/v1/"+url,headers})
  const receipt=await post("stock/movements",{productId:component,direction:"receipt",quantity:"10.000000",unitCost:"3.000000",reason:"Compra do perfil"})
  assert.equal(receipt.statusCode,201,receipt.body)
  const bom=await post("production/structures/"+product,{components:[{productId:component,quantity:"2.000000"}],previousVersion:0})
  assert.equal(bom.statusCode,201,bom.body)
  const creation=await post("production/orders",{orderId:order})
  assert.equal(creation.statusCode,201,creation.body)
  const job=creation.json().data[0].id
  const afterReserve=await get("stock?q=PERFIL")
  assert.equal(afterReserve.json().data[0].reserved,"6.000000")
  const over=await post("stock/movements",{productId:component,direction:"issue",quantity:"5.000000",reason:"Saída de terceiro"})
  assert.equal(over.statusCode,409,over.body)
  assert.equal((await post("production/structures/"+product,{components:[{productId:component,quantity:"4.000000"}],previousVersion:1})).statusCode,201)
  const url="production/orders/"+job+"/postings"
  const body={produced:"2.000000",loss:"1.000000",minutes:90,additionalCost:"2.00",reason:"Fabricado e conferido"}
  const key=randomUUID()
  const result=await post(url,body,1,key)
  assert.equal(result.statusCode,200,result.body)
  assert.deepEqual((await post(url,body,1,key)).json(),result.json())
  const detail=(await get("production/orders/"+job)).json()
  assert.equal(detail.data.status,"ready")
  assert.equal(detail.data.bomVersion,1)
  assert.equal(detail.postings[0].value,"20.00")
  assert.equal(detail.postings[0].minutes,90)
  assert.deepEqual((await seed.query("SELECT quantity_micros FROM stock_balances WHERE product_id=$1",[product])).rows,[{quantity_micros:"2000000"}])
  assert.equal((await get("stock?q=PERFIL")).json().data[0].available,"4.000000")
})
