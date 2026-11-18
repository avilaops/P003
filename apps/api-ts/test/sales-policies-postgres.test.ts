import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { localCommercePostgres } from "./local-commerce-postgres.js"
import { commercialFixture } from "./commercial-fixture.js"

test("Condições, preços, crédito e aprovação por empresa e documento", {skip: !process.env.API_TS_TEST_ADMIN_URL}, async () => {
  await localCommercePostgres(async ({seed, app, tenant, other, clerk}) => {
    const buyer=randomUUID(), product=randomUUID(), method=randomUUID(), customerList=randomUUID(), channelList=randomUUID()
    const manager=randomUUID(), membership=randomUUID(), managerRole=randomUUID()
    const headers=(user="cashier", key=randomUUID(), revision?:number)=>({authorization:"Bearer "+user,"x-tenant-id":tenant,"idempotency-key":key,...(revision?{"if-match":`"${revision}"`}:{})})
    const post=(path:string,payload:object,user="cashier",rev?:number,key=randomUUID())=>app.inject({method:"POST",url:"/api/v1/"+path,headers:headers(user,key,rev),payload})
    const get=(path:string,user="cashier")=>app.inject({url:"/api/v1/"+path,headers:headers(user)})
    const ok=(r:{statusCode:number;body:string;json():any},expected=200)=>{assert.equal(r.statusCode,expected,r.body);return r.json()}
    const policies="commercial/policies/"
    const settings=(body:object)=>post(policies+"settings",body)
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])",[clerk,["sales.orders.read","sales.orders.manage","sales.proposals.read","sales.proposals.manage","sales.proposals.decide","sales.approvals.director","platform.company.manage","finance.receivables.manage"]])
    await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,'reviewer','reviewer@example.test','Gerente')",[manager])
    await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)",[membership,tenant,manager])
    await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'approver','Gerente')",[managerRole,tenant])
    await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)",[membership,managerRole])
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])",[managerRole,["sales.orders.read","sales.proposals.read"]])
    await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status,email,addresses) VALUES($1,$2,'fisica','Cliente','52998224725',true,false,'active','compras@example.test',$3)",[buyer,tenant,JSON.stringify([{state:"SP"}])])
    await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'SIM','Banco','UN',1256323,'active')",[product,tenant])
    await seed.query("INSERT INTO payment_methods(id,tenant_id,code,name,status,revision,modality,settlement_days) VALUES($1,$2,'PIX','Pix','active',1,'pix',0)",[method,tenant])
    await seed.query("INSERT INTO price_lists(tenant_id,id,code,name,status) VALUES($1,$2,'C','Cliente','active'),($1,$3,'W','Canal','active')",[tenant,customerList,channelList])
    await seed.query("INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price_cents) VALUES($1,$2,$4,10001),($1,$3,$4,1200050)",[tenant,customerList,channelList,product])
    const configured={kind:"term",revision:0,name:"30% e três parcelas",entryBps:3000,days:[30,60,90],methodId:method,active:true}
    const term=ok(await settings(configured))
    const customer={kind:"customer",id:buyer,revision:0,creditLimitCents:9999999,validUntil:null,blocked:false,overdueDays:null,termId:term.id,listId:customerList}
    ok(await settings(customer))
    ok(await settings({...customer,revision:0}),412)
    ok(await settings({kind:"channel",channel:"Distribuidor",listId:channelList,revision:0}))
    assert.equal(ok(await get(policies+"catalog/"+buyer)).defaultTermId,term.id)
    const ref={id:term.id,revision:1,start:"2026-11-18"}
    const plan=ok(await post(policies+"plan",{term:ref,totalCents:10001}))
    assert.equal(plan.entryCents,3000)
    assert.deepEqual(plan.installments.map((x:any)=>[x.dueOn,x.amountCents]),[["2026-12-18",2334],["2027-01-17",2334],["2027-02-16",2333]])
    const checkout={paymentTerm:ref,entry:plan.entry,installments:plan.installments,deliveryNotes:"",paymentNotes:"",notes:""}
    const proposed={customerId:buyer,validUntil:"2100-01-01",paymentTerms:"Acordo",deliveryTerms:"Retirada",notes:"",items:[{productId:product,quantity:"1.000000"}],checkout}
    const proposal=ok(await post("proposals",proposed),201)
    assert.equal(proposal.items[0].priceOrigin.listId,customerList)
    ok(await settings({...configured,id:term.id,revision:1,entryBps:5000}))
    ok(await post(policies+"plan",{term:ref,totalCents:10001}),412)
    const order=ok(await post("proposals/"+proposal.data.id+"/approve-order",{dueDate:"2026-12-18"},"cashier",1)).data.orderId
    const agreed=ok(await get("orders/"+order))
    assert.equal(agreed.checkout.paymentTerm.entryBps,3000)
    assert.equal(agreed.checkout.installments[2].amountCents,2333)
    assert.equal(agreed.items[0].priceOrigin.listId,customerList)

    const seller=randomUUID()
    await seed.query("INSERT INTO staff(id,tenant_id,code,name,is_employee,is_seller,status) VALUES($1,$2,'VEN','Vendedor',false,true,'active')",[seller,tenant])
    await seed.query("INSERT INTO order_commission_terms(tenant_id,order_id,seller_staff_id,seller_name,commission_rate,ipi_rate,payment_day) VALUES($1,$2,$3,'Vendedor',50000,0,10)",[tenant,order,seller])
    // Both entry points block before issuing stock or creating accounts receivable.
    ok(await settings({...customer,revision:1,creditLimitCents:9000}))
    for (const action of ["accept","confirm"]) assert.match(ok(await post("orders/"+order+"/"+action,{},"cashier",1),409).title,/Limite de crédito/)
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM sales_credit_reviews WHERE tenant_id=$1",[tenant])).rows[0].n,1)
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM receivables WHERE tenant_id=$1",[tenant])).rows[0].n,0)
    const pending=(await seed.query("SELECT id FROM sales_credit_reviews WHERE tenant_id=$1",[tenant])).rows[0].id
    const decision={approved:true,reason:"Limite extraordinário",requests:[{kind:"credit",id:pending,revision:1}]}
    ok(await post(policies+"decisions",decision),403)
    ok(await post(policies+"decisions",decision,"reviewer"),403)
    ok(await settings({kind:"routing",level:"credit",dueHours:12,substituteId:manager,until:"2100-01-01",revision:0}))
    assert.equal(ok(await get(policies+"queue","reviewer")).data[0].id,pending)
    assert.equal(ok(await get(policies+"queue")).data.length,0)
    ok(await post(policies+"decisions",{...decision,requests:[...decision.requests,{kind:"credit",id:randomUUID(),revision:1}]},"reviewer"),409)
    const key=randomUUID()
    for (const reply of await Promise.all([post(policies+"decisions",decision,"reviewer",undefined,key),post(policies+"decisions",decision,"reviewer",undefined,key)])) ok(reply)
    assert.equal(ok(await get(policies+"queue")).notifications[0].reason,decision.reason)
    ok(await settings({kind:"routing",level:"credit",dueHours:12,substituteId:null,until:null,revision:1}))
    ok(await post(policies+"decisions",decision,"reviewer",undefined,key),403)
    ok(await post("orders/"+order+"/accept",{},"cashier",1))
    const entry=(await seed.query("SELECT id FROM receivables WHERE tenant_id=$1 AND order_id=$2 ORDER BY due_date LIMIT 1",[tenant,order])).rows[0].id
    await seed.query("INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on) VALUES($1,$2,$3,'receipt',3000,'cash','Entrada recebida',CURRENT_DATE)",[randomUUID(),tenant,entry])
    const second=ok(await post("orders",{customerId:buyer,dueDate:"2027-01-01",items:[{productId:product,quantity:"1.000000"}]}),201).data.id
    ok(await post("orders/"+second+"/confirm",{},"cashier",1),409)
    assert.equal((await seed.query("SELECT exposure_cents::int AS balance FROM sales_credit_reviews WHERE order_id=$1",[second])).rows[0].balance,17002)
    // Individual lines resolve through the buyer list, the channel, then the published base.
    const {parameters,rules}=commercialFixture(), version=randomUUID()
    await seed.query("INSERT INTO commercial_approval_settings(tenant_id,revision,rules) VALUES($1,1,$2)",[tenant,rules])
    await seed.query("INSERT INTO product_costs(tenant_id,product_id,product_line,purchase_cost_cents,tax_credit_bps,packaging_cents,revision) VALUES($1,$2,'national',530606,2780,0,1)",[tenant,product])
    await seed.query("INSERT INTO commercial_settings(tenant_id,product_line,parameters,revision) VALUES($1,'national',$2,1)",[tenant,parameters])
    await seed.query("INSERT INTO price_table_versions(id,tenant_id,product_line,version,settings_revision,policy_snapshot,calculator_version,digest,published_by) VALUES($1,$2,'national',1,1,$3,'fixture',repeat('e',64),$4)",[version,tenant,parameters,manager])
    await seed.query("INSERT INTO price_table_items(tenant_id,version_id,product_id,product_snapshot,cost_revision,cost_snapshot,price_without_ipi_cents,ipi_bps,price_with_ipi_cents) VALUES($1,$2,$3,$4,1,$5,1256323,1300,1419645)",[tenant,version,product,{sku:"SIM",name:"Banco",unit:"UN",revision:1},{purchaseCostCents:530606,taxCreditBps:2780,packagingCents:0}])
    await seed.query("UPDATE commercial_settings SET active_price_version_id=$2 WHERE tenant_id=$1 AND product_line='national'",[tenant,version])
    await seed.query("UPDATE price_list_items SET price_cents=1300001 WHERE tenant_id=$1 AND price_list_id=$2",[tenant,customerList])
    const input={line:"national",versionId:version,destinationState:"SP",taxpayer:false,discount:{kind:"percent",value:0},freightCents:0,downPaymentCents:null,items:[{productId:product,quantity:1}],channel:"Distribuidor"}
    const simulate=async(input:object)=>ok(await post("commercial/simulate",input))
    const anonymous=await simulate(input)
    assert.equal(anonymous.sale.items[0].tableUnitCents,1200050)
    ok(await post("commercial/orders",{simulation:input,digest:anonymous.digest,customerId:buyer,dueDate:"2027-01-01"}),409)
    const priced={...input,customerId:buyer}
    const quote=await simulate(priced)
    assert.equal(quote.sale.items[0].priceOrigin.kind,"customer")
    const signed=ok(await post("commercial/orders",{simulation:priced,digest:quote.digest,customerId:buyer,dueDate:"2027-01-01"}),201).id
    await seed.query("UPDATE price_lists SET valid_until=CURRENT_DATE-1 WHERE tenant_id=$1 AND id=$2",[tenant,customerList])
    assert.equal((await simulate(priced)).sale.items[0].priceOrigin.kind,"channel")
    await seed.query("UPDATE price_lists SET status='archived' WHERE tenant_id=$1 AND id=$2",[tenant,channelList])
    assert.equal((await simulate(priced)).sale.items[0].tableUnitCents,1256323)
    assert.equal(ok(await get("orders/"+signed)).items[0].priceOrigin.baseCents,1300001)
    const dates=(await seed.query("SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS month,to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS today")).rows[0]
    const target={sellerId:seller,month:dates.month,line:"catalog",basis:"accepted",targetCents:500000,targetMicros:"2000000",alertBps:8000,revision:0}
    ok(await post(policies+"goals",target))
    ok(await post(policies+"goals",target),412)
    const reportUrl=policies+"performance?from="+dates.month+"-01&to="+dates.today+"&seller="+seller+"&basis=accepted"
    const summary=ok(await get(reportUrl))
    assert.equal(summary.goals[0].achievedCents,"10001")
    assert.equal(summary.goals[0].achievedMicros,"1000000")
    assert.equal(summary.abc[0].class,"A")
    assert.equal(summary.totals.orderedCents,"10001")
    assert.equal(summary.orders[0].id,order)
    assert.equal(summary.margins[0].forecastGrossCents,null)
    assert.equal(ok(await get(reportUrl,"reviewer")).margins,null)
    const purchase=randomUUID(),receipt=randomUUID()
    await seed.query("INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Fornecedor','52998224725',CURRENT_DATE,6000,'received')",[purchase,tenant,buyer])
    await seed.query("INSERT INTO purchase_order_lines(tenant_id,order_id,product_id,line_number,sku,name,unit,quantity_micros,cost_cents,amount_cents) VALUES($1,$2,$3,1,'SIM','Banco','UN',1000000,6000,6000)",[tenant,purchase,product])
    await seed.query("INSERT INTO purchase_receipts(tenant_id,id,order_id,reference,occurred_on,amount_cents) VALUES($1,$2,$3,'Entrada',CURRENT_DATE,6000)",[tenant,receipt,purchase])
    await seed.query("INSERT INTO purchase_receipt_lines(tenant_id,receipt_id,product_id,unit,quantity_micros,amount_cents) VALUES($1,$2,$3,'UN',1000000,6000)",[tenant,receipt,product])
    const invoice=randomUUID()
    await seed.query("INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents) VALUES($1,$2,'production',55,1,1,'{}','{}',10001)",[tenant,invoice])
    const xml='<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe><total><ICMSTot><vNF>115.01</vNF></ICMSTot></total></infNFe></NFe></nfeProc>'
    await seed.query("INSERT INTO fiscal_nfe_documents(tenant_id,id,source_order_id,environment,status,series,number,issued_at,random_code,access_key,signed_xml,authorized_xml,protocol) VALUES($1,$2,$3,'production','authorized',1,1,now()::text,'00000000',repeat('1',44),'signed',$4,'ok')",[tenant,invoice,order,xml])
    const billed=ok(await get(reportUrl.replace("basis=accepted","basis=invoiced")))
    assert.equal(billed.totals.invoicedCents,"11501")
    assert.equal(billed.abc[0].cents,"11501")
    assert.equal(billed.margins[0].actualCostCents,"6000")
    assert.equal(billed.margins[0].actualGrossCents,"4001")
    await seed.query("UPDATE sales_orders SET created_at=now()-interval '3 months' WHERE id=$1",[order])
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'finance.receivables.read')",[clerk])
    const origins=ok(await get(reportUrl+"&channel=Direto"))
    assert.equal(origins.totals.orderedCents,"0")
    assert.equal(origins.totals.receivedCents,"3000")
    assert.equal(origins.orders.length,1)
    assert.deepEqual([origins.orders[0].id,origins.orders[0].cents,origins.orders[0].invoicedCents,origins.orders[0].receivedCents],[order,"0","11501","3000"])
    assert.equal(ok(await get(reportUrl+"&channel=outro")).orders.length,0)
    assert.equal(ok(await get(reportUrl,"reviewer")).orders[0].receivedCents,null)
    await seed.query("UPDATE fiscal_nfe_documents SET status='cancelled' WHERE id=$1",[invoice])
    assert.equal(ok(await get(reportUrl)).totals.invoicedCents,"0")
    ok(await app.inject({url:"/api/v1/"+policies+"queue",headers:{...headers(),"x-tenant-id":other}}),403)
  })
})
