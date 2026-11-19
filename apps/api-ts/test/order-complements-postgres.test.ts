import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { localCommercePostgres } from "./local-commerce-postgres.js"

test("Pedidos • onze operações, origens históricas, recebimentos, comprovantes, comissão e cancelamento",{skip:!process.env.API_TS_TEST_ADMIN_URL},async()=>{
 await localCommercePostgres(async({app,seed,tenant,other,clerk})=>{
  const order=randomUUID(),customer=randomUUID(),product=randomUUID(),seller=randomUUID(),bank=randomUUID(),title=randomUUID(),method=randomUUID(),proposal=randomUUID()
  const prefix="/api/v1/",sale="orders/"+order+"/",bill="receivables/"+title
  const get=(path:string,revision?:number,company=tenant)=>app.inject({url:prefix+path,headers:{authorization:"Bearer cashier","x-tenant-id":company,...(revision?{"if-match":'"'+revision+'"'}:{})}})
  const cmd=(path:string,payload:object,revision?:number,key=randomUUID(),method:"POST"|"PUT"="POST")=>app.inject({method,url:prefix+path,headers:{authorization:"Bearer cashier","x-tenant-id":tenant,"idempotency-key":key,...(revision?{"if-match":'"'+revision+'"'}:{})},payload})
  const ok=(r:{statusCode:number;body:string;json():any},expect=200)=>{assert.equal(r.statusCode,expect,r.body);return r.json()}
  await app.ready()
  const routes=[["GET","document"],["GET","finance"],["GET","documents"],["POST","documents"],["GET","documents/:documentId"],["GET","commission"],["PUT","commission"],["GET","cancellations"],["POST","cancel-completed"],["GET","email"],["POST","email"]] as const
  for(const [method,path] of routes) assert.ok(app.hasRoute({method,url:prefix+"orders/:id/"+path}),method+" "+path)
  for(const [method,path] of [["GET","receivables/:id"],["POST","receivables/:id/payments"],["POST","receivables/:id/reverse-payment"],["GET","orders/:id"],["GET","proposals/:id"]] as const) assert.ok(app.hasRoute({method,url:prefix+path}),path)
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])",[clerk,["sales.orders.read","sales.orders.manage","sales.proposals.read","finance.commissions.read","finance.commissions.manage","inventory.stock.manage","finance.receivables.read","finance.receivables.manage"]])
  await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente','52998224725',true,false,'active')",[customer,tenant])
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'EQ-1','Banco','UN',10000000,'active')",[product,tenant])
  await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','52998224725',CURRENT_DATE,10000000,'draft')",[order,tenant,customer])
  await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,product_id,line_number,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,$3,1,'EQ-1','Banco','UN',1000000,10000000,10000000)",[tenant,order,product])
  await seed.query("INSERT INTO staff(id,tenant_id,code,name,is_employee,is_seller,status) VALUES($1,$2,'FUN','Vendedor',false,true,'active')",[seller,tenant])
  await seed.query("INSERT INTO financial_accounts(id,tenant_id,code,name,status,revision,account_type) VALUES($1,$2,'BK','Banco','active',1,'bank')",[bank,tenant])
  await seed.query("INSERT INTO payment_methods(id,tenant_id,code,name,modality,status,revision,settlement_days) VALUES($1,$2,'PX','Pix','pix','active',1,0)",[method,tenant])
  await seed.query("WITH proposal AS (INSERT INTO sales_proposals(id,tenant_id,order_id) VALUES($2,$1,$4) RETURNING id) INSERT INTO sales_proposal_versions(tenant_id,proposal_id,version,customer_id,customer_name,customer_tax_id,valid_until,payment_terms,delivery_terms,notes,amount_cents,created_by) VALUES($1,$2,1,$3,'Cliente','52998224725',CURRENT_DATE,'Entrada combinada','Retirada','',10000000,'cashier')",[tenant,proposal,customer,order])
  const historical=ok(await get("orders/"+order))
  assert.equal(historical.pricingOrigin,false);assert.equal(historical.proposalAgreement.proposalId,proposal)
  assert.equal(ok(await get("proposals/"+proposal)).data.orderId,order)
  ok(await get(sale+"document"),428);ok(await get(sale+"document",2),412)
  const pdf=await get(sale+"document",1)
  assert.equal(pdf.statusCode,200,pdf.statusCode===200?undefined:pdf.body);assert.ok(pdf.rawPayload.subarray(0,5).equals(Buffer.from("%PDF-")));assert.equal(pdf.headers.etag,'"1"');assert.equal(pdf.headers["x-erp-backend"],"typescript");assert.match(String(pdf.headers["content-disposition"]),/pedido-PV-\d+-r1\.pdf/)
  assert.equal(ok(await get(sale+"finance")).state,"not_originated");ok(await get(sale+"finance",undefined,other),403)
  assert.equal(ok(await get(sale+"commission")).data.status,"not_required")
  const term={sellerStaffId:seller,commissionRate:"5.0000",ipiRate:"10.0000",paymentDay:10},tk=randomUUID()
  assert.equal(ok(await cmd(sale+"commission",term,1,tk,"PUT")).data.revision,2);assert.equal(ok(await cmd(sale+"commission",term,1,tk,"PUT")).data.revision,2)
  ok(await cmd(sale+"commission",term,1,randomUUID(),"PUT"),412)
  await seed.query("UPDATE sales_orders SET status='completed' WHERE id=$1",[order])
  await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,0)",[tenant,product])
  await seed.query("INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_order_id) VALUES($1,$2,$3,'issue',1000000,0,'Conclusão comercial do pedido',$4)",[randomUUID(),tenant,product,order])
  await seed.query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente',CURRENT_DATE,10000000,'open')",[title,tenant,order])
  const content=Buffer.concat([Buffer.from("%PDF-1.4\n"),Buffer.alloc(82000,32),Buffer.from("%%EOF")])
  const document={filename:"Comprovante São Paulo.pdf",documentDate:"2026-11-18",description:"Comprovante original",mediaType:"application/pdf",contentBase64:content.toString("base64")}
  const pay=(amount:string)=>({amount,method:"other",reference:"Transferência recebida",occurredOn:"2026-11-18",financialAccountId:bank,paymentMethodId:method})
  await seed.query("CREATE FUNCTION reject_test_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'storage unavailable'; END $$");
  await seed.query("CREATE TRIGGER reject_test_proof BEFORE INSERT ON order_supporting_documents FOR EACH ROW EXECUTE FUNCTION reject_test_proof()");
  ok(await cmd(bill+"/payments",{...pay("50000.00"),supportingDocument:document},1),500)
  const untouched=ok(await get(bill))
  assert.equal(untouched.data.revision,1);assert.equal(untouched.payments.length,0)
  assert.equal((await seed.query("SELECT count(*)::int n FROM financial_account_entries WHERE tenant_id=$1",[tenant])).rows[0].n,0)
  await seed.query("DROP TRIGGER reject_test_proof ON order_supporting_documents")
  const paid=ok(await cmd(bill+"/payments",{...pay("50000.00"),supportingDocument:document},1))
  assert.equal(paid.data.outstandingAmount,"50000.00");assert.equal(paid.payments[0].paymentMethod.name,"Pix");assert.equal(paid.payments[0].method,"bank_transfer")
  const accrual=(await seed.query("SELECT base_cents,amount_cents,payment_due::text FROM commission_entries WHERE tenant_id=$1 AND receipt_id=$2",[tenant,paid.payments[0].id])).rows[0]
  assert.deepEqual(accrual,{base_cents:"4545455",amount_cents:"227273",payment_due:"2026-12-10"})
  const payKey=randomUUID(),second=ok(await cmd(bill+"/payments",pay("10000.00"),2,payKey))
  assert.equal(ok(await cmd(bill+"/payments",pay("10000.00"),2,payKey)).data.receivedAmount,"60000.00")
  ok(await cmd(bill+"/payments",pay("10000.01"),2,payKey),409)
  const finish=await Promise.all([cmd(bill+"/payments",pay("40000.00"),3),cmd(bill+"/payments",pay("40000.00"),3)])
  assert.deepEqual(finish.map(r=>r.statusCode).sort(),[200,412])
  assert.equal(ok(await get(sale+"finance")).state,"paid")
  const p=second.payments.find((v:{amount:string})=>v.amount==="10000.00").id
  const rev={paymentId:p.toUpperCase(),reason:"Estorno da segunda parcela",occurredOn:"2026-11-19"}
  ok(await cmd(bill+"/reverse-payment",{...rev,occurredOn:"2026-11-17"},4),422)
  assert.equal(ok(await cmd(bill+"/reverse-payment",rev,4)).data.outstandingAmount,"10000.00")
  ok(await cmd(bill+"/reverse-payment",rev,5),409)
  const pending=ok(await get(sale+"finance"));assert.equal(pending.receivedAmount,"90000.00");assert.equal(pending.receivables[0].payments.length,4)
  assert.equal(ok(await get(bill)).data.outstandingAmount,pending.outstandingAmount)
  const proof=ok(await get(sale+"documents")).data[0]
  assert.equal(proof.paymentId,paid.payments[0].id);assert.equal(proof.byteSize,content.length)
  const key=randomUUID(),metadata=ok(await cmd(sale+"documents",{document},undefined,key),201).data
  assert.equal(ok(await cmd(sale+"documents",{document},undefined,key),201).data.id,metadata.id)
  const download=await get(sale+"documents/"+metadata.id);assert.deepEqual(download.rawPayload,content);assert.equal(download.headers["x-content-type-options"],"nosniff");assert.match(String(download.headers["content-disposition"]),/%C3%A3/)
  ok(await cmd(sale+"documents",{document:{...document,filename:"fake.png"}}),422)
  ok(await cmd(sale+"documents",{paymentId:randomUUID(),document}),404)
  await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='finance.receivables.read'",[clerk])
  assert.deepEqual(ok(await get(sale+"documents")).data.map((d:{id:string})=>d.id),[metadata.id]);ok(await get(sale+"documents/"+proof.id),403);ok(await get(sale+"finance"),403)
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'finance.receivables.read')",[clerk])
  const cancellation={reason:"Cancelamento integral documentado",occurredOn:"2026-11-20"}, cancelKey=randomUUID()
  ok(await cmd(sale+"cancel-completed",{...cancellation,occurredOn:"2026-11-17"},2),422)
  assert.equal((await seed.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2",[tenant,product])).rows[0].quantity_micros,"0")
  const cancelled=ok(await cmd(sale+"cancel-completed",cancellation,2,cancelKey)).data
  assert.equal(cancelled.stockMovementIds.length,1);assert.equal(cancelled.paymentReversalIds.length,2);assert.equal(cancelled.reconciliation.commission.reversedEntries,3)
  assert.deepEqual(ok(await cmd(sale+"cancel-completed",cancellation,2,cancelKey)).data,cancelled)
  assert.equal(ok(await get(sale+"cancellations")).data[0].id,cancelled.id)
  assert.equal(ok(await get(sale+"finance")).state,"cancelled");assert.equal(ok(await get(sale+"finance")).receivedAmount,"0.00")
  assert.equal(ok(await get(sale+"documents")).data.length,2)
  const totals=(await seed.query("SELECT (SELECT sum(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END) FROM financial_account_entries WHERE tenant_id=$1) AS bank,(SELECT sum(amount_cents) FROM commission_entries WHERE tenant_id=$1) AS commission,(SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2) AS stock",[tenant,product])).rows[0]
  assert.deepEqual(totals,{bank:"0",commission:"0",stock:"1000000"})
 })
})
