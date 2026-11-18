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
  const shared=await app.inject({method:"PUT",url:"/api/v1/system/custom-reports/"+def.json().data.id,headers:{...headers,"if-match":'"1"'},
    payload:{name:"Posição da empresa",dataset:"stock_position",columns:["product"],filters:{sku:"A",quantity:"6,0"},visibility:"tenant"}})
  assert.equal(shared.statusCode,200,shared.body)
  const visible=await get(run,{...headers,authorization:"Bearer fixture-reader-token"})
  assert.deepEqual(visible.json().data,[{product:"=Cadastro"}])
  const count=randomUUID(),open=randomUUID()
  await seed.query(`INSERT INTO inventory_counts(tenant_id,id,reference,created_by,status,approved_by,approved_at)
    VALUES($1,$2,'Conferência aprovada','editor','approved','reader','2024-04-08T15:00Z'),($1,$3,'Pendente','editor','open',NULL,NULL)`,[tenant,count,open])
  await seed.query(`INSERT INTO inventory_count_lines(tenant_id,count_id,product_id,expected_quantity_micros,counted_quantity_micros)
    VALUES($1,$2,$4,6000000,6000000),($1,$2,$5,2000000,1500000),($1,$3,$5,2000000,2000000)`,[tenant,count,open,id,unknown])
  assert.deepEqual((await report("dataset=stock_accuracy"+dates)).data,[{lines:2,matched:1,accuracy:"50.00"}])
  const diff=(await report("dataset=stock_divergences"+dates)).data
  assert.equal(diff.length,1);assert.equal(diff[0].difference,"-0.500000")
  assert.equal((await report("dataset=stock_idle&endDate=2024-04-01&idleDays=90")).data.length,0)
  await move(unknown,"issue","2.000000","2024-05-01")
  await move(unknown,"receipt","3.000000","2024-07-01")
  assert.equal((await report("dataset=stock_idle&endDate=2024-07-02&idleDays=10&productId="+unknown)).total,0)
  const resumed=(await report("dataset=stock_idle&endDate=2024-07-20&idleDays=10&productId="+unknown)).data[0]
  assert.equal(resumed.positive_since,"2024-07-01");assert.equal(resumed.idle_days,19)
  const site=randomUUID()
  await seed.query("INSERT INTO warehouses(tenant_id,id,code,name,status,revision) VALUES($1,$2,'FIL','Filial','active',1)",[tenant,site])
  const enabled=await app.inject({method:"PUT",url:"/api/v1/stock/locations",headers:{...headers,"idempotency-key":randomUUID()},
    payload:{enabled:true,salesId:site,purchaseId:null,productionId:null,revision:1}})
  assert.equal(enabled.statusCode,200,enabled.body)
  const opening=enabled.json().openingId
  // Restore the pre-location representation: migrated ledger rows had both fields NULL.
  const restore=await seed.connect()
  try{
    await restore.query("BEGIN")
    await restore.query("SET LOCAL session_replication_role=replica")
    await restore.query("UPDATE stock_movements SET warehouse_id=NULL,local_balance_after_micros=NULL WHERE tenant_id=$1 AND product_id=$2",[tenant,id])
    await restore.query("COMMIT")
  }finally{restore.release()}
  const old=(await report("dataset=stock_kardex"+dates+focus)).data[0]
  assert.equal(old.warehouse,"Sem depósito registrado")
  const local=(await report("dataset=stock_kardex"+dates+focus+"&warehouseId="+opening)).data
  assert.equal(local.length,1);assert.equal(local[0].kind,"Saldo sem movimentos");assert.equal(local[0].opening,"6.000000")
  const transfer=await app.inject({method:"POST",url:"/api/v1/stock/transfers",headers:{...headers,"idempotency-key":randomUUID()},
    payload:{fromId:opening,toId:site,reason:"Teste entre depósitos",items:[{productId:id,quantity:"2.000000"}]}})
  assert.equal(transfer.statusCode,201,transfer.body)
  const today=(await seed.query("SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text today")).rows[0].today
  const current="&startDate="+today+"&endDate="+today+focus
  assert.equal((await report("dataset=stock_turnover"+current)).data[0].demand,"0.000000")
  const atSite=(await report("dataset=stock_kardex"+current+"&warehouseId="+site)).data[0]
  assert.equal(atSite.kind,"Transferência");assert.equal(atSite.opening,"0.000000");assert.equal(atSite.closing,"2.000000")
  const extras=await seed.query("SELECT id FROM products WHERE tenant_id=$1 AND sku IN ('SKU-1','SKU-2','SKU-3','SKU-4') ORDER BY sku",[tenant])
  const [b,c,free,legacy]=extras.rows.map(row=>row.id)
  await move(b,"receipt","1.000000","2024-04-01","2.400000")
  await move(c,"receipt","1.000000","2024-04-01","0.600000")
  await move(free,"receipt","1.000000","2024-04-01","0.000000")
  await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,1000000)",[tenant,legacy])
  const classified=await report("dataset=stock_abc&endDate=2024-04-10&all=true")
  const item=(sku:string)=>classified.data.find((r:{sku:string})=>r.sku===sku)
  assert.deepEqual([item("A").share,item("SKU-1").class,item("SKU-2").class,item("SKU-3").value,item("SKU-4").class],["80.00","B","C","0.00",null])
  const unrecorded=(await report("dataset=stock_idle&endDate=2024-04-10&idleDays=90&productId="+legacy)).data[0]
  assert.equal(unrecorded.history,"Abertura sem data registrada");assert.equal(unrecorded.idle_days,null)
})
