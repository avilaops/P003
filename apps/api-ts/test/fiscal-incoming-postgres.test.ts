import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { localCommercePostgres } from "./local-commerce-postgres.js"
import type { FiscalOperations } from "../src/modules/fiscal-workspace/engine.js"

const ns="http://www.portalfiscal.inf.br/nfe",tax="04252011000110",issuer="60677380000106"
function invoice(number:number,env=2){
  const raw="352610"+issuer+"55"+"001"+String(number).padStart(9,"0")+"1"+"00000001"
  const mod=11-[...raw].reverse().reduce((v,d,i)=>v+Number(d)*(2+i%8),0)%11
  const key=raw+(mod>=10?0:mod),digest=Buffer.alloc(20,3).toString("base64")
  const xml=`<nfeProc versao="4.00" xmlns="${ns}"><NFe><infNFe Id="NFe${key}" versao="4.00"><ide><mod>55</mod><tpAmb>${env}</tpAmb><serie>1</serie><nNF>${number}</nNF><dhEmi>2026-10-18T22:30:00-03:00</dhEmi></ide><emit><CNPJ>${issuer}</CNPJ><xNome>Fornecedor</xNome></emit><dest><CNPJ>${tax}</CNPJ></dest><det nItem="1"><prod><cProd>AA</cProd><xProd>Peso</xProd><NCM>95069100</NCM><uCom>UN</uCom><qCom>2.0000</qCom><vUnCom>10.0000000000</vUnCom><vProd>20.00</vProd><vFrete>2.00</vFrete></prod></det><total><ICMSTot><vNF>22.00</vNF></ICMSTot></total></infNFe><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><Reference URI="#NFe${key}"><DigestValue>${digest}</DigestValue></Reference></SignedInfo></Signature></NFe><protNFe versao="4.00"><infProt><tpAmb>${env}</tpAmb><chNFe>${key}</chNFe><cStat>100</cStat><dhRecbto>2026-10-18T22:31:00-03:00</dhRecbto><nProt>135260000000123</nProt><digVal>${digest}</digVal></infProt></protNFe></nfeProc>`
  return {key,xml}
}
function proof(key:string,env=2,event="210210"){
  const data=`<tpAmb>${env}</tpAmb><chNFe>${key}</chNFe><tpEvento>${event}</tpEvento><nSeqEvento>1</nSeqEvento>`
  return `<procEventoNFe xmlns="${ns}"><evento><infEvento Id="ID${event}${key}01">${data}<CNPJ>${tax}</CNPJ></infEvento></evento><retEvento><infEvento>${data}<cStat>135</cStat><nProt>135260000000123</nProt></infEvento></retEvento></procEventoNFe>`
}

test("entrada fiscal TS confere XML, concilia compra e cursor, recupera manifestação sem retransmitir",{skip:!process.env.API_TS_TEST_ADMIN_URL},async()=>{
  const calls:string[]=[],one=invoice(105),two=invoice(106),prod=invoice(107,1)
  let production=false,batch:Record<string,unknown>={},eventResponse:Record<string,unknown>={}
  const engine:FiscalOperations={call:async(operation,input)=>{calls.push(operation+":"+input.environment);return operation==="distribute"?batch:eventResponse},material:async()=>({issuerTaxId:tax,certificate:{pkcs12Base64:"fixture",password:"fixture"}}),production:()=>false,productionRecipient:()=>production,nfceSecret:async()=>({})}
  await localCommercePostgres(async({app,seed,tenant,clerk,other})=>{
    const headers={authorization:"Bearer cashier","x-tenant-id":tenant}
    const req=(method:"POST"|"GET",url:string,payload?:object,rev?:number,key=randomUUID(),t=tenant)=>app.inject({method,url:"/api/v1/fiscal/"+url,headers:{...headers,"x-tenant-id":t,"idempotency-key":key,...(rev?{"if-match":'"'+rev+'"'}:{})},...(payload?{payload}:{})})
    const ok=(r:{statusCode:number;body:string;json():any},code=200)=>{assert.equal(r.statusCode,code,r.body);return r.json()}
    const importXml=(xml:string)=>req("POST","received-nfes/import",{xml})
    ok(await importXml(one.xml),403)
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])",[clerk,["fiscal.received_nfe.manage","fiscal.monitor.read","fiscal.monitor.manage","fiscal.monitor.manifest","purchasing.orders.read","purchasing.orders.manage"]])
    const first=ok(await importXml(one.xml),201)
    assert.equal(first.totalCents,2200)
    assert.equal(ok(await importXml(one.xml)).id,first.id)
    ok(await importXml(one.xml.replace("Fornecedor","Fornecedor B")),409)
    ok(await importXml(one.xml.replace(tax,"12345678000199")),403)
    ok(await importXml(one.xml.replace("100</cStat>","999</cStat>")),422)
    const detail="received-nfes/"+first.id+"/purchase",supplier=randomUUID(),product=randomUUID()
    assert.equal(ok(await req("GET",detail)).items[0].unitCostCents,1100)
    await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'juridica','Fornecedor',$3,false,true,'active')",[supplier,tenant,issuer])
    await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status,ncm) VALUES($1,$2,'AA','Peso','UN',1100,'active','95069100')",[product,tenant])
    const mapped=[{itemNumber:1,productId:product}],cmd=randomUUID(),input={supplierId:supplier,dueDate:"2027-03-01",items:mapped}
    const purchase=ok(await req("POST",detail,input,1,cmd),201)
    assert.deepEqual(ok(await req("POST",detail,input,1,cmd),201),purchase)
    assert.equal(ok(await req("GET",detail)).purchaseOrderId,purchase.purchaseOrderId)
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM purchase_receipts WHERE tenant_id=$1",[tenant])).rows[0].n,0)
    const progress=()=>req("GET",detail+"/progress")
    assert.equal(ok(await progress()).status,"draft")
    ok(await req("POST",detail+"/confirm",{},1))
    const receipt={reference:"Entrega A",occurredOn:"2026-11-18",items:[{productId:product,quantity:"0.500000"}]}
    ok(await req("POST",detail+"/receive",receipt,2),403)
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING",[clerk,["purchasing.receipts.create","inventory.stock.manage","finance.payables.originate"]])
    const receiptKey=randomUUID(),partial=ok(await req("POST",detail+"/receive",receipt,2,receiptKey),201)
    assert.equal(partial.status,"partially_received")
    assert.equal(partial.receipts[0].amount,"5.50")
    assert.ok(partial.receipts[0].payableId)
    assert.deepEqual(ok(await req("POST",detail+"/receive",receipt,2,receiptKey),201),partial)
    ok(await req("POST",detail+"/receive",receipt,3),409)
    const rest={...receipt,reference:"Entrega B",items:[{productId:product,quantity:"1.500001"}]}
    ok(await req("POST",detail+"/receive",rest,3),409)
    rest.items[0]!.quantity="1.500000"
    const done=ok(await req("POST",detail+"/receive",rest,3),201)
    assert.equal(done.status,"received")
    assert.equal(done.items[0].remaining,"0.000000")
    assert.deepEqual((await seed.query("SELECT sum(amount_cents)::int AS total,count(*)::int AS n FROM payables WHERE tenant_id=$1",[tenant])).rows[0],{total:2200,n:2})
    assert.equal((await seed.query("SELECT quantity_micros::int AS quantity FROM stock_balances WHERE tenant_id=$1 AND product_id=$2",[tenant,product])).rows[0].quantity,2_000_000)
    const second=ok(await importXml(two.xml),201)
    const existing=randomUUID()
    await seed.query("INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Fornecedor',$4,'2027-01-15',2200,'confirmed')",[existing,tenant,supplier,issuer])
    await seed.query("INSERT INTO purchase_order_lines(tenant_id,order_id,product_id,line_number,sku,name,unit,quantity_micros,cost_cents,amount_cents) VALUES($1,$2,$3,1,'AA','Peso','UN',2000000,1000,2000)",[tenant,existing,product])
    const match="received-nfes/"+second.id+"/purchase/",mapping={purchaseOrderId:existing,purchaseRevision:1,items:mapped}
    assert.deepEqual(ok(await req("GET",match+"options?limit=10")).data.map((p:{id:string})=>p.id),[existing])
    assert.equal(ok(await req("POST",match+"preview",mapping)).canConfirm,false)
    await seed.query("UPDATE purchase_order_lines SET cost_cents=1100,amount_cents=2200 WHERE tenant_id=$1 AND order_id=$2",[tenant,existing])
    assert.equal(ok(await req("POST",match+"preview",mapping)).canConfirm,true)
    ok(await req("POST",match+"match",mapping,1))
    ok(await req("GET","received-nfes",undefined,undefined,randomUUID(),other),403)
    const initial=ok(await req("GET","distribution/status"))
    assert.equal(initial.lastNsu,"000000000000000")
    const mkey=randomUUID(),mi={accessKey:one.key,kind:"ciencia",justification:null}
    const manifest=ok(await req("POST","manifestations",mi,1,mkey))
    assert.equal(manifest.status,"unknown")
    ok(await req("POST","manifestations",mi,1,mkey))
    ok(await req("POST","manifestations",mi,1),409)
    const n="000000000000001",key=randomUUID()
    batch={code:"138",lastNsu:n,maxNsu:n,documents:[{nsu:n,kind:"event",schema:"procEventoNFe_v1.00.xsd",xml:proof(one.key)}]}
    const cycle=ok(await req("POST","distribution/query",{},1,key))
    assert.equal(cycle.status,"completed")
    assert.equal(cycle.lastNsu,n)
    assert.deepEqual(ok(await req("POST","distribution/query",{},1,key)),cycle)
    ok(await req("POST","distribution/query",{},cycle.revision),409)
    assert.equal(ok(await req("GET","manifestations/"+manifest.id)).status,"accepted")
    const reconciled=ok(await req("POST","manifestations/"+manifest.id+"/reconcile",{},3))
    assert.equal(reconciled.status,"accepted")
    assert.equal(ok(await req("GET","distribution/documents/"+n)).accessKey,one.key)
    assert.equal(calls.filter(x=>x==="manifest:homologation").length,1)
    ok(await req("POST","monitor/sync",{}),503)
    production=true
    ok(await req("POST","monitor/sync",{}),409)
    await seed.query("INSERT INTO company_profiles(tenant_id,revision,details) VALUES($1,1,$2) ON CONFLICT (tenant_id) DO UPDATE SET details=EXCLUDED.details",[tenant,{state:"SP"}])
    batch={code:"138",lastNsu:n,maxNsu:n,documents:[{nsu:n,kind:"full",schema:"procNFe_v4.00.xsd",xml:prod.xml}]}
    const run=ok(await req("POST","monitor/sync",{}),202)
    assert.equal(run.outcome,"applied")
    const monitor=ok(await req("GET","monitor"))
    assert.equal(monitor.documents[0].accessKey,prod.key)
    const doc="monitor/documents/"+monitor.documents[0].id
    assert.equal((await req("GET",doc+"/xml")).body,prod.xml)
    eventResponse={registered:true,protocol:"135260000000123",code:"135",xml:proof(prod.key,1,"210200"),rawXml:"fixture processed"}
    const productionKey=randomUUID()
    assert.equal(ok(await req("POST",doc+"/manifest",{eventType:"210200"},undefined,productionKey),202).outcome,"accepted")
    ok(await req("POST",doc+"/manifest",{eventType:"210200"},undefined,productionKey),202)
    ok(await req("POST",doc+"/manifest",{eventType:"210210"}),409)
    assert.equal(calls.filter(x=>x==="manifest:production").length,1)
    const next="000000000000002",third="000000000000003"
    const foreign=invoice(108,1).xml.replace(tax,"19131243000197")
    await seed.query("UPDATE fiscal_monitor_state SET next_query_at=now() WHERE tenant_id=$1",[tenant])
    batch={code:"138",lastNsu:third,maxNsu:third,documents:[{nsu:next,schema:"procNFe_v4.00.xsd",kind:"full",xml:foreign},{nsu:third,schema:"outro_xsd",kind:"summary",xml:"<outro/>"}]}
    assert.equal(ok(await req("POST","monitor/sync",{}),202).outcome,"applied")
    const archived=ok(await req("GET","monitor")).documents.filter((d:{kind:string})=>d.kind==="other")
    assert.equal(archived.length,2)
    assert.ok(archived.every((d:{receivedNfeId:unknown})=>d.receivedNfeId==null))
  },{fiscalOperations:engine})
})
