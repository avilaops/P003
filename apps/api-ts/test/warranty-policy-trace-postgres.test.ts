import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import test from "node:test"
import {localCommercePostgres} from "./local-commerce-postgres.js"

test("elegibilidade por matriz e rastreio fiscal por quantidade, série e lote",{skip:!process.env.API_TS_TEST_ADMIN_URL},async()=>{
 await localCommercePostgres(async({app,seed,tenant,other,clerk})=>{
  const [product,order,doc,category,customer,supplier,purchase,receipt]=Array.from({length:8},()=>randomUUID()) as [string,string,string,string,string,string,string,string]
  const get=(path:string,company=tenant)=>app.inject({url:"/api/v1/warranty-"+path,headers:{authorization:"Bearer cashier","x-tenant-id":company}})
  const post=(path:string,payload:object)=>app.inject({method:"POST",url:"/api/v1/warranty-"+path,headers:{authorization:"Bearer cashier","x-tenant-id":tenant,"idempotency-key":randomUUID()},payload})
  const ok=(r:{statusCode:number;body:string;json():any},status=200)=>{assert.equal(r.statusCode,status,r.body);return r.json()}
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'service.warranties.read'),($1,'service.warranties.manage')",[clerk])
  await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$3,'fisica','Cliente','52998224725',true,false,'active'),($2,$3,'juridica','Fornecedor','11222333000181',false,true,'active')",[customer,supplier,tenant])
  await seed.query("INSERT INTO product_categories(id,tenant_id,code,name,status,revision,sort_order) VALUES($1,$2,'B','Bancos','active',1,1)",[category,tenant])
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status,category_id) VALUES($1,$2,'EQ-1','Banco','UN',10000,'active',$3)",[product,tenant,category])
  await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','52998224725',CURRENT_DATE,30000,'draft')",[order,tenant,customer])
  await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,product_id,line_number,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,$3,1,'EQ-1','Banco','UN',3000000,10000,30000)",[tenant,order,product])
  await seed.query("INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Fornecedor','11222333000181',CURRENT_DATE,9000,'received')",[purchase,tenant,supplier])
  await seed.query("INSERT INTO purchase_receipts(id,tenant_id,order_id,reference,occurred_on,amount_cents) VALUES($1,$2,$3,'Recebimento original',CURRENT_DATE-10,9000)",[receipt,tenant,purchase])
  await seed.query("INSERT INTO purchase_receipt_lines(tenant_id,receipt_id,product_id,unit,quantity_micros,amount_cents) VALUES($1,$2,$3,'UN',3000000,9000)",[tenant,receipt,product])
  await seed.query("INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents) VALUES($1,$2,'production',55,1,1,'{}',$3,30000)",[tenant,doc,{items:[{code:"EQ-1",quantity:"3.0000"}]}])
  const xml='<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe><det nItem="1"><prod><cProd>EQ-1</cProd><rastro><nLote>L001</nLote><qLote>2</qLote></rastro><rastro><nLote>L002</nLote><qLote>1</qLote></rastro></prod></det></infNFe></NFe></nfeProc>'
  await seed.query("INSERT INTO fiscal_nfe_documents(tenant_id,id,environment,source_order_id,model,status,series,number,issued_at,random_code,access_key,signed_xml,authorized_xml,protocol) VALUES($1,$2,'production',$3,55,'authorized',1,285,(now()-interval '5 days')::text,'00000001',repeat('1',44),$4,$4,'ok')",[tenant,doc,order,xml])
  const query="documentId="+doc+"&lineNumber=1",trace={brand:"Marca A",channel:"feira",reference:"Etiqueta conferida 710",receiptId:receipt}
  const create=(name:string,scope:object,extra={})=>post("policies",{name,durationDays:365,coverageType:"contractual",scope,...extra})
  const broad=ok(await create("Política da empresa",{}),201).data.id
  const scoped=ok(await create("Matriz técnica",{productId:product,categoryId:category,brand:trace.brand,supplierId:supplier,channel:"feira"}),201).data.id
  ok(await create("Categoria inexistente",{categoryId:randomUUID()}),422)
  ok(await create("Fora da data",{productId:product},{validFrom:"2100-01-01"}),201)
  assert.equal(ok(await get("origins?q=285")).data[0].orderId,order)
  const pol=ok(await get("policies?"+query+"&"+new URLSearchParams(trace)))
  assert.deepEqual(pol.data.map((p:any)=>p.id),[scoped])
  assert.deepEqual(pol.lots,[{lot:"L001",availableUnits:2},{lot:"L002",availableUnits:1}])
  assert.equal(pol.receipts[0].id,receipt)
  const identity={policyId:scoped,documentId:doc,lineNumber:1,trace,lot:"L001"}
  ok(await post("equipment",{...identity,units:2,policyId:broad}),422)
  ok(await post("equipment",{...identity,serialNumber:"S01",lot:"FABRICADO"}),422)
  ok(await post("equipment",{...identity,serialNumber:"S01",trace:{...trace,reference:undefined}}),422)
  const equipment=ok(await post("equipment",{...identity,units:2}),201).data
  assert.equal(equipment.traceSnapshot.lotSource,"NF-e autorizada")
  assert.equal(equipment.traceSnapshot.receipt.supplierId,supplier)
  assert.equal(equipment.traceSnapshot.registeredBy,"cashier")
  assert.equal(equipment.policySnapshot.name,"Matriz técnica")
  ok(await post("equipment",{...identity,serialNumber:"S01"}),409)
  const serial=ok(await post("equipment",{...identity,serialNumber:"S01",lot:"L002"}),201).data
  assert.equal(serial.units,1)
  assert.equal(ok(await get("origins?orderId="+order)).data[0].availableUnits,0)
  ok(await get("equipment?lot=L001",other),403)
  const claim={title:"Reparo do lote",description:"Verificar o reparo do equipamento.",criticality:"normal",lot:"l001"}
  ok(await post("cases",{...claim,serialNumber:"S01"}),422)
  const opened=ok(await post("cases",claim),201).data
  assert.equal(opened.equipmentId,equipment.id)
  assert.equal(opened.serialNumber,null)
  await seed.query("UPDATE warranty_policies SET duration_days=7,name='Política alterada',revision=2 WHERE id=$1",[scoped])
  const stored=ok(await get("cases/"+opened.id)).data.equipment
  assert.equal(stored.remainingDays,360)
  assert.equal(stored.policySnapshot.name,"Matriz técnica")
  assert.equal(stored.lot,"L001")
 })
})
