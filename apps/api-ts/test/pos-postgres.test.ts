import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { localCommercePostgres } from "./local-commerce-postgres.js"

test("PDV Fastify reconcilia sessão, estoque e dinheiro com RLS, perfis e confirmação repetida", {skip:!process.env.API_TS_TEST_ADMIN_URL}, async()=>{
  await localCommercePostgres(async({seed,app,tenant,other,clerk})=>{
    const cash=randomUUID(), bank=randomUUID()
    const headers={authorization:"Bearer cashier","x-tenant-id":tenant}
    const get=(path:string,company=tenant)=>app.inject({method:"GET",url:"/api/v1/pos"+path,headers:{...headers,"x-tenant-id":company}})
    const post=(path:string,payload:object,revision?:number,key=randomUUID())=>app.inject({method:"POST",url:"/api/v1/pos"+path,headers:{...headers,"idempotency-key":key,...(revision===undefined?{}:{"if-match":`"${revision}"`})},payload})
    const grant=(permission:string)=>seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)",[clerk,"sales.pos."+permission])
    const ok=(r:{statusCode:number;body:string;json():any},status=200)=>{assert.equal(r.statusCode,status,r.body);return r.json()}
    ok(await get("/sessions/current"),403)
    await grant("read")
    assert.equal(ok(await get("/sessions/current")).data,null)
    assert.equal(ok(await get("/sessions")).total,0)
    ok(await get("/sessions",other),403)
    ok(await get("/sessions?startDate=2026-11-17&endDate=2026-11-15"),422)
    const opening={register:"Caixa 02",cashAccountId:cash,openingAmount:"0.00"}
    ok(await post("/sessions",opening),403)
    await grant("manage")
    ok(await post("/sessions",opening),409)
    await seed.query("INSERT INTO financial_accounts(id,tenant_id,code,name,status,revision,account_type) VALUES($1,$3,'CX','Caixa','active',1,'cash'),($2,$3,'BC','Banco','active',1,'bank')",[cash,bank,tenant])
    await seed.query("INSERT INTO financial_account_entries(id,tenant_id,account_id,direction,amount_cents,occurred_on,description) VALUES($1,$2,$3,'credit',3000,CURRENT_DATE,'Saldo bancário')",[randomUUID(),tenant,bank])
    const openKey=randomUUID()
    const [first,repeated]=await Promise.all([post("/sessions",opening,undefined,openKey),post("/sessions",opening,undefined,openKey)])
    const session=ok(first,201).data
    assert.equal(ok(repeated,201).data.id,session.id)
    assert.equal(ok(await get("/sessions/current?register=caixa%2002")).data.id,session.id)
    assert.equal(ok(await get("/sessions/current?register=principal")).data,null)
    ok(await post("/sessions",{...opening,register:"Outro"},undefined,openKey),409)
    const path="/sessions/"+session.id
    const supplied=ok(await post(path+"/movements",{direction:"supply",amount:"10.00",sourceAccountId:bank,reason:"Fundo do turno"},1))
    assert.equal(supplied.data.totals.expectedCash,"10.00")
    ok(await post(path+"/movements",{direction:"withdrawal",amount:"11.00",targetAccountId:bank,reason:"Retirada"},2),409)
    ok(await post(path+"/movements",{direction:"withdrawal",amount:"2.00",targetAccountId:bank,reason:"Retirada"},2))
    const product="aa000000-0000-3000-2000-000000000001"
    await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'CX-1','Produto','UN',1000,'active')",[product,tenant])
    await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,4000000)",[tenant,product])
    assert.equal(ok(await get("/products?destination=SP&taxpayer=false")).data[0].unitPrice,"10.00")
    const purchase={items:[{productId:product,quantity:"1.500000"}],payments:[{method:"cash",amount:"5.00",accountId:cash,tendered:"10.00"},{method:"pix",amount:"10.00",accountId:bank}],customerId:null,expectedTotal:"15.00",destination:"SP",taxpayer:false}
    ok(await post(path+"/sales",{...purchase,expectedTotal:"8.00"},3),409)
    const key=randomUUID()
    const [sale1,sale2]=await Promise.all([post(path+"/sales",purchase,3,key),post(path+"/sales",purchase,3,key)])
    const sale=ok(sale1,201).data
    assert.deepEqual(ok(sale2,201).data,sale)
    assert.equal(sale.payments[0].change,"5.00")
    assert.equal(ok(await get("/sales?sessionId="+session.id)).total,1)
    assert.equal(ok(await get("/sales/"+sale.id)).session.totals.expectedCash,"13.00")
    assert.equal((await seed.query("SELECT quantity_micros FROM stock_balances WHERE product_id=$1",[product])).rows[0].quantity_micros,"2500000")
    const refundPath="/sales/"+sale.id+"/cancel",reason={reason:"Estorno solicitado"}
    ok(await post(refundPath,reason,4),403)
    await grant("cancel")
    assert.equal(ok(await post(refundPath,reason,4)).session.totals.expectedCash,"8.00")
    ok(await post(refundPath,reason,5),409)
    assert.equal((await seed.query("SELECT quantity_micros FROM stock_balances WHERE product_id=$1",[product])).rows[0].quantity_micros,"4000000")
    const counted={countedCash:"7.00",reason:"Conferência do turno"}
    ok(await post(path+"/close",counted,5),403)
    await grant("close")
    ok(await post(path+"/close",{countedCash:"7.00"},5),422)
    const closeKey=randomUUID()
    const closed=ok(await post(path+"/close",counted,5,closeKey))
    assert.equal(closed.data.totals.difference,"-1.00")
    assert.deepEqual(ok(await post(path+"/close",counted,5,closeKey)),closed)
    assert.equal(ok(await get("/sessions?status=closed")).total,1)
    assert.equal(ok(await get("/sessions/current")).data,null)
    ok(await post(path+"/close",counted,6),409)
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id=$1 AND event_type LIKE 'pos.%'",[tenant])).rows[0].n,6)
    const entries=await seed.query("SELECT account_id,SUM(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END)::integer AS amount FROM financial_account_entries WHERE tenant_id=$1 GROUP BY account_id",[tenant])
    assert.deepEqual(new Map(entries.rows.map(x=>[x.account_id,x.amount])),new Map([[cash,800],[bank,2200]]))
    assert.deepEqual(ok(await get("/settings")).data,{enabled:true,revision:0})
    const writeSetting=(enabled:boolean,rev:number,key=randomUUID())=>app.inject({method:"PUT",url:"/api/v1/pos/settings",headers:{...headers,"idempotency-key":key,"if-match":`"${rev}"`},payload:{enabled}})
    ok(await writeSetting(false,0),403)
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'platform.company.manage')",[clerk])
    const settingsKey=randomUUID()
    assert.deepEqual(ok(await writeSetting(false,0,settingsKey)).data,{enabled:false,revision:1})
    assert.deepEqual(ok(await writeSetting(false,0,settingsKey)).data,{enabled:false,revision:1})
    ok(await writeSetting(true,0),412)
    assert.equal(ok(await get("/settings")).data.enabled,false)
  })
})
