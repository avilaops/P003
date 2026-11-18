import assert from "node:assert/strict"
import { createHash,randomUUID } from "node:crypto"
import type { Pool } from "pg"
import type { FastifyInstance } from "fastify"
import type { FiscalOperations } from "../src/modules/fiscal-workspace/engine.js"
import {checkDigit} from "../src/modules/fiscal-workspace/emission.js"

const ns="http://www.portalfiscal.inf.br/nfe", issuer="04252011000110",protocol="135260000000012"
const digest="RXZpZGVuY2lhIHNpbnRldGljYQ=="
export function syntheticEmission() {
  const calls:string[]=[]
  let allowProduction=false
  let lost=true,eventLost=true,cancelLost=true,claimedCancellation=false
  let historical:Record<string,unknown>|undefined
  const operations:FiscalOperations={
    production:()=>allowProduction,material:async()=>({issuerTaxId:issuer,certificate:{pkcs12Base64:"Zml4dHVyZQ==",password:"synthetic"}}),
    nfceSecret:async()=>({version:"2",csc:{id:"01",secret:"synthetic"}}),
    call:async(operation,v)=>{
      calls.push(operation)
      const ambient=v.environment==="production"?"1":"2"
      if(operation==="offline-receipt"){
        const pdf=Buffer.from("%PDF-1.7\ncontingência sintética\n%%EOF")
        const hash=(b:string|Buffer)=>createHash("sha256").update(b).digest("hex")
        return {pdf:pdf.toString("base64"),pdfHash:hash(pdf),xmlHash:hash(String(v.signedXml))}
      }
      if(operation==="verify-a1"){const now=Math.floor(Date.now()/1000);return {taxId:issuer,subject:"Synthetic",issuer:"Synthetic CA",serialNumber:"01",fingerprint:"ab".repeat(32),validFrom:now-3600,validUntil:now+24*3600,validatedAt:now,chainVerified:true,revocationChecked:false}}
      if(operation==="prepare"){
        const model=(v.draft as {model:number}).model,series=(v.issuer as {profile:{series:number}}).profile.series
        const prefix="352611"+issuer+model+String(series).padStart(3,"0")+String(v.number).padStart(9,"0")+((v.draft as {emissionType?:string}).emissionType??"1")+v.randomCode
        const key=prefix+checkDigit(prefix)
        const draft=v.draft as {recipient:{taxId:string};productsTotal:string;purpose?:number;referencedAccessKeys?:string[];items:{code:string;quantity:string;unit:string;unitPrice:string;cfop:string}[]}
        const taxpayer=draft.recipient.taxId.length===11?"CPF":"CNPJ"
        const products=draft.items.map(i=>'<det><prod><cProd>'+i.code+'</cProd><CFOP>'+i.cfop+'</CFOP><uCom>'+i.unit+'</uCom><qCom>'+i.quantity+'</qCom><vUnCom>'+i.unitPrice+'</vUnCom></prod></det>').join("")
        const signedXml='<NFe xmlns="'+ns+'"><infNFe Id="NFe'+key+'"><ide><tpAmb>'+ambient+'</tpAmb><mod>'+model+'</mod><serie>'+series+'</serie><nNF>'+v.number+'</nNF><cNF>'+v.randomCode+'</cNF><dhEmi>'+v.issuedAt+'</dhEmi><tpNF>'+(draft.purpose===4?'0':'1')+'</tpNF><finNFe>'+(draft.purpose??1)+'</finNFe>'+(draft.referencedAccessKeys??[]).map(k=>'<NFref><refNFe>'+k+'</refNFe></NFref>').join("")+'</ide><emit><CNPJ>'+issuer+'</CNPJ><xNome>Empresa teste</xNome></emit><dest><'+taxpayer+'>'+draft.recipient.taxId+'</'+taxpayer+'><xNome>Consumidor</xNome></dest>'+products+'<total><ICMSTot><vNF>'+draft.productsTotal+'</vNF></ICMSTot></total></infNFe><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo><Reference URI="#NFe'+key+'"><DigestValue>'+digest+'</DigestValue></Reference></SignedInfo></Signature></NFe>'
        return {signedXml,accessKey:key,...(model===65?{qrCode:"fixture QR"}:{})}
      }
      if(operation==="event"){
        const common='<chNFe>'+v.accessKey+'</chNFe><tpAmb>2</tpAmb><tpEvento>'+(v.kind==="cancelamento"?"110111":"110110")+'</tpEvento><nSeqEvento>'+v.sequence+'</nSeqEvento>'
        const detail=v.kind==="cancelamento" ? '<nProt>'+v.protocol+'</nProt><xJust>'+v.text+'</xJust>' : '<xCorrecao>'+v.text+'</xCorrecao>'
        const xml='<procEventoNFe xmlns="'+ns+'"><evento><infEvento>'+common+'<detEvento>'+detail+'</detEvento></infEvento></evento><retEvento><infEvento>'+common+'<cStat>135</cStat><nProt>'+protocol+'</nProt></infEvento></retEvento></procEventoNFe>'
        historical={registered:true,code:"135",protocol,xml,kind:v.kind,sequence:v.sequence,text:v.text}
        if(eventLost){eventLost=false;throw new Error("transporte sintético interrompido")}
        if(v.kind==="cancelamento" && cancelLost){cancelLost=false;throw new Error("recibo de cancelamento perdido")}
        return historical
      }
      if(operation==="authorize" && lost){lost=false;throw new Error("resposta da autorização perdida")}
      const confirmedCancel=historical?.kind==="cancelamento" && String(historical.xml).includes(String(v.accessKey))
      const unproven=operation==="consult" && historical?.kind==="correcao" && !claimedCancellation && calls.filter(x=>x==="consult").length===3
      if(unproven)claimedCancellation=true
      return {status:confirmedCancel || unproven?"cancelled":"authorized",code:confirmedCancel || unproven?"101":"100",protocol,xml:'<nfeProc xmlns="'+ns+'">'+v.signedXml+'<protNFe><infProt><tpAmb>'+ambient+'</tpAmb><chNFe>'+v.accessKey+'</chNFe><nProt>'+protocol+'</nProt><digVal>'+digest+'</digVal><cStat>100</cStat></infProt></protNFe></nfeProc>',events:historical?[historical]:[]}
    },
  }
  return {operations,calls,enableSyntheticProduction:()=>{allowProduction=true}}
}

export async function verifyFiscalEmission(seed:Pool,app:FastifyInstance,tenant:string,role:string,calls:string[]) {
  const base="/api/v1/fiscal/nfe",headers={authorization:"Bearer reader","x-tenant-id":tenant}
  const create=(payload:object,key=randomUUID())=>app.inject({method:"POST",url:base,headers:{...headers,"idempotency-key":key},payload})
  const command=(url:string,revision:number,payload:object={},key=randomUUID())=>app.inject({method:"POST",url,headers:{...headers,"if-match":'"'+revision+'"',"idempotency-key":key},payload})
  const raw={environment:"homologation",model:55,operationNature:"VENDA",taxRuleReference:"Regra sintética",productsTotal:"1.00",
    recipient:{legalName:"Cliente",taxId:"19131243000197",state:"SP",street:"Rua de Teste",municipalityCode:"3550308",postalCode:"01001000",number:"1",district:"Centro"},
    items:[{code:"A",description:"Produto sintético",cfop:"5102",ncm:"12345678",origin:0,csosn:"102",pisCst:"49",cofinsCst:"49",quantity:"1.0000",unitPrice:"1.0000000000",grossTotal:"1.00",unit:"UN"}]}
  await seed.query("INSERT INTO company_profiles(tenant_id,revision,details) VALUES($1,1,$2)",[tenant,{personType:"juridica",state:"SP",stateRegistration:"123",taxRegime:"simples"}])
  await seed.query("INSERT INTO fiscal_profiles(tenant_id,revision,environment,details) VALUES($1,1,'homologation',$2)",[tenant,{environment:"homologation",state:"SP",stateRegistration:"123",crt:1,series:7,nextNumber:1}])
  const key=randomUUID(),draft=await create(raw,key)
  assert.equal(draft.statusCode,201,draft.body)
  const id=draft.json().data.id, url=base+"/"+id+"/"
  assert.equal((await create(raw,key)).json().data.id,id)
  assert.equal((await command(url+"issue",1)).statusCode,403)
  for(const perm of ["fiscal.nfe.issue","fiscal.nfe.cancel","fiscal.nfe.correction"])await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)",[role,perm])
  const issueKey=randomUUID(),lost=await command(url+"issue",1,{},issueKey)
  assert.equal(lost.statusCode,200,lost.body);assert.equal(lost.json().status,"unknown",lost.body)
  const recovered=await command(url+"issue",1,{},issueKey);assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().status,"authorized",recovered.body)
  assert.deepEqual(calls,["prepare","authorize","consult"])
  const replay=await command(url+"issue",1,{},issueKey);assert.equal(replay.json().revision,recovered.json().revision)
  const xml=await app.inject({url:url+"xml",headers});assert.ok(xml.body.includes("<nProt>"+protocol+"</nProt>"))
  const correction={text:"Conferência sintética de descrição"},eventKey=randomUUID()
  const uncertain=await command(url+"correction",recovered.json().revision,correction,eventKey)
  assert.equal(uncertain.statusCode,202,uncertain.body)
  const afterLost=await app.inject({url:url+"emission",headers})
  const reconciled=await command(url+"correction",afterLost.json().revision,correction,randomUUID())
  assert.equal(reconciled.json().status,"registered",reconciled.body)
  assert.deepEqual(calls.slice(3),["event","consult"])
  const current=await app.inject({url:url+"emission",headers})
  const unproven=await command(url+"consult",current.json().revision)
  assert.equal(unproven.json().status,"authorized",unproven.body)
  assert.equal(unproven.json().result.code,"cancellation_unconfirmed",unproven.body)
  const cancellation={text:"Cancelamento sintético autorizado"}
  const sale=randomUUID(),sourceId=randomUUID()
  await seed.query(`INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status)
    SELECT $1,$2,p.id,p.legal_name,p.tax_id,current_date,100,'draft' FROM parties p WHERE p.tenant_id=$2 AND p.id=$2`,[sale,tenant])
  await seed.query("UPDATE fiscal_nfe_documents SET source_order_id=$3 WHERE tenant_id=$1 AND id=$2",[tenant,id,sale])
  await seed.query("INSERT INTO sales_order_cancellations(id,tenant_id,order_id,reason,occurred_on,order_revision,summary) VALUES($1,$2,$3,$4,current_date,2,'{}')",[sourceId,tenant,sale,cancellation.text])
  const linked="/api/v1/fiscal/order-cancellations/"+sourceId+"/process"
  const linkInfo=await app.inject({url:linked,headers})
  assert.equal(linkInfo.json().documentId,id,linkInfo.body)
  const lostCancel=await command(linked,linkInfo.json().revision)
  assert.equal(lostCancel.statusCode,202,lostCancel.body)
  assert.equal((await app.inject({url:linked,headers})).json().pending,true)
  const pending=await app.inject({url:url+"emission",headers})
  const confirmed=await command(url+"consult",pending.json().revision)
  assert.equal(confirmed.json().status,"cancelled",confirmed.body)
  const cancelled=await command(linked,confirmed.json().revision)
  assert.equal(cancelled.json().request.sourceCancellationId,sourceId,cancelled.body)
  assert.equal(cancelled.json().status,"registered",cancelled.body)
  assert.equal((await app.inject({url:url+"emission",headers})).json().status,"cancelled")
  assert.equal((await app.inject({url:url+"events",headers})).json().data.length,2)
  const history=await app.inject({url:"/api/v1/fiscal/nfe-events?kind=correcao&limit=1",headers})
  assert.equal(history.json().data[0].id,reconciled.json().id,history.body)
  assert.equal(history.json().nextCursor,null)
  for(const path of ["nfe","issued-nfes"]){
    const page=await app.inject({url:"/api/v1/fiscal/"+path+"?limit=1",headers})
    assert.equal(page.statusCode,200,page.body);assert.equal(page.json().data.length,1)
    assert.equal(typeof page.json().data[0].revision,"number")
    const following=await app.inject({url:"/api/v1/fiscal/"+path+"?limit=1&cursor="+page.json().data[0].id,headers})
    assert.notEqual(following.json().data[0]?.id,page.json().data[0].id)
  }
  const numbers={year:2026,series:1,first:1,last:1,text:"Lacuna sintética da numeração"}
  const voids=()=>command("/api/v1/fiscal/number-voids",0,numbers)
  assert.equal((await voids()).statusCode,403)
  await seed.query("INSERT INTO role_permissions VALUES($1,'fiscal.nfe.void')",[role])
  assert.equal((await voids()).statusCode,409)
  const consumer=await create({...raw,model:65});assert.equal(consumer.statusCode,201,consumer.body)
  const h65=base+"/"+consumer.json().data.id+"/", issued=await command(h65+"issue",1)
  assert.equal(issued.json().status,"authorized",issued.body)
  assert.equal(issued.json().number,1);assert.equal(issued.json().model,65)
  assert.equal((await command(h65+"correction",issued.json().revision,correction)).statusCode,409)
  assert.equal((await app.inject({url:h65+"danfe",headers})).statusCode,409)
  const offline=await create({...raw,model:65,emissionType:"9"})
  const offPath=base+"/"+offline.json().data.id+"/",index=calls.length
  const offlineReady=await command(offPath+"issue",1)
  assert.equal(offlineReady.json().status,"prepared",offlineReady.body)
  const cupom=await app.inject({url:offPath+"danfe",headers})
  assert.equal(cupom.statusCode,200,cupom.body);assert.equal(cupom.headers["x-nfe-authorization-check"],"pending")
  assert.equal((await app.inject({url:offPath+"xml",headers})).statusCode,200)
  assert.deepEqual(calls.slice(index),["prepare","offline-receipt"])
  assert.equal((await command(offPath+"issue",offlineReady.json().revision)).json().status,"authorized")
  const prod=await create({...raw,environment:"production"})
  assert.equal(prod.statusCode,201,prod.body)
  const before=calls.length
  assert.equal((await command(base+"/"+prod.json().data.id+"/issue",1)).statusCode,409);assert.equal(calls.length,before)
}
