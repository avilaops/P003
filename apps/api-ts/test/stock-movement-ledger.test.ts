import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { stockFixture } from "./stock-fixture.js"

const admin = process.env.API_TS_TEST_ADMIN_URL
test("lançamentos gerais • filtros, documentos de origem, paginação e definições", {skip:!admin}, async t => {
  const {app,seed,role,tenant,otherTenant,close} = await stockFixture(admin!)
  t.after(close)
  const headers = (actor = "reader", company = tenant) => ({authorization:"Bearer fixture-"+actor+"-token","x-tenant-id":company})
  const get = (query:string,actor = "reader",company = tenant) => app.inject({
    method:"GET",url:"/api/v1/stock/reports?"+query,headers:headers(actor,company),
  })
  const run = async (query:string,company = tenant) => {
    const response = await get(query,"reader",company)
    assert.equal(response.statusCode,200,response.body)
    return response.json()
  }
  const dataset = "dataset=stock_movement_ledger"
  const period = "&startDate=2024-10-03&endDate=2024-10-03"
  const sku = randomUUID(),kg = randomUUID(),foreign = randomUUID(),site = randomUUID()
  await seed.query(`INSERT INTO products(tenant_id,id,sku,name,unit,price_cents,status) VALUES
    ($1,$2,'A','Cadeira','UN',0,'active'),($1,$3,'B','Perfil','KG',0,'active'),($4,$5,'A','Outra empresa','UN',0,'active')`,
    [tenant,sku,kg,otherTenant,foreign])
  await seed.query("INSERT INTO warehouses(tenant_id,id,code,name,status,revision) VALUES($1,$2,'DEP','Filial','active',1)",[tenant,site])
  const config = await app.inject({method:"PUT",url:"/api/v1/stock/locations",
    headers:{...headers("editor"),"idempotency-key":randomUUID()},payload:{enabled:true,revision:1,salesId:null,purchaseId:null,productionId:null}})
  assert.equal(config.statusCode,200,config.body)
  const opening = config.json().openingId
  const post = async (path:string,payload:object,company = tenant) => {
    const response = await app.inject({method:"POST",url:"/api/v1/stock/"+path,
      headers:{...headers("editor",company),"idempotency-key":randomUUID()},payload})
    assert.equal(response.statusCode,201,response.body)
    return response.json()
  }
  const input = {productId:sku,direction:"receipt",quantity:"2.000001",reason:"Entrada direta",effectiveDate:"2024-10-03",warehouseId:site}
  const manual = await post("movements",input)
  await post("movements",{...input,direction:"issue",reversesId:manual.id,reason:"Correção manual"})
  const adjustment = await post("movements",{...input,productId:kg,quantity:"0.750001",warehouseId:opening,reason:"Conferência histórica"})
  const inventoryId = randomUUID()
  await seed.query(`INSERT INTO audit_log(tenant_id,entity_type,entity_id,action,details)
    VALUES($1,'stock_movement',$2,'stock.moved',$3)`,[tenant,adjustment.id,{inventoryCountId:inventoryId}])
  const sale = randomUUID()
  await seed.query(`INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status)
    VALUES($1,$2,$2,'Cliente','52998224725','2024-10-20',100,'completed')`,[sale,tenant])
  await seed.query(`INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents)
    VALUES($1,$2,1,$3,'B','Perfil','KG',250000,400,100)`,[tenant,sale,kg])
  const issued = randomUUID(), returned = randomUUID()
  await seed.query(`INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_order_id,effective_on)
    VALUES($1,$2,$3,'issue',250000,500001,'Entrega ao cliente',$4,'2024-10-03')`,[issued,tenant,kg,sale])
  await seed.query(`INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,reverses_id,effective_on)
    VALUES($1,$2,$3,'receipt',250000,750001,'Devolução comercial',$4,'2024-10-04')`,[returned,tenant,kg,issued])
  // Commercial returns can acquire their final effective date after the ledger insert.
  await seed.query("UPDATE stock_cost_inputs SET effective_on='2024-10-03' WHERE tenant_id=$1 AND movement_id=$2",[tenant,returned])
  await seed.query(`INSERT INTO audit_log(tenant_id,entity_type,entity_id,action,details)
    VALUES($1,'stock_movement',$2,'stock.moved',$3)`,[tenant,returned,{sourceId:sale}])
  await post("movements",{...input,effectiveDate:"2024-10-04",reason:"Entrada posterior"})
  await post("movements",{...input,productId:foreign,warehouseId:undefined,reason:"Entrada da outra empresa"},otherTenant)

  const all = await run(dataset+period+"&all=true")
  assert.equal(all.total,5)
  assert.deepEqual(all.data.map((r:{kind:string;document:string|null})=>[r.kind,r.document]),[
    ["Devolução",sale],["Venda",sale],["Inventário",inventoryId],["Estorno",manual.id],["Manual",null],
  ])
  assert.deepEqual(all.data[4],{date:"2024-10-03",sku:"A",product:"Cadeira",unit:"UN",warehouse:"Filial",kind:"Manual",
    document:null,receipts:"2.000001",issues:"0.000000",reason:"Entrada direta"})
  const focused = await run(dataset+period+"&productId="+sku+"&warehouseId="+site+"&movementDirection=issue")
  assert.deepEqual(focused.data,[{...all.data[4],kind:"Estorno",document:manual.id,receipts:"0.000000",issues:"2.000001",reason:"Correção manual"}])
  assert.equal((await run(dataset+period+"&productId="+kg+"&warehouseId="+site)).total,0)
  assert.equal((await run(dataset+period+"&movementDirection=receipt")).total,3)
  assert.deepEqual((await run(dataset+period+"&limit=2&offset=2")).data,all.data.slice(2,4))
  const beyond = await run(dataset+period+"&limit=2&offset=9")
  assert.deepEqual(beyond.data,[])
  assert.equal(beyond.total,5)
  assert.deepEqual((await run(dataset+period,otherTenant)).data.map((r:{product:string})=>r.product),["Outra empresa"])
  assert.equal((await get(dataset+"&productId="+foreign)).statusCode,404)
  assert.equal((await get(dataset+"&movementDirection=invalid")).statusCode,422)
  assert.equal((await get(dataset+"&countStatus=open")).statusCode,422)
  assert.equal((await get(dataset,"visitor")).statusCode,403)

  const transfer = await post("transfers",{fromId:opening,toId:site,reason:"Transferência de teste",items:[{productId:kg,quantity:"0.250000"}]})
  const reversal = await post("transfers/"+transfer.id+"/reverse",{reason:"Reversão da transferência"})
  const recent = await run(dataset+"&productId="+kg+"&all=true")
  assert.deepEqual(recent.data.map((r:{kind:string;document:string})=>[r.kind,r.document]),[
    ["Transferência",reversal.id],["Transferência",reversal.id],["Transferência",transfer.id],["Transferência",transfer.id],
  ])
  await seed.query(`GRANT USAGE ON SCHEMA system_config TO ${role};
    GRANT SELECT,INSERT ON system_config.report_definitions TO ${role};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA system_config TO ${role};
    INSERT INTO role_permissions(role_id,permission_code) SELECT id,'system.reports.read' FROM roles;
    INSERT INTO role_permissions(role_id,permission_code) SELECT id,'system.reports.manage' FROM roles WHERE code='editor';`)
  const definition = await app.inject({method:"POST",url:"/api/v1/system/custom-reports",headers:headers("editor"),
    payload:{name:"Origem das contagens",dataset:"stock_movement_ledger",columns:["sku","document"],filters:{kind:"Inventário"},visibility:"tenant"}})
  assert.equal(definition.statusCode,201,definition.body)
  const saved = "definitionId="+definition.json().data.id+period
  assert.deepEqual((await run(saved+"&all=true")).data,[{sku:"B",document:inventoryId}])
  assert.equal((await get(saved,"reader",otherTenant)).statusCode,404)
})
