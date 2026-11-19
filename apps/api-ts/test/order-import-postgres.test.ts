import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { localCommercePostgres } from "./local-commerce-postgres.js"

test("importação por canal preserva pedidos válidos, conflitos por linha, preço revisto e replay", {skip:!process.env.API_TS_TEST_ADMIN_URL}, async()=>{
  await localCommercePostgres(async({app,seed,tenant,other,clerk})=>{
    const headers={authorization:"Bearer cashier","x-tenant-id":tenant}
    const get=(path:string,company=tenant)=>app.inject({method:"GET",url:"/api/v1/"+path,headers:{...headers,"x-tenant-id":company}})
    const post=(path:string,payload:object,key=randomUUID(),revision?:number)=>app.inject({method:"POST",url:"/api/v1/sales-imports/"+path,headers:{...headers,"idempotency-key":key,...(revision?{"if-match":`"${revision}"`}:{})},payload})
    const ok=(r:{statusCode:number;body:string;json():any},status=200)=>{assert.equal(r.statusCode,status,r.body);return r.json()}
    const customer=randomUUID(),p1=randomUUID(),p2=randomUUID()
    await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente','52998224725',true,false,'active')",[customer,tenant])
    await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$3,'SKU-A','Banco','UN',1000,'active'),($2,$3,'SKU-B','Peso','UN',2000,'active')",[p1,p2,tenant])
    const input=(line:number,external:string,sku:string,quantity="1")=>({line,external,customer:"529.982.247-25",due:"2027-01-15",sku,quantity})
    const rows=[input(2,"EXT-10","SKU-A"),input(3,"EXT-10","SKU-B","2"),input(4,"BAD-1","FALTA"),input(5,"BAD-1","SKU-B"),input(6,"BAD-2","SKU-A","0")]
    const batch={filename:"origem.csv",channel:"loja",rows}
    ok(await get("sales-imports"),403)
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'sales.orders.read')",[clerk])
    assert.equal(ok(await get("sales-imports")).canEdit,false)
    ok(await post("preview",batch),403)
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'sales.orders.manage')",[clerk])
    const previewKey=randomUUID(), first=ok(await post("preview",batch,previewKey),201).data
    assert.equal(ok(await post("preview",batch,previewKey),201).data.id,first.id)
    assert.deepEqual(first.results.map((r:{status:string})=>r.status),["ready","ready","invalid","invalid","invalid"])
    assert.equal(first.results[0].amount,"50.00")
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM sales_orders WHERE tenant_id=$1",[tenant])).rows[0].n,0)
    ok(await get("sales-imports/"+first.id,other),403)
    const confirm=(id:string,key=randomUUID())=>post(id+"/confirm",{},key,1)
    const key=randomUUID(), confirmed=await Promise.all([confirm(first.id,key),confirm(first.id,key)])
    const a=ok(confirmed[0]!).data,b=ok(confirmed[1]!).data
    assert.deepEqual(a,b)
    assert.equal(a.results[0].orderId,a.results[1].orderId)
    assert.equal(a.results[0].status,"imported")
    assert.equal(a.results[2].status,"invalid")
    const linked=ok(await get("sales-channels/loja/orders?external=EXT-10")).data
    assert.deepEqual(linked.map((r:{orderId:string;status:string})=>[r.orderId,r.status]),[[a.results[0].orderId,"draft"]])
    const transition=(action:string,revision:number,key:string)=>app.inject({method:"POST",url:"/api/v1/orders/"+linked[0].orderId+"/"+action,headers:{...headers,"if-match":'"'+revision+'"',"idempotency-key":key},payload:{}})
    const reserved=randomUUID()
    ok(await transition("confirm",1,reserved),409)
    await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,1000000),($1,$3,2000000)",[tenant,p1,p2])
    ok(await transition("confirm",1,reserved))
    ok(await transition("confirm",1,reserved))
    assert.equal(ok(await get("sales-channels/loja/orders?external=EXT-10")).data[0].status,"confirmed")
    ok(await transition("cancel",2,randomUUID()))
    assert.equal(ok(await get("sales-channels/loja/orders?external=EXT-10")).data[0].status,"cancelled")
    const resent=ok(await post("preview",{...batch,filename:"reenviado.csv"}),201).data
    assert.equal(resent.results[0].status,"existing")
    assert.equal(resent.results[0].orderId,a.results[0].orderId)
    const changed=ok(await post("preview",{...batch,rows:[input(2,"EXT-10","SKU-A","3")]}),201).data
    assert.equal(changed.results[0].status,"invalid")
    const fresh=ok(await post("preview",{...batch,rows:[input(2,"EXT-20","SKU-A")]}),201).data
    await seed.query("UPDATE products SET price_cents=1200 WHERE tenant_id=$1 AND id=$2",[tenant,p1])
    const stale=ok(await confirm(fresh.id)).data
    assert.equal(stale.results[0].status,"invalid")
    assert.match(stale.results[0].message,/preço mudou/i)
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM sales_orders WHERE tenant_id=$1",[tenant])).rows[0].n,1)
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id=$1 AND event_type='order.channel_imported'",[tenant])).rows[0].n,1)
  })
})
