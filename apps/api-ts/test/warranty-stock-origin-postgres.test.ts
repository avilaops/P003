import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import test from "node:test"
import {stockFixture} from "./stock-fixture.js"

test("garantia confere série entregue pelo movimento do lote e recupera política e pedido sem redigitação",{skip:!process.env.API_TS_TEST_ADMIN_URL},async t=>{
 const {app,seed,tenant,otherTenant,close}=await stockFixture(process.env.API_TS_TEST_ADMIN_URL!)
 t.after(close)
 const product=randomUUID(),order=randomUUID(),movement=randomUUID()
 const headers={authorization:"Bearer fixture-editor-token","x-tenant-id":tenant}
 const post=(path:string,payload:object)=>app.inject({method:"POST",url:"/api/v1/"+path,headers:{...headers,"idempotency-key":randomUUID()},payload})
 const query=(serial:string,company=tenant)=>app.inject({url:"/api/v1/warranty-equipment?serialNumber="+serial,headers:{...headers,"x-tenant-id":company}})
 const ok=(r:{statusCode:number;body:string;json():any},status=200)=>{assert.equal(r.statusCode,status,r.body);return r.json()}
 await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT id,unnest(ARRAY['service.warranties.read','service.warranties.manage']) FROM roles WHERE code='editor'")
 await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'E3','Equipamento','UN',100,'active')",[product,tenant])
 ok(await post("stock/serials/configure",{productId:product,opening:[]}))
 ok(await post("stock/movements",{productId:product,direction:"receipt",quantity:"2.000000",serials:["E3-A","E3-B"],reason:"Recebimento inicial"}),201)
 await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725',current_date,200,'accepted')",[order,tenant])
 await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'E3','Equipamento','UN',2000000,100,200)",[tenant,order,product])
 ok(await post("stock/serials/assign",{productId:product,kind:"sale",direction:"issue",documentId:order,serials:["E3-A","E3-B"]}))
 await seed.query("UPDATE sales_orders SET status='confirmed' WHERE id=$1",[order])
 const claim={title:"Revisão do equipamento",description:"Verificar falha na unidade entregue.",criticality:"normal",serialNumber:"e3-a"}
 assert.deepEqual(ok(await query("e3-a")).stockOrigins,[])
 ok(await post("warranty-cases",claim),409)
 async function invoice(number:number){
   const lot=randomUUID(),doc=randomUUID()
   const details={recipient:{taxId:"52998224725"},items:[{code:"E3",unit:"UN",quantity:"1.0000",unitPrice:"1.00"}]}
   await seed.query("INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents) VALUES($1,$2,'production',55,1,1,'{}',$3,100)",[tenant,doc,details])
   await seed.query("INSERT INTO sales_invoice_lots(tenant_id,id,order_id,environment,draft_id) VALUES($1,$2,$3,'production',$4)",[tenant,lot,order,doc])
   await seed.query("INSERT INTO sales_invoice_lot_items(tenant_id,lot_id,order_id,line_number,quantity_micros) VALUES($1,$2,$3,1,1000000)",[tenant,lot,order])
   await seed.query("INSERT INTO fiscal_nfe_documents(tenant_id,id,environment,model,status,series,number,issued_at,random_code,access_key,signed_xml,authorized_xml,protocol) VALUES($1,$2,'production',55,'authorized',1,$3,now()::text,'11223344',$4,'<doc/>','<doc/>','autorizada')",[tenant,doc,number,String(number).padStart(44,"0")])
   return {lot,doc}
 }
 const shipped=await invoice(41),waiting=await invoice(42)
 const db=await seed.connect()
 try{
   await db.query("BEGIN")
   await db.query("UPDATE stock_balances SET quantity_micros=1000000 WHERE tenant_id=$1 AND product_id=$2",[tenant,product])
   await db.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_order_id,sales_invoice_lot_id,serial_numbers) VALUES($1,$2,$3,'issue',1000000,1000000,'Entrega do lote',$4,$5,ARRAY['E3-A'])",[movement,tenant,product,order,shipped.lot])
   await db.query("UPDATE sales_invoice_lots SET delivered_at=now() WHERE tenant_id=$1 AND id=$2",[tenant,shipped.lot])
   await db.query("COMMIT")
 } finally {db.release()}
 const source=ok(await query("e3-a"))
 assert.equal(source.stockTracked,true)
 assert.deepEqual(source.stockOrigins.map((o:any)=>[o.orderId,o.documentId,o.lineNumber,o.movementId]),[[order,shipped.doc,1,movement]])
 assert.equal(ok(await query("E3-A",otherTenant)).stockTracked,false)
 const policyId=ok(await post("warranty-policies",{name:"Contratual E3",coverageType:"contractual",durationDays:360,scope:{productId:product}}),201).data.id
 const id={serialNumber:"e3-a",policyId,documentId:waiting.doc,lineNumber:1}
 ok(await post("warranty-equipment",id),422)
 ok(await post("warranty-equipment",{...id,serialNumber:"E3-B",documentId:shipped.doc}),409)
 ok(await post("warranty-equipment",{lot:"SEM-SERIE",policyId,documentId:shipped.doc,lineNumber:1,trace:{reference:"Etiqueta manual"}}),422)
 ok(await post("warranty-cases",{...claim,orderId:randomUUID()}),422)
 const opened=ok(await post("warranty-cases",claim),201).data
 assert.deepEqual([opened.orderId,opened.documentId,opened.lineNumber,opened.customerId,opened.productId,opened.policyId,opened.coverageStatus,opened.serialNumber],[order,shipped.doc,1,tenant,product,policyId,"eligible","E3-A"])
 const identity=ok(await query("e3-a")).data
 assert.equal(identity.traceSnapshot.movementId,movement)
 assert.equal(identity.traceSnapshot.invoiceLotId,shipped.lot)
 ok(await post("warranty-cases",{...claim,documentId:waiting.doc,lineNumber:1}),422)
 const search=ok(await app.inject({url:"/api/v1/warranty-origins?q=e3-a",headers}))
 assert.equal(search.data[0].documentId,shipped.doc)
 ok(await post("warranty-cases",{...claim,serialNumber:"INVENTADA",documentId:shipped.doc,lineNumber:1}),422)
 ok(await post("warranty-cases",{...claim,serialNumber:null,lot:"Somente lote",documentId:shipped.doc,lineNumber:1}),422)

 // A serialized spare consumes the selected units at their physical warehouse.
 const spare=randomUUID(),workshop=randomUUID()
 const revisionPost=(path:string,revision:number,payload:object,key=randomUUID())=>app.inject({
   method:"POST",url:"/api/v1/"+path,headers:{...headers,"if-match":`"${revision}"`,"idempotency-key":key},payload
 })
 const service=ok(await revisionPost("warranty-cases/"+opened.id+"/service-order",opened.revision,{diagnosis:"Aplicação de peça",report:{},scheduledAt:null,laborCents:0})).data
 await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'PC1','Peça seriada','UN',100,'active')",[spare,tenant])
 await seed.query("INSERT INTO warehouses(tenant_id,id,code,name,status,revision) VALUES($1,$2,'TEC','Assistência','active',1)",[tenant,workshop])
 await seed.query("UPDATE stock_location_settings SET enabled=true WHERE tenant_id=$1",[tenant])
 ok(await post("stock/serials/configure",{productId:spare,opening:[]}))
 ok(await post("stock/movements",{productId:spare,direction:"receipt",quantity:"2.000000",serials:["PE-01","PE-02"],warehouseId:workshop,reason:"Recebimento oficina"}),201)
 ok(await post("stock/movements",{productId:spare,direction:"receipt",quantity:"1.000000",serials:["PE-03"],reason:"Recebimento principal"}),201)
 const partsPath="warranty-service-orders/"+service.id+"/parts"
 const part={productId:spare,quantity:"1",amountCents:100}
 ok(await revisionPost(partsPath,1,part),422)
 ok(await revisionPost(partsPath,1,{...part,serialNumbers:["PE-02","PE-02"]}),422)
 ok(await revisionPost(partsPath,1,{...part,serialNumbers:["PE-09"]}),409)
 ok(await revisionPost(partsPath,1,{...part,quantity:"2",serialNumbers:["PE-02","PE-03"]}),409)
 const consumption={...part,serialNumbers:["PE-01"]},consumptionKey=randomUUID()
 const issue=ok(await revisionPost(partsPath,1,consumption,consumptionKey)).data
 assert.equal(issue.warehouseId,workshop)
 assert.equal(ok(await revisionPost(partsPath,1,consumption,consumptionKey)).data.stockMovementId,issue.stockMovementId)
 ok(await revisionPost(partsPath,2,consumption),409)
 ok(await revisionPost(partsPath,1,{...consumption,serialNumbers:["PE-02"]},consumptionKey),409)
 const reservedOrder=randomUUID()
 await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725',current_date,100,'accepted')",[reservedOrder,tenant])
 await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents,warehouse_id) VALUES($1,$2,1,$3,'PC1','Peça seriada','UN',1000000,100,100,$4)",[tenant,reservedOrder,spare,workshop])
 ok(await post("stock/serials/assign",{productId:spare,kind:"sale",direction:"issue",documentId:reservedOrder,serials:["PE-02"]}))
 await seed.query("UPDATE sales_orders SET status='confirmed' WHERE id=$1",[reservedOrder])
 ok(await revisionPost(partsPath,2,{...part,serialNumbers:["PE-02"]}),409)
 const stored=(await seed.query("SELECT warehouse_id,direction,serial_numbers,local_balance_after_micros::text FROM stock_movements WHERE tenant_id=$1 AND id=$2",[tenant,issue.stockMovementId])).rows[0]
 assert.deepEqual(stored,{warehouse_id:workshop,direction:"issue",serial_numbers:["PE-01"],local_balance_after_micros:"1000000"})
 const positions=await seed.query("SELECT warehouse_id,quantity_micros::text FROM stock_positions WHERE tenant_id=$1 AND product_id=$2",[tenant,spare])
 assert.equal(positions.rows.length,2)
 assert.ok(positions.rows.every(row=>row.quantity_micros==="1000000"))
 const serviceEvents=ok(await app.inject({url:"/api/v1/stock/serials/events?productId="+spare+"&serial=PE-01",headers})).data
 assert.deepEqual([serviceEvents[0].status,serviceEvents[0].warrantyId,serviceEvents[0].serviceOrderId],["written_off",opened.id,service.id])
 const detail=ok(await app.inject({url:"/api/v1/warranty-cases/"+opened.id,headers})).data
 assert.deepEqual([detail.parts[0].serialNumbers,detail.parts[0].warehouseName],[["PE-01"],"Assistência"])

 // Older full sales can use the same manufacturer's serial for different products.
 async function historicSale(number:number) {
   const productId=randomUUID(),orderId=randomUUID(),doc=randomUUID(),code="H"+number
   await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,$3,'Equipamento anterior','UN',100,'active')",[productId,tenant,code])
   ok(await post("stock/serials/configure",{productId,opening:[]}))
   ok(await post("stock/movements",{productId,direction:"receipt",quantity:"1.000000",serials:["FAB-1"],reason:"Recebimento original"}),201)
   await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725',current_date,100,'accepted')",[orderId,tenant])
   await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,$4,'Equipamento anterior','UN',1000000,100,100)",[tenant,orderId,productId,code])
   ok(await post("stock/serials/assign",{productId,kind:"sale",direction:"issue",documentId:orderId,serials:["FAB-1"]}))
   await seed.query("UPDATE sales_orders SET status='confirmed' WHERE id=$1",[orderId])
   await seed.query("INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents) VALUES($1,$2,'production',55,1,1,'{}',$3,100)",[tenant,doc,{sourceOrderId:orderId,items:[{code,quantity:"1.0000"}]}])
   await seed.query("INSERT INTO fiscal_nfe_documents(tenant_id,id,source_order_id,environment,model,status,series,number,issued_at,random_code,access_key,signed_xml,authorized_xml,protocol) VALUES($1,$2,$3,'production',55,'authorized',1,$4,now()::text,'11223344',$5,'<doc/>','<doc/>','autorizada')",[tenant,doc,orderId,number,String(number).padStart(44,"0")])
   const writer=await seed.connect()
   try {
     await writer.query("BEGIN")
     await writer.query("UPDATE stock_balances SET quantity_micros=0 WHERE tenant_id=$1 AND product_id=$2",[tenant,productId])
     await writer.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_order_id) VALUES($1,$2,$3,'issue',1000000,0,'Entrega integral',$4)",[randomUUID(),tenant,productId,orderId])
     await writer.query("UPDATE sales_orders SET status='completed' WHERE tenant_id=$1 AND id=$2",[tenant,orderId])
     await writer.query("COMMIT")
   } finally {writer.release()}
   return doc
 }
 const first=await historicSale(49)
 assert.equal(ok(await query("fab-1")).stockOrigins[0].documentId,first)
 await historicSale(50)
 assert.equal(ok(await query("fab-1")).stockOrigins.length,2)
 ok(await post("warranty-cases",{...claim,serialNumber:"fab-1"}),422)
 const general=ok(await post("warranty-policies",{name:"Garantia histórica",coverageType:"legal",durationDays:90,scope:{}}),201).data.id
 const selection={policyId:general,serialNumber:"fab-1",documentId:first,lineNumber:1}
 ok(await post("warranty-equipment",selection),422)
 const picked=ok(await post("warranty-equipment",{...selection,trace:{reference:"DANFE e placa conferidos no atendimento"}}),201).data
 assert.equal(picked.documentId,first)
 assert.equal(ok(await post("warranty-cases",{...claim,serialNumber:"fab-1",equipmentId:picked.id}),201).data.equipmentId,picked.id)
})
