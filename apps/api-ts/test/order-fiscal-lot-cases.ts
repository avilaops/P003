import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"
import { sha256 } from "../src/modules/nfe-email/danfe.js"

export async function verifyOrderFiscalLots(seed:Pool,app:FastifyInstance,company:string,role:string,reader:string,identity:string) {
  const order=randomUUID(),product=randomUUID(),title=randomUUID(),staff=randomUUID(),payment=randomUUID()
  const taxId="19131243000197"
  const headers={authorization:"Bearer reader","x-tenant-id":company}, path="/api/v1/fiscal/order-lots/"+order
  const state=async()=>{
    const result=await app.inject({url:path+"?environment=production",headers})
    assert.equal(result.statusCode,200,result.body)
    return result.json()
  }
  let rev=1
  const command=(payload:object,revision=rev,key=randomUUID())=>app.inject({method:"POST",url:path,headers:{...headers,"if-match":'"'+revision+'"',"idempotency-key":key},payload:{...payload,environment:"production"}})
  async function ok(payload:object) {
    const r=await command(payload)
    assert.equal(r.statusCode,200,r.body)
    rev=r.json().revision
    return r.json().id as string
  }
  const prepare=(q:number)=>({action:"prepare",items:[{lineNumber:1,quantityMicros:String(q*1000000)}]})
  await seed.query(`GRANT INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${role}; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`)
  await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'juridica','Cliente',$2,true,false,'active')",[company,taxId])
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'LOT-1','Equipamento','UN',100,'active')",[product,company])
  await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,10000000)",[company,product])
  await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente',$3,CURRENT_DATE,1000,'draft')",[order,company,taxId])
  await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'LOT-1','Equipamento','UN',10000000,100,1000)",[company,order,product])
  await seed.query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente',CURRENT_DATE,1000,'open')",[title,company,order])

  await seed.query("INSERT INTO staff(id,tenant_id,code,name,is_employee,is_seller,status) VALUES($1,$2,'LOT','Vendedor',false,true,'active')",[staff,company])
  await seed.query("INSERT INTO commission_accounts(tenant_id,seller_staff_id) VALUES($1,$2)",[company,staff])
  await seed.query("INSERT INTO order_commission_terms(tenant_id,order_id,seller_staff_id,seller_name,commission_rate,ipi_rate,payment_day) VALUES($1,$2,$3,'Vendedor',100000,0,10)",[company,order,staff])
  await seed.query("UPDATE sales_orders SET status='confirmed' WHERE tenant_id=$1 AND id=$2",[company,order])
  await seed.query("INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on) VALUES($1,$2,$3,'receipt',900,'cash','Pagamento parcial',CURRENT_DATE)",[payment,company,title])
  await seed.query(`INSERT INTO commission_entries(id,tenant_id,seller_staff_id,seller_name,order_id,kind,receipt_id,competence,payment_due,base_cents,commission_rate,ipi_rate,payment_day,amount_cents,reason)
    VALUES($1,$2,$3,'Vendedor',$4,'receipt',$5,'2026-11-01',CURRENT_DATE,900,100000,0,10,90,'Recebimento')`,[randomUUID(),company,staff,order,payment])
  assert.equal((await command(prepare(1))).statusCode,403)
  for(const permission of ["sales.orders.read","sales.orders.manage","fiscal.nfe.manage","inventory.stock.manage","finance.receivables.manage","finance.commissions.manage","fiscal.received_nfe.manage"]) {
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)",[reader,permission])
  }
  async function authorize(lot:string,q:number,n:number) {
    const draft=randomUUID(),key=String(n).padStart(44,"1")
    const details={recipient:{taxId},purpose:1,items:[{code:"LOT-1",unit:"UN",quantity:String(q),unitPrice:"1.00"}]}
    await seed.query("INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents) VALUES($1,$2,'production',55,1,1,'{}',$3,$4)",[company,draft,details,q*100])
    await seed.query("INSERT INTO domain_commands(tenant_id,auth_subject,command_key,scope,request,result) VALUES($1,'reader',$2,'fiscal.nfe.draft.create',$3,$4)",[company,lot,details,{data:{id:draft}}])
    assert.equal((await state()).lots.find((l:{id:string})=>l.id===lot).draftId,draft)
    await seed.query(`INSERT INTO fiscal_nfe_documents(tenant_id,id,model,environment,status,series,number,issued_at,random_code,access_key,signed_xml,authorized_xml,protocol)
      VALUES($1,$2,55,'production','authorized',1,$3,'2026-11-18T10:00:00-03:00','10000001',$4,'<xml/>','<xml/>','135260000000000')`,[company,draft,n,key])
    return {draft,key}
  }
  const first=await ok(prepare(4)), second=await ok(prepare(6))
  assert.equal((await command(prepare(1))).statusCode,409)
  assert.equal((await state()).lines[0].available,"0")
  const firstNote=await authorize(first,4,1),oldSecond=await authorize(second,6,2)
  assert.equal((await state()).lines[0].billed,"10000000")
  await seed.query("UPDATE fiscal_nfe_documents SET status='cancelled' WHERE tenant_id=$1 AND id=$2",[company,oldSecond.draft])
  assert.equal((await state()).lines[0].available,"6000000")
  const replaced=await ok(prepare(6))
  const replacementNote=await authorize(replaced,6,3)
  await ok({action:"deliver",lotId:first})
  assert.equal((await command({action:"deliver",lotId:first})).statusCode,409)
  assert.equal((await state()).lines[0].delivered,"4000000")
  await ok({action:"deliver",lotId:replaced})
  assert.equal((await seed.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2",[company,product])).rows[0].quantity_micros,"0")
  async function incoming(q:number,n:number) {
    const xml='<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe><ide><mod>55</mod><tpNF>1</tpNF><finNFe>4</finNFe><NFref><refNFe>'+firstNote.key+'</refNFe></NFref></ide><dest><CNPJ>04252011000110</CNPJ></dest><det><prod><cProd>LOT-1</cProd><uCom>UN</uCom><qCom>'+q+'</qCom><vUnCom>1.00</vUnCom></prod></det></infNFe></NFe></nfeProc>'
    return String((await seed.query(`INSERT INTO fiscal_received_nfes(tenant_id,access_key,issuer_document,issuer_name,recipient_document,number,series,issued_at,total_cents,item_count,environment,xml,xml_sha256,imported_by_identity_id)
      VALUES($1,$2,$3,'Cliente','04252011000110',$4,1,now(),$5,1,1,$6,$7,$8) RETURNING id`,[company,String(n).padStart(44,"2"),taxId,n,q*100,xml,sha256(xml),identity])).rows[0].id)
  }
  const incomingId=await incoming(2,3), req={action:"return",lotId:first,receivedId:incomingId,destination:"stock",reason:"Retorno parcial"}
  const key=randomUUID(), initial=rev
  const accepted=await command(req,initial,key)
  assert.equal(accepted.statusCode,200,accepted.body);rev=accepted.json().revision
  assert.deepEqual((await command(req,initial,key)).json(),accepted.json())
  assert.equal((await command(req)).statusCode,409)
  assert.equal((await command({...req,receivedId:await incoming(3,4)})).statusCode,409)
  const final=await state()
  assert.equal(final.lines[0].returned,"2000000")
  assert.deepEqual([final.returns[0].creditedCents,final.returns[0].abatedCents,final.returns[0].commissionReversedCents],["100","100","10"])
  assert.equal((await seed.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2",[company,product])).rows[0].quantity_micros,"2000000")
  const bill=(await seed.query("SELECT id,status,amount_cents FROM receivables WHERE tenant_id=$1 AND order_id=$2",[company,order])).rows
  assert.deepEqual(bill,[{id:title,status:"paid",amount_cents:"900"}])
  const futureOrder=randomUUID(),futureBill=randomUUID(),returnId=accepted.json().id
  await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente',$3,current_date,250,'draft')",[futureOrder,company,taxId])
  await seed.query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente',current_date,250,'open')",[futureBill,company,futureOrder])
  const options=await app.inject({url:path+"?environment=production&creditOffset=0",headers})
  assert.equal(options.json().data.find((r:{id:string})=>r.id===futureBill).openCents,"250",options.body)
  const application={action:"applyCredit",returnId,receivableId:futureBill,amountCents:"60"}
  const applicationKey=randomUUID(),applicationRev=rev
  const applied=await command(application,applicationRev,applicationKey)
  assert.equal(applied.statusCode,200,applied.body);rev=applied.json().revision
  assert.deepEqual((await command(application,applicationRev,applicationKey)).json(),applied.json())
  assert.equal((await command(application)).statusCode,409)
  assert.equal((await state()).returns[0].remainingCreditCents,"40")
  assert.equal((await seed.query("SELECT amount_cents FROM receivables WHERE tenant_id=$1 AND id=$2",[company,futureBill])).rows[0].amount_cents,"190")
  await seed.query("INSERT INTO role_permissions VALUES($1,'finance.receivables.read') ON CONFLICT DO NOTHING",[reader])
  const finance=async(id:string)=>(await app.inject({url:"/api/v1/orders/"+id+"/finance",headers})).json()
  for(const [id,expected] of [[order,["10.00","9.00","9.00","1.00","0.00","settled_with_credit"]],[futureOrder,["2.50","1.90","0.00","0.60","1.90","partial"]]] as const){
    const f=await finance(id)
    assert.deepEqual([f.orderAmount,f.titleAmount,f.receivedAmount,f.abatedAmount,f.outstandingAmount,f.state],expected)
    assert.equal(f.receivables[0].data.abatedAmount,f.abatedAmount);assert.equal(f.receivables[0].data.outstandingAmount,f.outstandingAmount)
  }
  const url="/api/v1/fiscal/return-policy"
  const policy=(days:number,limit:string,revision:number)=>app.inject({method:"PUT",url,headers:{...headers,"if-match":'"'+revision+'"',"idempotency-key":randomUUID()},payload:{windowDays:days,approvalAboveCents:limit}})
  assert.equal((await policy(1,"50",1)).statusCode,403)
  await seed.query("INSERT INTO role_permissions VALUES($1,'sales.approvals.director')",[reader])
  const configured=await policy(1,"50",1);assert.equal(configured.statusCode,200,configured.body)
  assert.equal((await policy(1,"50",1)).statusCode,412)
  const secondId=await incoming(1,7)
  await seed.query("UPDATE sales_invoice_lots SET delivered_at=now()-interval '2 days' WHERE tenant_id=$1 AND id=$2",[company,first])
  assert.equal((await command({...req,receivedId:secondId})).statusCode,409)
  assert.equal((await policy(2,"50",2)).statusCode,200)
  const requestId=await ok({...req,receivedId:secondId})
  assert.equal((await command({...req,receivedId:secondId})).statusCode,409)
  assert.equal((await state()).lines[0].returned,"2000000")
  const decision={action:"decideReturn",approve:true,requestId,reason:"Conferência concluída",environment:"production"}
  assert.equal((await command(decision)).statusCode,403)
  const secondUser=randomUUID(),secondMembership=randomUUID()
  await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,'reviewer','reviewer@example.test','Revisor')",[secondUser])
  await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)",[secondMembership,company,secondUser])
  await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)",[secondMembership,reader])
  const decide=()=>app.inject({method:"POST",url:path,headers:{...headers,authorization:"Bearer reviewer","if-match":'"'+rev+'"',"idempotency-key":randomUUID()},payload:decision})
  const approved=await decide();assert.equal(approved.statusCode,200,approved.body);rev=approved.json().revision
  assert.equal((await state()).returnRequests[0].status,"approved")
  assert.equal((await state()).lines[0].returned,"3000000")
  assert.equal((await decide()).statusCode,409)
  const claim=randomUUID(),creditApproval=randomUUID()
  await seed.query("INSERT INTO warranty_cases(id,tenant_id,protocol,customer_id,order_id,line_number,product_id,title,description,criticality,status) VALUES($1,$2,'GAR-lote',$2,$3,1,$4,'Defeito','Garantia sintética','normal','treatment')",[claim,company,order,product])
  await seed.query("INSERT INTO warranty_approvals(id,tenant_id,case_id,action,decision,amount_cents) VALUES($1,$2,$3,'credit','approved',700)",[creditApproval,company,claim])
  await seed.query(`INSERT INTO warranty_settlements(id,tenant_id,case_id,order_id,line_number,customer_id,product_id,approval_id,kind,amount_cents,occurred_on,reference,origin)
    VALUES($1,$2,$3,$4,1,$2,$5,$6,'credit',700,current_date,'Crédito do equipamento','{}')`,[randomUUID(),company,claim,order,product,creditApproval])
  const compensated=await command({...req,receivedId:await incoming(1,8)})
  assert.equal(compensated.statusCode,409,compensated.body)
  assert.match(compensated.body,/garantias/)
  await seed.query("UPDATE fiscal_nfe_documents SET status='cancelled' WHERE tenant_id=$1 AND id=$2",[company,replacementNote.draft])
  const afterCancellation=(await state()).lines[0]
  assert.deepEqual([afterCancellation.allocated,afterCancellation.billed,afterCancellation.delivered,afterCancellation.available],
    ["10000000","4000000","10000000","0"])
}
