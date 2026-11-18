import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { localCommercePostgres } from "./local-commerce-postgres.js"

test("garantia reconcilia alçada, crédito utilizado, reembolso, custódia, troca e recuperação com RLS", {skip:!process.env.API_TS_TEST_ADMIN_URL}, async()=>{
  await localCommercePostgres(async({app,seed,tenant,other,clerk})=>{
    const customer=randomUUID(),supplier=randomUUID(),product=randomUUID(),order=randomUUID(),caseId=randomUUID(),bank=randomUUID(),bill=randomUUID()
    const job=randomUUID(),rma=randomUUID(),replacement=randomUUID()
    const grant=async(role:string,rights:string[])=>seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING",[role,rights])
    const addUser=async(subject:string,rights:string[])=>{
      const id=randomUUID(),role=randomUUID(),membership=randomUUID()
      await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,$2,$3,$2)",[id,subject,subject+"@example.test"])
      await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)",[membership,tenant,id])
      await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,$3,$3)",[role,tenant,subject])
      await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)",[membership,role])
      await grant(role,rights)
      return id
    }
    await grant(clerk,["service.warranties.read","service.warranties.manage","service.warranties.approve","inventory.stock.manage","finance.receivables.manage","finance.account_entries.manage"])
    const opener=await addUser("opener",["service.warranties.read","service.warranties.approve"])
    await addUser("checker",["service.warranties.read","service.warranties.approve","service.warranties.manage","finance.receivables.manage","finance.account_entries.manage"])
    await addUser("reader",["service.warranties.read"])
    await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente','52998224725',true,false,'active'),($3,$2,'juridica','Fornecedor','19131243000197',false,true,'active')",[customer,tenant,supplier])
    await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'EQ','Equipamento','UN',100000,'active')",[product,tenant])
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','52998224725','2027-03-01',100000,'completed')",[order,tenant,customer])
    await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'EQ','Equipamento','UN',2000000,50000,100000)",[tenant,order,product])
    await seed.query("INSERT INTO warranty_cases(id,tenant_id,protocol,customer_id,order_id,line_number,product_id,title,description,criticality,status) VALUES($1,$2,'GAR-teste',$3,$4,1,$5,'Defeito','Equipamento para assistência','normal','treatment')",[caseId,tenant,customer,order,product])
    await seed.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,entity_id,details) VALUES($1,$2,'warranty.case.opened','warranty_case',$3,'{}')",[tenant,opener,caseId])
    await seed.query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','2027-02-01',100000,'open')",[bill,tenant,order])
    await seed.query("INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on) VALUES($1,$2,$3,'receipt',15000,'cash','Recibo teste','2026-11-01')",[randomUUID(),tenant,bill])
    await seed.query("INSERT INTO financial_accounts(id,tenant_id,code,name,status,revision,account_type) VALUES($1,$2,'BK','Banco','active',1,'bank')",[bank,tenant])
    await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,1000000)",[tenant,product])
    await seed.query("INSERT INTO warranty_service_orders(id,tenant_id,case_id,status,labor_cents) VALUES($1,$2,$3,'in_repair',10000)",[job,tenant,caseId])
    await seed.query("INSERT INTO warranty_rmas(id,tenant_id,case_id,supplier_id,reference,status) VALUES($1,$2,$3,$4,'RMA-cash','received'),($5,$2,$3,$4,'RMA-stock','received')",[rma,tenant,caseId,supplier,replacement])
    let rev=1
    const h=(actor="cashier",v=rev,key=randomUUID(),org=tenant)=>({authorization:"Bearer "+actor,"x-tenant-id":org,"if-match":'"'+v+'"',"idempotency-key":key})
    const url="/api/v1/warranty-cases/"+caseId
    const get=(actor="cashier",org=tenant)=>app.inject({method:"GET",url:url+"/settlements",headers:h(actor,rev,randomUUID(),org)})
    const ok=(r:{statusCode:number;body:string;json():any},status=200)=>{assert.equal(r.statusCode,status,r.body);return r.json()}
    const post=(body:object,actor="cashier",v=rev,key=randomUUID())=>app.inject({method:"POST",url:url+"/settlements",headers:h(actor,v,key),payload:{reference:"Doc "+rev,occurredOn:"2026-11-18",...body}})
    const approve=async(action:string,amountCents:number|null,actor="checker")=>{
      const r=ok(await app.inject({method:"POST",url:url+"/approval",headers:h(actor),payload:{action,decision:"approved",amountCents,notes:"Aprovado pela alçada"}}))
      rev++;return String(r.data.id)
    }
    const apply=async(body:object,actor="cashier")=>{const value=ok(await post(body,actor));rev++;return value.data}
    const creditId=await approve("credit",50000,"opener")
    const refundId=await approve("refund",2500),exchangeId=await approve("exchange",null)
    const credit={kind:"credit",approvalId:creditId}
    ok(await post(credit),409)
    ok(await post({kind:"review",approvalId:creditId},"opener"),409)
    await apply({kind:"review",approvalId:creditId},"checker")
    ok(await post(credit,"checker"),409)
    ok(await post(credit,"reader"),403)
    const returnLot=randomUUID(),pendingReturn=randomUUID()
    await seed.query("INSERT INTO sales_invoice_lots(tenant_id,id,order_id,environment) VALUES($1,$2,$3,'production')",[tenant,returnLot,order])
    await seed.query(`INSERT INTO sales_self_return_plans(tenant_id,id,order_id,lot_id,environment,original_key,reason,destination,submitted_by,amount_cents,status,items)
      VALUES($1,$2,$3,$4,'production',repeat('1',44),'Devolução em aprovação','stock','opener',60000,'pending',$5)`,
      [tenant,pendingReturn,order,returnLot,JSON.stringify([{lineNumber:1,quantityMicros:"1200000",valueCents:"60000"}])])
    ok(await post(credit),409)
    await seed.query("UPDATE sales_self_return_plans SET status='withdrawn' WHERE tenant_id=$1 AND id=$2",[tenant,pendingReturn])
    const previous=rev,key=randomUUID(),request={...credit,reference:"Credito 1"}
    await seed.query(`CREATE FUNCTION fail_settlement_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'isolated commit failure'; END $$;
      CREATE CONSTRAINT TRIGGER reject_fixture_settlement AFTER INSERT ON warranty_settlements
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.reference='Prova do commit')
      EXECUTE FUNCTION fail_settlement_at_commit()`)
    ok(await post({...credit,reference:"Prova do commit"}),500)
    assert.equal((await seed.query("SELECT id FROM warranty_settlements WHERE tenant_id=$1 AND reference='Prova do commit'",[tenant])).rowCount,0)
    const issued=ok(await post(request,"cashier",previous,key)).data;rev++
    assert.equal(issued.amountCents,50000)
    assert.ok(issued.origin.approvalActors.reviewer)
    assert.equal(ok(await post(request,"cashier",previous,key)).data.id,issued.id)
    ok(await post(credit),409)
    ok(await post({kind:"refund",approvalId:creditId,accountId:bank}),409)
    await apply({kind:"refund",approvalId:refundId,accountId:bank})
    const use={kind:"apply_credit",sourceCreditId:issued.id,receivableId:bill}
    await apply({...use,amountCents:37500})
    ok(await post({...use,amountCents:12501}),409)
    assert.equal((await seed.query("SELECT amount_cents::int AS face FROM receivables WHERE id=$1",[bill])).rows[0].face,62500)
    await apply({kind:"intake",quantity:"2.000000"})
    ok(await post({kind:"intake",quantity:"0.000001"}),409)
    await apply({kind:"repair_return",quantity:"0.500000",serviceOrderId:job})
    await apply({kind:"scrap",quantity:"0.500000"})
    ok(await post({kind:"exchange",approvalId:exchangeId,quantity:"2.000000"}),409)
    await apply({kind:"exchange",approvalId:exchangeId,quantity:"1.000000"})
    await apply({kind:"supplier_stock",rmaId:replacement,supplierId:supplier,quantity:"1.000000"})
    await apply({kind:"supplier_cash",rmaId:rma,supplierId:supplier,accountId:bank,amountCents:1000})
    ok(await post({kind:"supplier_cash",rmaId:rma,supplierId:supplier,accountId:bank,amountCents:900}),409)
    const snapshot=ok(await get())
    assert.equal(snapshot.custody,"0.000000")
    assert.equal(snapshot.movements.find((m:{kind:string})=>m.kind==="credit").creditRemainingCents,12500)
    assert.equal(snapshot.movements.length,9)
    assert.equal((await seed.query("SELECT quantity_micros::int AS q FROM stock_balances WHERE tenant_id=$1 AND product_id=$2",[tenant,product])).rows[0].q,1000000)
    assert.deepEqual((await seed.query("SELECT direction,amount_cents::int AS a FROM financial_account_entries WHERE tenant_id=$1 ORDER BY direction",[tenant])).rows,[{direction:"credit",a:1000},{direction:"debit",a:2500}])
    ok(await get("reader",other),403)
  })
})
