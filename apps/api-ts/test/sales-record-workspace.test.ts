import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { localCommercePostgres } from "./local-commerce-postgres.js"

test("listas de Vendas • vencimento financeiro, período, vendedor, validade e total da população filtrada", {skip:!process.env.API_TS_TEST_ADMIN_URL},async()=>{
  await localCommercePostgres(async({seed,app,tenant,other,clerk})=>{
    for(const perm of ["sales.orders.read","sales.proposals.read","finance.receivables.read"]) await seed.query("INSERT INTO role_permissions VALUES($1,$2)",[clerk,perm])
    await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Cliente','52998224725',true,false,'active')",[tenant])
    const order=randomUUID(), cancelled=randomUUID(),proposal=randomUUID()
    await seed.query(`INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status,created_at,updated_at)
      VALUES($1,$2,$2,'Cliente','52998224725','2026-12-30',1000,'draft','2026-11-18T01:00Z',now()-interval '9 days'),($3,$2,$2,'Cliente','52998224725','2026-12-30',1300,'cancelled','2026-11-18T01:00Z',now())`,[order,tenant,cancelled])
    await seed.query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','2026-12-08',1000,'open')",[randomUUID(),tenant,order])
    const client=await seed.connect()
    try {
      await client.query("BEGIN")
      await client.query("INSERT INTO sales_proposals(id,tenant_id) VALUES($1,$2)",[proposal,tenant])
      await client.query("INSERT INTO sales_proposal_versions(tenant_id,proposal_id,version,customer_id,customer_name,customer_tax_id,valid_until,payment_terms,delivery_terms,amount_cents,status,created_by) VALUES($1,$2,1,$1,'Cliente','52998224725',(CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date-1,'À vista','Retirada',2000,'draft','cashier')",[tenant,proposal])
      await client.query("COMMIT")
    }finally {client.release()}
    await seed.query(`INSERT INTO sales_opportunities(id,tenant_id,order_id,proposal_id,data,created_by)
      SELECT gen_random_uuid(),$1,$2,$3,jsonb_build_object('ownerId',id),id FROM identities WHERE auth_subject='cashier'`,[tenant,order,proposal])
    const get=(kind:string,qs="",company=tenant)=>app.inject({url:"/api/v1/"+kind+"?view=workspace&"+qs,headers:{authorization:"Bearer cashier","x-tenant-id":company}})
    const result=await get("orders","from=2026-11-17&to=2026-11-17&stale=true&seller=opera")
    assert.equal(result.statusCode,200,result.body)
    assert.equal(result.json().total,1);assert.equal(result.json().totalAmount,"10.00")
    assert.equal(result.json().data[0].dueDate,"2026-12-08");assert.equal(result.json().data[0].dueKind,"open")
    assert.equal(result.json().data[0].sellerKind,"owner");assert.ok(result.json().data[0].staleDays>7)
    assert.equal((await get("orders","includeCancelled=true")).json().totalAmount,"23.00")
    assert.equal((await get("orders","offset=25")).json().total,1)
    const quotes=await get("proposals","q=529.982.247-25&validity=expired")
    assert.equal(quotes.statusCode,200,quotes.body)
    assert.equal(quotes.json().totalAmount,"20.00");assert.equal(quotes.json().data[0].status,"draft");assert.equal(quotes.json().data[0].pastValidity,true)
    assert.equal((await get("proposals","validity=current")).json().total,0)
    assert.equal((await get("proposals","status=expired")).json().total,0)
    assert.equal((await get("orders","",other)).statusCode,403)
    assert.equal((await get("orders","from=2026-12-20&to=2026-11-30")).statusCode,422)
  })
})
