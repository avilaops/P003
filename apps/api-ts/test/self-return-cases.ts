import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import type {FastifyInstance} from "fastify"
import type {Pool} from "pg"
import {checkDigit} from "../src/modules/fiscal-workspace/emission.js"

export async function verifyOwnReturn(app:FastifyInstance,seed:Pool,tenant:string){
  const customer=randomUUID(),product=randomUUID(),tax="52998224725",headers={authorization:"Bearer reader","x-tenant-id":tenant}
  await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Pessoa consumidora',$3,true,false,'active')",[customer,tenant,tax])
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'V5-CPF','Equipamento','UN',100,'active')",[product,tenant])
  await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,0)",[tenant,product])
  await seed.query("UPDATE sales_return_policies SET window_days=5,approval_above_cents=50 WHERE tenant_id=$1",[tenant])
  const recipient={taxId:tax,legalName:"Pessoa consumidora",state:"SP",municipalityCode:"3550308",postalCode:"01001000",street:"Rua de Teste",number:"12",district:"Centro"}
  const item={code:"V5-CPF",description:"Equipamento",unit:"UN",quantity:"4.0000",unitPrice:"1.0000000000",grossTotal:"4.00",cfop:"5102",ncm:"95069100",origin:0,csosn:"102",pisCst:"07",cofinsCst:"07"}
  for(const env of ["homologation","production"] as const){
    const order=randomUUID(),original=randomUUID(),lot=randomUUID(),bill=randomUUID()
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Pessoa consumidora',$4,current_date,400,'draft')",[order,tenant,customer,tax])
    await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'V5-CPF','Equipamento','UN',4000000,100,400)",[tenant,order,product])
    const units=["CPF-1","CPF-2","CPF-3","CPF-4"]
    if(env==="production"){
      await seed.query("UPDATE stock_balances SET quantity_micros=4000000 WHERE tenant_id=$1 AND product_id=$2",[tenant,product])
      await seed.query("INSERT INTO stock_serial_products(tenant_id,product_id) VALUES($1,$2)",[tenant,product])
      await seed.query("INSERT INTO stock_serials(tenant_id,product_id,warehouse_id,serial,status) SELECT $1,$2,s.opening_id,u,'available' FROM stock_location_settings s CROSS JOIN unnest($3::text[]) u WHERE s.tenant_id=$1",[tenant,product,units])
      await seed.query("INSERT INTO stock_serial_assignments(tenant_id,product_id,document_id,kind,direction,serials) VALUES($1,$2,$3,'sale','issue',$4)",[tenant,product,order,units])
    }
    await seed.query("UPDATE sales_orders SET status='confirmed' WHERE tenant_id=$1 AND id=$2",[tenant,order])
    await seed.query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Pessoa consumidora',current_date,400,'open')",[bill,tenant,order])
    const draft={model:55,environment:env,operationNature:"Venda",taxRuleReference:"Roteiro fiscal",finalConsumer:true,recipient,items:[item],productsTotal:"4.00",payments:[{code:"01",amount:"4.00"}]}
    await seed.query("INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents) VALUES($1,$2,$3,55,1,1,'{}',$4,400)",[tenant,original,env,draft])
    const prefix="3526110425201100011055008000000111100000010",key=prefix+checkDigit(prefix)
    await seed.query(`INSERT INTO fiscal_nfe_documents(tenant_id,id,environment,model,status,series,number,issued_at,random_code,access_key,signed_xml,authorized_xml,protocol)
      VALUES($1,$2,$3,55,'authorized',8,111,now()::text,'00000010',$4,'<xml/>','<xml/>','135260000000000')`,[tenant,original,env,key])
    await seed.query("INSERT INTO sales_invoice_lots(tenant_id,id,order_id,environment,draft_id,delivered_at) VALUES($1,$2,$3,$4,$5,NULL)",[tenant,lot,order,env,original])
    await seed.query("INSERT INTO sales_invoice_lot_items VALUES($1,$2,$3,1,4000000)",[tenant,lot,order])
    const path="/api/v1/fiscal/order-lots/"+order,state=async()=>(await app.inject({url:path+"?environment="+env,headers})).json()
    const post=async(body:object,actor="reader")=>{
      const s=await state()
      return app.inject({method:"POST",url:path,headers:{...headers,authorization:"Bearer "+actor,"if-match":'"'+s.revision+'"',"idempotency-key":randomUUID()},payload:{environment:env,...body}})
    }
    const base={action:"prepareOwnReturn",lotId:lot,consumerDeclaration:true,destination:"stock",taxRuleReference:"Instrução fiscal de devolução",reason:"Produto devolvido pelo consumidor"}
    if(env==="production"){
      const delivered=await post({action:"deliver",lotId:lot});assert.equal(delivered.statusCode,200,delivered.body)
      const missing=await post({...base,items:[{lineNumber:1,quantityMicros:"2000000",cfop:"1202"}]})
      assert.equal(missing.statusCode,409,missing.body)
      assert.equal((await post({...base,serials:[{lineNumber:1,serials:["CPF-2","SEM-VENDA"]}],items:[{lineNumber:1,quantityMicros:"2000000",cfop:"1202"}]})).statusCode,409)
    }
    assert.equal((await post({...base,items:[{lineNumber:1,quantityMicros:"5000000",cfop:"1202"}]})).statusCode,409)
    const prepared=await post({...base,...(env==="production"?{serials:[{lineNumber:1,serials:units.slice(0,2)}]}:{}),items:[{lineNumber:1,quantityMicros:"2000000",cfop:"1202"}]})
    assert.equal(prepared.statusCode,200,prepared.body)
    assert.equal(prepared.json().status,"pending")
    const planId=prepared.json().id,note="/api/v1/fiscal/nfe/"+planId
    const snapshot=await app.inject({url:note,headers})
    assert.equal(snapshot.json().data.input.purpose,4);assert.equal(snapshot.json().data.input.returnDirection,"incoming")
    assert.deepEqual(snapshot.json().data.input.referencedAccessKeys,[key])
    const issue=()=>app.inject({url:note+"/issue",method:"POST",headers:{...headers,"if-match":'"1"',"idempotency-key":randomUUID()},payload:{}})
    assert.equal((await issue()).statusCode,409)
    const decision={action:"decideOwnReturn",planId,approve:true,reason:"Origem e quantidades conferidas"}
    assert.equal((await post(decision)).statusCode,409)
    const approved=await post(decision,"reviewer");assert.equal(approved.statusCode,200,approved.body)
    const changed=await app.inject({url:note,method:"PUT",headers:{...headers,"if-match":'"1"'},payload:{...snapshot.json().data.input,referencedAccessKeys:["2".repeat(44)]}})
    assert.equal(changed.statusCode,409,changed.body)
    const cancelOrigin=await app.inject({url:"/api/v1/fiscal/nfe/"+original+"/cancel",method:"POST",headers:{...headers,"if-match":'"1"',"idempotency-key":randomUUID()},payload:{text:"Cancelamento com devolução em aberto"}})
    assert.equal(cancelOrigin.statusCode,409,cancelOrigin.body)
    await seed.query("UPDATE fiscal_nfe_documents SET status='cancelled' WHERE tenant_id=$1 AND id=$2",[tenant,original])
    assert.equal((await issue()).statusCode,409)
    await seed.query("UPDATE fiscal_nfe_documents SET status='authorized' WHERE tenant_id=$1 AND id=$2",[tenant,original])
    const issued=await issue();assert.equal(issued.json().status,"authorized",issued.body)
    const pendingEvent=randomUUID()
    await seed.query("INSERT INTO fiscal_nfe_events(tenant_id,id,document_id,kind,sequence,request,status) VALUES($1,$2,$3,'cancelamento',1,'{}','unknown')",[tenant,pendingEvent,planId])
    assert.equal((await post({action:"completeOwnReturn",planId})).statusCode,409)
    await seed.query("UPDATE fiscal_nfe_events SET status='rejected' WHERE tenant_id=$1 AND id=$2",[tenant,pendingEvent])
    const completed=await post({action:"completeOwnReturn",planId});assert.equal(completed.statusCode,200,completed.body)
    assert.equal(completed.json().status,env==="production"?"applied":"simulated")
    assert.equal((await post({action:"completeOwnReturn",planId})).statusCode,409)
    const saved=(await state()).ownReturns[0]
    const purchased=await app.inject({url:"/api/v1/fiscal/received-nfes/"+saved.receivedId+"/purchase",headers})
    assert.equal(purchased.statusCode,409,purchased.body)
    const entry=await app.inject({url:"/api/v1/fiscal/received-nfes/"+saved.receivedId,headers})
    assert.equal(entry.json().data.issuerDocument,"04252011000110");assert.equal(entry.json().data.recipientDocument,tax)
    const xml=await app.inject({url:note+"/xml",headers});assert.ok(xml.body.includes("<tpNF>0</tpNF>"));assert.ok(xml.body.includes("<finNFe>4</finNFe>"));assert.ok(xml.body.includes("<refNFe>"+key+"</refNFe>"))
    const listing=await app.inject({url:"/api/v1/fiscal/sales-returns?environment="+env+"&q=Pessoa",headers})
    assert.equal(listing.json().data.find((r:{id:string})=>r.id===planId).status,completed.json().status,listing.body)
    const stock=(await seed.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2",[tenant,product])).rows[0].quantity_micros
    const title=(await seed.query("SELECT amount_cents FROM receivables WHERE tenant_id=$1 AND id=$2",[tenant,bill])).rows[0].amount_cents
    assert.deepEqual([stock,title],env==="production"?["2000000","200"]:["0","400"])
    if(env==="production"){
      const restored=await seed.query("SELECT serial FROM stock_serial_events WHERE tenant_id=$1 AND product_id=$2 AND status='available' AND sales_partial_return_id IS NOT NULL ORDER BY serial",[tenant,product])
      assert.deepEqual(restored.rows.map(r=>r.serial),units.slice(0,2))
    }else await seed.query("UPDATE sales_orders SET status='cancelled' WHERE tenant_id=$1 AND id=$2",[tenant,order])
  }
}
