import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { stockFixture } from "./stock-fixture.js"

const admin = process.env.API_TS_TEST_ADMIN_URL
test("stock analysis • valuation, turnover, inactivity, accuracy, pagination and saved definitions", {skip: !admin}, async t => {
  const {app,seed,tenant,otherTenant,role,close}=await stockFixture(admin!)
  t.after(close)
  const headers={authorization:"Bearer fixture-editor-token","x-tenant-id":tenant}
  const get=(query:string,actor=headers)=>app.inject({method:"GET",url:"/api/v1/stock/reports?"+query,headers:actor})
  const report=async(query:string)=>{const response=await get(query);assert.equal(response.statusCode,200,response.body);return response.json()}
  await report("dataset=stock_position")
  const id=randomUUID(), unknown=randomUUID()
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$3,'A','=Cadastro','UN',10,'active'),($2,$3,'B','Sem custo','KG',10,'active')",[id,unknown,tenant])
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) SELECT gen_random_uuid(),$1,'SKU-'||i,'Outros '||i,'UN',0,'active' FROM generate_series(1,31) AS i",[tenant])
  const move=async(productId:string,direction:string,quantity:string,effectiveDate:string,unitCost?:string,reversesId?:string)=>{
    const response=await app.inject({method:"POST",url:"/api/v1/stock/movements",headers:{...headers,"idempotency-key":randomUUID()},payload:{
      productId,direction,quantity,effectiveDate,reason:"Material consumido",...(unitCost===undefined?{}:{unitCost}),...(reversesId?{reversesId}:{})}})
    assert.equal(response.statusCode,201,response.body);return response.json().id as string
  }
  await move(id,"receipt","10.000000","2024-03-31","2.000000")
  await move(id,"issue","4.000000","2024-04-02")
  const cancelled=await move(id,"issue","1.000000","2024-04-03")
  await move(id,"receipt","1.000000","2024-04-04",undefined,cancelled)
  await move(unknown,"receipt","2.000000","2024-04-01")
  const dates="&startDate=2024-04-01&endDate=2024-04-10"
  const focus="&productId="+id
  const position=(await report("dataset=stock_position"+focus)).data[0]
  assert.equal(position.value,"12.00");assert.equal(position.quantity,"6.000000")
  assert.equal((await report("dataset=stock_position&productId="+unknown)).data[0].value,null)
  const rotation=(await report("dataset=stock_turnover"+dates+focus)).data[0]
  assert.deepEqual([rotation.demand,rotation.average,rotation.turnover,rotation.coverage],["4.000000","8.000000","0.5000","15.00"])
  const kardex=await report("dataset=stock_kardex"+dates+focus)
  assert.equal(kardex.data.length,3)
  assert.equal(kardex.data[0].opening,"10.000000");assert.equal(kardex.data.at(-1).closing,"6.000000")
  const idle=await report("dataset=stock_idle&endDate=2024-04-10&idleDays=5")
  assert.equal(idle.data.find((r:{sku:string})=>r.sku==="A").last_issue,"2024-04-02")
  assert.equal(idle.data.find((r:{sku:string})=>r.sku==="B").last_issue,null)
  const abc=await report("dataset=stock_abc&endDate=2024-04-10&all=true")
  assert.equal(abc.data.find((r:{sku:string})=>r.sku==="A").class,"A")
  assert.equal(abc.data.find((r:{sku:string})=>r.sku==="B").class,null)
  assert.equal((await report("dataset=stock_position&limit=25&offset=25")).data.length,8)
  assert.equal((await report("dataset=stock_position&all=true")).data.length,33)
  assert.equal((await get("dataset=stock_accuracy")).statusCode,403)
  await seed.query("GRANT USAGE ON SCHEMA system_config TO "+role)
  await seed.query("GRANT SELECT,INSERT,UPDATE ON system_config.report_definitions TO "+role)
  await seed.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA system_config TO "+role)
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT id,unnest(ARRAY['inventory.counts.read','system.reports.read','system.reports.manage']) FROM roles WHERE code='editor'")
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT id,'system.reports.read' FROM roles WHERE code='reader'")
  assert.equal((await report("dataset=stock_accuracy"+dates)).data[0].accuracy,null)
  const def=await app.inject({method:"POST",url:"/api/v1/system/custom-reports",headers,payload:{
    name:"Minha posição",dataset:"stock_position",columns:["sku","value"],filters:{unit:"KG"},visibility:"private"}})
  assert.equal(def.statusCode,201,def.body)
  const run="definitionId="+def.json().data.id
  assert.deepEqual((await report(run)).data,[{sku:"B",value:null}])
  assert.equal((await get(run,{...headers,authorization:"Bearer fixture-reader-token"})).statusCode,404)
  assert.equal((await get(run,{...headers,"x-tenant-id":otherTenant})).statusCode,404)
})

