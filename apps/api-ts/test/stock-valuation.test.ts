import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { stockFixture } from "./stock-fixture.js"

const admin = process.env.API_TS_TEST_ADMIN_URL
test("weighted inventory posts exact costs, reconciles retroactive entries and protects period snapshots", {skip: !admin}, async t => {
  const {app, seed, tenant, close} = await stockFixture(admin!)
  t.after(close)
  const id = randomUUID()
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'CST','Teste de custo','UN',100,'active')",[id,tenant])
  const headers = {authorization:"Bearer fixture-editor-token","x-tenant-id":tenant}
  const post = (path:string, payload:object, key = randomUUID()) => app.inject({method:"POST",url:"/api/v1/stock/"+path,headers:{...headers,"idempotency-key":key},payload})
  const move = (direction:string, quantity:string, effectiveDate:string, unitCost?:string) => post("movements",{productId:id,reason:"Conferência de custo",direction,quantity,effectiveDate,...(unitCost === undefined ? {} : {unitCost})})
  const first = await move("receipt","2.000000","2024-04-02","10.000000")
  assert.equal(first.statusCode,201,first.body)
  const second = await move("receipt","3.000000","2024-04-03","20.000000")
  assert.equal(second.statusCode,201,second.body)
  const issued = await move("issue","1.000000","2024-04-04")
  assert.equal(issued.statusCode,201,issued.body)
  const read = async () => {
    const r = await app.inject({method:"GET",url:"/api/v1/stock/movements?productId="+id+"&startDate=2024-04-01&endDate=2024-04-30",headers})
    assert.equal(r.statusCode,200,r.body)
    return r.json()
  }
  assert.equal((await read()).data.find((r:{id:string}) => r.id === issued.json().id).movementValue,"16.00")
  assert.equal((await move("receipt","1.000000","2024-04-01","4.000000")).statusCode,201)
  const history=await read()
  assert.equal(history.data.find((r:{id:string}) => r.id===issued.json().id).movementValue,"14.00")
  const company=await app.inject({method:"GET",url:"/api/v1/stock",headers})
  assert.equal(company.json().data[0].stockValue,"70.00")
  const permission = "INSERT INTO role_permissions(role_id,permission_code) SELECT id,$1 FROM roles WHERE code='editor'"
  await seed.query(permission,["inventory.periods.close"])
  const queued=await app.inject({method:"GET",url:"/api/v1/stock/periods",headers})
  assert.equal(queued.statusCode,200,queued.body)
  assert.ok(queued.json().jobs.some((j:{status:string})=>j.status==="pending" || j.status==="done"))
  const posted=await post("periods/recalculate",{})
  assert.equal(posted.statusCode,200,posted.body)
  const closed=await post("periods/close",{month:"2024-04"})
  assert.equal(closed.statusCode,200,closed.body)
  const snap=await seed.query("SELECT quantity_micros::text,value_micros::text FROM stock_period_positions WHERE tenant_id=$1 AND product_id=$2",[tenant,id])
  assert.deepEqual(snap.rows,[{quantity_micros:"5000000",value_micros:"7000000000"}])
  let denied=await move("receipt","1.000000","2024-04-22","0.000000")
  assert.equal(denied.statusCode,409,denied.body)
  denied=await post("periods/reopen",{month:"2024-04",reason:"Correção aprovada"})
  assert.equal(denied.statusCode,403)
  await seed.query(permission,["inventory.periods.reopen"])
  assert.equal((await post("periods/reopen",{month:"2024-04",reason:"Correção aprovada"})).statusCode,200)
  assert.equal((await move("receipt","1.000000","2024-04-22","0.000000")).statusCode,201)
  assert.equal((await seed.query("SELECT count(*)::int total FROM audit_log WHERE tenant_id=$1 AND action='stock.period.reopened'",[tenant])).rows[0].total,1)
})
