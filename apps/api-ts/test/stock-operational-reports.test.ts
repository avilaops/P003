import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { stockFixture } from "./stock-fixture.js"

const admin = process.env.API_TS_TEST_ADMIN_URL
test("relatórios operacionais de estoque • HTTP e PostgreSQL", {skip:!admin}, async t => {
  const {app,seed,tenant,otherTenant,role,close} = await stockFixture(admin!)
  t.after(close)
  const headers = (user = "editor", company = tenant) => ({
    authorization:"Bearer fixture-"+user+"-token","x-tenant-id":company,
  })
  const get = (query: string,user = "editor", company = tenant) =>
    app.inject({method:"GET",url:"/api/v1/stock/reports?"+query,headers:headers(user,company)})
  const period = "&startDate=2024-04-01&endDate=2024-04-01"
  const report = async (query: string, company = tenant) => {
    const response = await get(query+period,"editor",company)
    assert.equal(response.statusCode,200,response.body)
    return response.json()
  }
  const movement = "dataset=stock_movement_activity", counts = "dataset=stock_count_progress",
    production = "dataset=stock_production_progress"
  const item = randomUUID(), otherItem = randomUUID(), kg = randomUUID(), foreignItem = randomUUID()
  await seed.query(`INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES
    ($1,$5,'CADEIRA','Cadeira','UN',0,'active'),($2,$5,'MESA','Mesa','UN',0,'active'),
    ($3,$5,'ACO','Aço','KG',0,'active'),($4,$6,'CADEIRA','Produto da outra empresa','UN',0,'active')`,
    [item,otherItem,kg,foreignItem,tenant,otherTenant])
  const site = randomUUID()
  await seed.query("INSERT INTO warehouses(id,tenant_id,code,name,status,revision) VALUES($1,$2,'FIL','Filial','active',1)",[site,tenant])
  const setLocations = await app.inject({method:"PUT",url:"/api/v1/stock/locations",
    headers:{...headers(),"idempotency-key":randomUUID()},payload:{enabled:true,salesId:site,purchaseId:site,productionId:site,revision:1}})
  assert.equal(setLocations.statusCode,200,setLocations.body)
  const opening = setLocations.json().openingId as string
  await seed.query(`GRANT USAGE ON SCHEMA system_config TO ${role};
    GRANT SELECT,INSERT,UPDATE ON system_config.report_definitions TO ${role};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA system_config TO ${role};
    INSERT INTO role_permissions(role_id,permission_code) SELECT id,unnest(ARRAY['system.reports.read','system.reports.manage']) FROM roles;
    INSERT INTO role_permissions(role_id,permission_code) SELECT id,unnest(ARRAY['inventory.counts.read','production.read']) FROM roles WHERE code IN ('editor','visitor');`)

  await t.test("movimentos • data efetiva, direção, depósito e unidade", async () => {
    const move = async (productId: string,direction: string,quantity: string,warehouseId: string,effectiveDate = "2024-04-01") => {
      const response = await app.inject({method:"POST",url:"/api/v1/stock/movements",
        headers:{...headers(),"idempotency-key":randomUUID()},payload:{productId,direction,quantity,warehouseId,effectiveDate,reason:"Controle de material"}})
      assert.equal(response.statusCode,201,response.body)
    }
    await move(item,"receipt","4.000001",site)
    await move(item,"issue","1.000000",site)
    await move(otherItem,"receipt","3.000000",site)
    await move(kg,"receipt","0.500000",site)
    await move(item,"receipt","8.000000",opening)
    await move(item,"issue","0.250000",site,"2024-04-02")
    const result = await report(movement+"&warehouseId="+site)
    assert.deepEqual(result.data,[
      {date:"2024-04-01",warehouse:"Filial",unit:"KG",receipts:"0.500000",issues:"0.000000",receipt_count:1,issue_count:0,movements:1},
      {date:"2024-04-01",warehouse:"Filial",unit:"UN",receipts:"7.000001",issues:"1.000000",receipt_count:2,issue_count:1,movements:3},
    ])
    const focused = movement+"&productId="+item+"&warehouseId="+site+"&movementDirection=receipt"
    assert.deepEqual((await report(focused+"&all=true")).data,[
      {date:"2024-04-01",warehouse:"Filial",unit:"UN",receipts:"4.000001",issues:"0.000000",receipt_count:1,issue_count:0,movements:1},
    ])
    const issues = await report(movement+"&movementDirection=issue")
    assert.deepEqual(issues.data.map((r:{issues:string;receipts:string})=>[r.issues,r.receipts]),[["1.000000","0.000000"]])
    const all = await report(movement+"&all=true&limit=1")
    assert.equal(all.total,3)
    const second = await report(movement+"&offset=1&limit=1")
    assert.equal(second.total,3)
    assert.deepEqual(second.data,all.data.slice(1,2))
    const emptyPage = await report(movement+"&offset=5&limit=1")
    assert.equal(emptyPage.total,3)
    assert.deepEqual(emptyPage.data,[])
  })

  await t.test("inventários • data de abertura local e progresso das linhas selecionadas", async () => {
    const session = randomUUID(), cancelled = randomUUID()
    await seed.query(`INSERT INTO inventory_counts(id,tenant_id,reference,created_by,created_at,status,warehouse_id,cancelled_at)
      VALUES($1,$3,'Conferência','editor','2024-04-02T02:59:59Z','open',$4,NULL),
            ($2,$3,'Interrompida','editor','2024-04-01T03:00:00Z','cancelled',NULL,'2024-04-10T12:00Z'),
            (gen_random_uuid(),$3,'Fora do período','editor','2024-04-02T03:00:00Z','open',$4,NULL)`,[session,cancelled,tenant,site])
    await seed.query(`INSERT INTO inventory_count_lines(tenant_id,count_id,product_id,expected_quantity_micros,counted_quantity_micros)
      VALUES ($1,$2,$3,1000000,0),($1,$2,$4,2000000,NULL)`,[tenant,session,item,kg])
    const open = (await report(counts+"&countStatus=open&warehouseId="+site)).data
    assert.deepEqual(open,[{date:"2024-04-01",reference:"Conferência",warehouse:"Filial",status:"open",lines:2,counted_lines:1,pending_lines:1,progress:"50.00"}])
    const sku = (await report(counts+"&productId="+item+"&all=true")).data
    assert.deepEqual(sku,[{...open[0],lines:1,pending_lines:0,progress:"100.00"}])
    assert.equal((await report(counts+"&productId="+kg)).data[0].progress,"0.00")
    const empty = (await report(counts+"&countStatus=cancelled")).data
    assert.deepEqual(empty,[{date:"2024-04-01",reference:"Interrompida",warehouse:"Consolidado",status:"cancelled",lines:0,counted_lines:0,pending_lines:0,progress:null}])
    assert.equal((await report(counts+"&countStatus=approved")).total,0)
    assert.equal((await report(counts+"&countStatus=cancelled&warehouseId="+site)).total,0)
  })

  await t.test("produção • ordens abertas no período por etapa, situação, produto acabado e depósito", async () => {
    const stage = randomUUID(), ready = randomUUID()
    await seed.query(`INSERT INTO production_stages(id,tenant_id,name,kind,position) VALUES
      ($1,$3,'Montagem','andamento',1),($2,$3,'Concluída','pronta',2)`,[stage,ready,tenant])
    const job = async (productId:string,stageId:string,status:string,quantity:number,warehouseId:string|null,opened:string) => {
      const order = randomUUID()
      await seed.query(`INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status)
        VALUES($1,$2,$2,'Cliente','52998224725','2024-04-20',100,'accepted')`,[order,tenant])
      await seed.query(`INSERT INTO production_orders(id,tenant_id,order_id,product_id,sku,name,unit,quantity_micros,stage_id,status,warehouse_id,created_at,finished_at)
        SELECT gen_random_uuid(),p.tenant_id,$2,p.id,p.sku,p.name,p.unit,$4,$5,$6,$7,$8,
          CASE WHEN $6='ready' THEN '2024-04-15T12:00Z'::timestamptz END FROM products p WHERE p.tenant_id=$1 AND p.id=$3`,
        [tenant,order,productId,quantity,stageId,status,warehouseId,opened])
    }
    await job(item,stage,"open",1_000_001,site,"2024-04-02T02:59:59Z")
    await job(item,stage,"open",2_000_000,null,"2024-04-01T03:00:00Z")
    await job(kg,stage,"open",500_000,site,"2024-04-01T03:00:00Z")
    await job(item,ready,"ready",3_000_000,site,"2024-04-01T09:00:00Z")
    await job(item,ready,"ready",4_000_000,site,"2024-04-02T03:00:00Z")
    const result = await report(production+"&productId="+item+"&all=true")
    assert.deepEqual(result.data,[
      {stage:"Montagem",status:"open",sku:"CADEIRA",product:"Cadeira",unit:"UN",orders:2,quantity:"3.000001"},
      {stage:"Concluída",status:"ready",sku:"CADEIRA",product:"Cadeira",unit:"UN",orders:1,quantity:"3.000000"},
    ])
    const scoped = await report(production+"&productionStatus=open&productId="+item+"&warehouseId="+site)
    assert.deepEqual(scoped.data,[{...result.data[0],orders:1,quantity:"1.000001"}])
    assert.equal((await report(production+"&productionStatus=ready")).total,1)
    assert.equal((await report(production+"&productionStatus=cancelled")).total,0)
    assert.equal((await report(production+"&all=true")).total,3)

    await seed.query("UPDATE products SET sku='CADEIRA-V2',name='Cadeira revisada' WHERE tenant_id=$1 AND id=$2",[tenant,item])
    await job(item,stage,"open",5_000_000,site,"2024-04-02T02:59:59Z")
    await seed.query("UPDATE products SET name='Cadeira atual' WHERE tenant_id=$1 AND id=$2",[tenant,item])
    await job(item,stage,"open",7_000_000,site,"2024-04-02T02:59:59Z")
    const history = production+"&productionStatus=open&productId="+item
    const snapshots = (await report(history+"&all=true")).data
    assert.deepEqual(snapshots,[
      {stage:"Montagem",status:"open",sku:"CADEIRA",product:"Cadeira",unit:"UN",orders:2,quantity:"3.000001"},
      {stage:"Montagem",status:"open",sku:"CADEIRA-V2",product:"Cadeira atual",unit:"UN",orders:1,quantity:"7.000000"},
      {stage:"Montagem",status:"open",sku:"CADEIRA-V2",product:"Cadeira revisada",unit:"UN",orders:1,quantity:"5.000000"},
    ])
    assert.deepEqual((await report(history+"&offset=2&limit=1")).data,snapshots.slice(2))
  })

  await t.test("permissões por fonte, definições salvas, isolamento por empresa e parâmetros inválidos", async () => {
    const catalog = (await get("catalog=true","reader")).json().sources
    assert.ok(catalog.stock_movement_activity)
    assert.equal(catalog.stock_count_progress,undefined)
    assert.equal(catalog.stock_production_progress,undefined)
    for (const query of [movement,counts,production]) {
      assert.equal((await get(query,"visitor")).statusCode,403)
      assert.equal((await report(query,otherTenant)).total,0)
      assert.equal((await get(query+"&productId="+foreignItem)).statusCode,404)
      assert.equal((await get(query+"&warehouseId="+site,"editor",otherTenant)).statusCode,404)
    }
    for (const query of [counts,production]) assert.equal((await get(query+"&all=true","reader")).statusCode,403)
    for (const query of [movement+"&movementDirection=invalid",counts+"&countStatus=ready",production+"&productionStatus=approved",
      counts+"&movementDirection=receipt",production+"&countStatus=open",movement+"&productionStatus=ready"])
      assert.equal((await get(query)).statusCode,422)
    const saved = {name:"Ordens em montagem",dataset:"stock_production_progress",columns:["stage","orders"],
      filters:{status:"open",orders:"2,0"},visibility:"tenant"}
    const save = (user:string,payload:object) => app.inject({method:"POST",url:"/api/v1/system/custom-reports",headers:headers(user),payload})
    assert.equal((await save("reader",saved)).statusCode,403)
    const def = await save("editor",saved)
    assert.equal(def.statusCode,201,def.body)
    const query = "definitionId="+def.json().data.id
    assert.deepEqual((await report(query+"&all=true")).data,[{stage:"Montagem",orders:2}])
    assert.equal((await report(query+"&productionStatus=ready")).total,0)
    assert.equal((await get(query,"reader")).statusCode,404)
    assert.equal((await get(query,"editor",otherTenant)).statusCode,404)
    const listed = await app.inject({method:"GET",url:"/api/v1/system/custom-reports",headers:headers("reader")})
    assert.equal(listed.statusCode,200,listed.body)
    assert.deepEqual(listed.json().data,[])
    const countDef = await save("editor",{...saved,dataset:"stock_count_progress",columns:["reference"],filters:{progress:"50,00"}})
    assert.equal(countDef.statusCode,201,countDef.body)
    const countQuery = "definitionId="+countDef.json().data.id
    assert.equal((await get(countQuery,"reader")).statusCode,404)
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT id,'inventory.counts.read' FROM roles WHERE code='reader' AND tenant_id=$1",[tenant])
    const countAccess = await get(countQuery+period,"reader")
    assert.equal(countAccess.statusCode,200,countAccess.body)
    assert.deepEqual(countAccess.json().data,[{reference:"Conferência"}])
    assert.equal((await get(query,"reader")).statusCode,404)
    const movementDef = await save("reader",{...saved,dataset:"stock_movement_activity",columns:["unit","movements"],filters:{unit:"KG"}})
    assert.equal(movementDef.statusCode,201,movementDef.body)
    assert.deepEqual((await report("definitionId="+movementDef.json().data.id+"&movementDirection=receipt")).data,[{unit:"KG",movements:1}])
  })
})
