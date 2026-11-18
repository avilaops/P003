import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import test from "node:test"
import {stockFixture} from "./stock-fixture.js"

const admin = process.env.API_TS_TEST_ADMIN_URL
test("serialized units are unique, reserved by order, traceable on sale and reversible only once", { skip: !admin }, async t => {
  const {app, seed, tenant, otherTenant, close} = await stockFixture(admin!)
  t.after(close)
  const productId = randomUUID(), order = randomUUID()
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'SR1','Equipamento','UN',100,'active')", [productId,tenant])
  const headers = {authorization:"Bearer fixture-editor-token","x-tenant-id":tenant}
  const command = (path:string,payload:Record<string,unknown>) => app.inject({method:"POST",url:"/api/v1/stock/"+path,
    headers:{...headers,"idempotency-key":randomUUID()},payload})
  const cfg = await command("serials/configure",{productId,opening:[]})
  assert.equal(cfg.statusCode,200,cfg.body)
  const post = (direction:string,quantity:string,serials:string[]) => command("movements",{productId,direction,quantity:quantity+".000000",serials,reason:"Teste do equipamento"})
  assert.equal((await post("receipt","2",["SN-A"])).statusCode,409)
  assert.equal((await post("receipt","2",["SN-A","SN-A"])).statusCode,422)
  const received = await post("receipt","2",["SN-A","SN-B"])
  assert.equal(received.statusCode,201,received.body)
  assert.equal((await post("receipt","1",["SN-A"])).statusCode,409)
  await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente rastreado','52998224725','2027-01-02',100,'accepted')",[order,tenant])
  await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'SR1','Equipamento','UN',1000000,100,100)",[tenant,order,productId])
  await assert.rejects(seed.query("UPDATE sales_orders SET status='confirmed' WHERE id=$1",[order]), /série/i)
  const selected = await command("serials/assign",{productId,kind:"sale",documentId:order,direction:"issue",serials:["SN-A"]})
  assert.equal(selected.statusCode,200,selected.body)
  await seed.query("UPDATE sales_orders SET status='confirmed' WHERE id=$1",[order])
  assert.equal((await post("issue","1",["SN-A"])).statusCode,409)
  const issued=randomUUID(),invoice=randomUUID()
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT id,'fiscal.nfe.read' FROM roles WHERE code='editor'")
  await seed.query("INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents) VALUES($1,$2,'production',55,1,1,'{}',$3,100)",[tenant,invoice,{sourceOrderId:order}])
  await seed.query("INSERT INTO fiscal_nfe_documents(tenant_id,id,source_order_id,environment,status,series,number,issued_at,random_code,signed_xml,access_key,protocol,authorized_xml) VALUES($1,$2,$3,'production','authorized',1,543,'2026-11-16T00:00:00-03:00','12345678','<xml/>',repeat('1',44),'protocol','<xml/>')",[tenant,invoice,order])
  const writer=await seed.connect()
  try {
    await writer.query("BEGIN")
    await writer.query("UPDATE stock_balances SET quantity_micros=1000000 WHERE tenant_id=$1 AND product_id=$2",[tenant,productId])
    await writer.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_order_id) VALUES($1,$2,$3,'issue',1000000,1000000,'Baixa da venda',$4)",[issued,tenant,productId,order])
    await writer.query("UPDATE sales_orders SET status='completed' WHERE tenant_id=$1 AND id=$2",[tenant,order])
    await writer.query("COMMIT")
  } finally {writer.release()}
  const path="/api/v1/stock/serials?q=SN-A"
  const found = await app.inject({method:"GET",url:path,headers})
  assert.equal(found.statusCode,200,found.body)
  const item=found.json().data[0]
  assert.deepEqual([item.status,item.customer,item.orderId],["sold","Cliente rastreado",order])
  assert.ok(item.saleDate)
  assert.deepEqual([item.invoiceId,item.invoiceNumber,item.invoiceSeries],[invoice,"543",1])
  assert.equal((await app.inject({method:"GET",url:path,headers:{...headers,"x-tenant-id":otherTenant}})).json().data.length,0)
  assert.equal((await post("issue","1",["SN-A"])).statusCode,409)
  const warranty=randomUUID()
  await seed.query("INSERT INTO warranty_cases(id,tenant_id,protocol,product_id,serial_number,title,description,criticality) VALUES($1,$2,'TESTE-SN',$3,'SN-A','Teste de série','Equipamento retornou para assistência','normal')",[warranty,tenant,productId])
  assert.deepEqual((await seed.query("SELECT order_id,customer_id FROM warranty_cases WHERE id=$1",[warranty])).rows[0],{order_id:order,customer_id:tenant})
  const returned=randomUUID(), returnWriter=await seed.connect()
  try {
    await returnWriter.query("BEGIN")
    await returnWriter.query("UPDATE stock_balances SET quantity_micros=2000000 WHERE tenant_id=$1 AND product_id=$2",[tenant,productId])
    await returnWriter.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,reverses_id) VALUES($1,$2,$3,'receipt',1000000,2000000,'Devolução',$4)",[returned,tenant,productId,issued])
    await returnWriter.query("COMMIT")
  } finally {returnWriter.release()}
  const events=await app.inject({method:"GET",url:"/api/v1/stock/serials/events?productId="+productId+"&serial=SN-A",headers})
  assert.equal(events.statusCode,200,events.body)
  assert.deepEqual(events.json().data.map((e:{status:string})=>e.status),["available","sold","reserved","available"])
  assert.equal((await post("issue","1",["SN-A"])).statusCode,201)
  assert.equal((await post("issue","1",["SN-A"])).statusCode,409)
})
