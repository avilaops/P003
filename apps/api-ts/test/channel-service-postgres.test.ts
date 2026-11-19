import assert from "node:assert/strict"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import test from "node:test"
import { commercialFixture } from "./commercial-fixture.js"
import { localCommercePostgres } from "./local-commerce-postgres.js"

test("Canal recebe comandos, confirma publicação e concilia pedido e reserva", {skip:!process.env.API_TS_TEST_ADMIN_URL},async()=>{
 await localCommercePostgres(async({app,seed,tenant,other,clerk})=>{
  const store="/api/v1/commercial/policies/store",machine="/api/v1/integrations/sales-channels/site/"
  const keyId=randomUUID(),product=randomUUID(),list=randomUUID()
  const token="erp_"+tenant+"_"+randomBytes(32).toString("hex")
  const headers={authorization:"Bearer cashier","x-tenant-id":tenant}
  const get=(url:string,authorization="Bearer cashier")=>app.inject({url,headers:{authorization,...(url.startsWith(machine)?{}:{"x-tenant-id":tenant})}})
  const post=(url:string,payload:object,revision?:number)=>app.inject({method:"POST",url,payload,headers:{...headers,"idempotency-key":randomUUID(),...(revision?{"if-match":'"'+revision+'"'}:{})}})
  const deliver=(path:string,payload:object,credential=token)=>app.inject({method:"POST",url:machine+path,payload,headers:{authorization:"Bearer "+credential}})
  const ok=(r:{body:string;statusCode:number;json():any},status=200)=>{assert.equal(r.statusCode,status,r.body);return r.json()}
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])",[clerk,["sales.orders.manage","sales.orders.read","platform.integrations.manage"]])
  await seed.query("INSERT INTO service_api_keys(id,tenant_id,name,key_prefix,key_hash,created_by_identity_id) SELECT $1,$2,'Canal local',$3,$4,id FROM identities WHERE auth_subject='cashier'",[keyId,tenant,token.slice(0,25),createHash("sha256").update(token).digest()])
  await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente','52998224725',true,false,'active')",[randomUUID(),tenant])
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'BN-A','Banco','UN',12000,'active')",[product,tenant])
  await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,5000000)",[tenant,product])
  await seed.query("INSERT INTO price_lists(tenant_id,id,code,name,status) VALUES($1,$2,'SITE','Canal','active')",[tenant,list])
  await seed.query("INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price_cents) VALUES($1,$2,$3,11321)",[tenant,list,product])
  await seed.query("INSERT INTO sales_channel_prices(tenant_id,channel,price_list_id) VALUES($1,'site',$2)",[tenant,list])
  const config={kind:"connector",channel:"site",name:"Site local",keyId,enabled:true,revision:0}
  assert.equal(ok(await post(store,config)).revision,1)
  assert.equal(ok(await get(store)).connectors.length,1)
  const registration=await post(store,{kind:"listing",channel:"site",productId:product,reference:"WEB-BANCO",title:"Banco",revision:0})
  const listing=ok(registration).id
  assert.equal(registration.headers.etag,'"1"')
  const issue=(action:string,revision:number)=>post(store,{kind:"delivery",id:listing,action,revision})
  const first=ok(await issue("publish",1)).deliveryId
  assert.equal(ok(await get(store+"/"+listing)).listings[0].status,"draft")
  ok(await get(machine+"deliveries"),401)
  ok(await deliver("events",{},"cashier"),401)
  ok(await get(machine+"deliveries","Bearer "+token.replace(tenant,other)),401)
  ok(await app.inject({url:machine.replace("/site/","/outro/")+"deliveries",headers:{authorization:"Bearer "+token}}),401)
  const poll=async()=>ok(await get(machine+"deliveries","Bearer "+token)).data
  const sent=await poll()
  assert.equal(sent[0].id,first)
  assert.equal(sent[0].payload.availableMicros,"5000000")
  assert.equal(sent[0].payload.unitPriceCents,"11321")
  assert.deepEqual(await poll(),sent)
  const ack=(delivery:string,status:string,reference:string)=>deliver("deliveries/"+delivery+"/confirmation",{status,reference})
  ok(await ack(first,"failed","timeout"))
  assert.equal(ok(await get(store)).listings[0].status,"draft")
  const retry=ok(await issue("publish",3)).deliveryId
  ok(await ack(retry,"confirmed","pub-1"))
  ok(await ack(retry,"confirmed","pub-1"))
  ok(await ack(retry,"failed","other"),409)
  assert.equal(ok(await get(store)).listings[0].status,"published")
  const event={kind:"order",eventId:"E01",externalNumber:"S01",customer:"52998224725",due:"2027-01-20",items:[{reference:"WEB-BANCO",quantity:"2"}]}
  const received=ok(await deliver("events",event))
  assert.deepEqual(ok(await deliver("events",event)),received)
  ok(await deliver("events",{...event,due:"2027-01-21"}),409)
  const preview=ok(await get("/api/v1/sales-imports/"+received.importId))
  assert.equal(preview.data.results[0].amount,"226.42")
  const result=ok(await post("/api/v1/sales-imports/"+received.importId+"/confirm",{},1))
  const order=result.data.results[0].orderId
  assert.equal(ok(await deliver("events",event)).orderId,order)
  ok(await post("/api/v1/orders/"+order+"/confirm",{},1))
  assert.equal(ok(await get(store)).orders[0].reservedMicros,"2000000")
  const sync=ok(await issue("sync",5)).deliveryId
  assert.equal((await poll())[0].payload.availableMicros,"3000000")
  ok(await ack(sync,"confirmed","sync-1"))
  const cancel={kind:"cancel",eventId:"E02",externalNumber:"S01"}
  ok(await deliver("events",cancel))
  assert.equal(ok(await get(store)).events[0].status,"awaiting_reconciliation")
  ok(await post("/api/v1/orders/"+order+"/cancel",{},2))
  assert.equal(ok(await get(store)).events[0].status,"reconciled")
  // A published equipment uses the same tax, approval and price version as the mixed order editor.
  const {parameters,rules}=commercialFixture(),version=randomUUID()
  await seed.query("UPDATE parties SET addresses=$1 WHERE tenant_id=$2",[JSON.stringify([{state:"SP",primary:true}]),tenant])
  await seed.query("INSERT INTO commercial_approval_settings(tenant_id,revision,rules) VALUES($1,1,$2)",[tenant,rules])
  await seed.query("INSERT INTO product_costs(tenant_id,product_id,product_line,purchase_cost_cents,tax_credit_bps,packaging_cents,revision) VALUES($1,$2,'national',1200,0,0,1)",[tenant,product])
  await seed.query("INSERT INTO commercial_settings(tenant_id,product_line,parameters,revision) VALUES($1,'national',$2,1)",[tenant,parameters])
  await seed.query("INSERT INTO price_table_versions(id,tenant_id,product_line,version,settings_revision,policy_snapshot,calculator_version,digest,published_by) SELECT $1,$2,'national',1,1,$3,'fixture',repeat('e',64),id FROM identities WHERE auth_subject='cashier'",[version,tenant,parameters])
  await seed.query("INSERT INTO price_table_items(tenant_id,version_id,product_id,product_snapshot,cost_revision,cost_snapshot,price_without_ipi_cents,ipi_bps,price_with_ipi_cents) VALUES($1,$2,$3,$4,1,$5,12000,1300,13560)",[tenant,version,product,{sku:"BN-A",name:"Banco",unit:"UN",revision:1},{purchaseCostCents:1200,taxCreditBps:0,packagingCents:0}])
  await seed.query("UPDATE commercial_settings SET active_price_version_id=$2 WHERE tenant_id=$1 AND product_line='national'",[tenant,version])
  const republished=ok(await issue("sync",7)).deliveryId
  const publishedPayload=(await poll())[0].payload
  assert.equal(publishedPayload.unitPriceCents,"12793")
  assert.equal(publishedPayload.priceVersionId,version)
  ok(await ack(republished,"confirmed","price-2"))
  const quoted=ok(await deliver("events",{...event,eventId:"E-published",externalNumber:"S-published"}))
  const quotePreview=ok(await get("/api/v1/sales-imports/"+quoted.importId)).data.results[0]
  assert.equal(quotePreview.amount,"255.86",JSON.stringify(quotePreview))
  const quotedOrder=ok(await post("/api/v1/sales-imports/"+quoted.importId+"/confirm",{},1)).data.results[0].orderId
  const frozen=ok(await get("/api/v1/commercial/orders/"+quotedOrder))
  assert.equal(frozen.data.input.items[0].versionId,version)
  assert.equal(frozen.data.sale.items[0].priceOrigin.listId,list)
  const returnEvent={kind:"return",eventId:"E-return",externalNumber:"S-published"}
  assert.equal(ok(await deliver("events",returnEvent)).status,"awaiting_reconciliation")
  const resolution={kind:"return",channel:"site",eventId:returnEvent.eventId,returnId:randomUUID()}
  ok(await post(store,resolution),422)
  const lot=randomUUID()
  await seed.query("INSERT INTO sales_invoice_lots(tenant_id,id,order_id,environment) VALUES($1,$2,$3,'production')",[tenant,lot,quotedOrder])
  const xml="<nfeProc/>"
  const receipt=await seed.query("INSERT INTO fiscal_received_nfes(tenant_id,access_key,issuer_document,issuer_name,recipient_document,number,series,issued_at,total_cents,item_count,environment,xml,xml_sha256,imported_by_identity_id) SELECT $1,repeat('2',44),'11222333000181','Cliente','04252011000110',1,1,now(),12793,1,1,$2,$3,id FROM identities WHERE auth_subject='cashier' RETURNING id",[tenant,xml,createHash("sha256").update(xml).digest("hex")])
  await seed.query("INSERT INTO sales_partial_returns(tenant_id,id,lot_id,received_nfe_id,reason,destination,credited_cents,abated_cents) VALUES($1,$2,$3,$4,'Devolução conferida','stock',12793,0)",[tenant,resolution.returnId,lot,receipt.rows[0].id])
  assert.equal(ok(await get(store)).events.find((e:any)=>e.id===returnEvent.eventId).availableReturns[0].id,resolution.returnId)
  ok(await post(store,resolution))
  const reconciled=ok(await deliver("events",returnEvent))
  assert.equal(reconciled.status,"reconciled")
  assert.equal(reconciled.returnId,resolution.returnId)
  ok(await deliver("events",{...returnEvent,eventId:"E-return-2"}))
  ok(await post(store,{...resolution,eventId:"E-return-2"}),409)
  const pause=ok(await issue("pause",9)).deliveryId
  ok(await ack(pause,"confirmed","pause-1"))
  assert.equal(ok(await get(store)).listings[0].status,"paused")
  ok(await deliver("events",{...event,eventId:"E03",externalNumber:"S02"}),422)
  assert.equal((await seed.query("SELECT count(*)::int n FROM sales_orders WHERE tenant_id=$1",[tenant])).rows[0].n,2)
  await seed.query("UPDATE service_api_keys SET revoked_at=now() WHERE id=$1",[keyId])
  ok(await get(machine+"deliveries","Bearer "+token),401)
 })
})
