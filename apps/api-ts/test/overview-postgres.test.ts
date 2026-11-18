import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { localCommercePostgres } from "./local-commerce-postgres.js"

test("indicadores • mesma população, valor, acesso e janela por empresa", {skip:!process.env.API_TS_TEST_ADMIN_URL}, async()=>{
  await localCommercePostgres(async({app,seed,tenant,other,clerk})=>{
    const headers={authorization:"Bearer cashier","x-tenant-id":tenant}
    const get=(q="")=>app.inject({url:"/api/v1/sales/overview"+q,headers})
    assert.equal((await get()).statusCode,403)
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES ($1,'sales.orders.read')",[clerk])
    await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) SELECT id,id,'fisica','Cliente','52998224725',true,false,'active' FROM tenants")
    const current=randomUUID(),cancelled=randomUUID()
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status,updated_at) VALUES ($1,$2,$2,'Cliente','52998224725',current_date,30450,'draft',now()-interval '8 days'),($3,$2,$2,'Cancelado','52998224725',current_date,90000,'cancelled',now()),($4,$5,$5,'Externo','52998224725',current_date,18200,'draft',now())",[current,tenant,cancelled,randomUUID(),other])
    const all=await get()
    assert.equal(all.statusCode,200,all.body)
    const groups=all.json().sections
    assert.equal(groups.some((s:{group:string})=>s.group==="conversion"),false)
    const summary=groups.find((s:{group:string})=>s.group==="month-orders")
    assert.equal(summary.amountCents,"30450")
    assert.equal(summary.total,1)
    const details=(await get("?group=month-orders")).json().sections[0]
    assert.equal(details.amountCents,summary.amountCents)
    assert.deepEqual(details.data.map((r:{id:string})=>r.id),[current])
    assert.equal((await get("?group=stale-orders")).json().sections[0].total,1)
    assert.equal((await get("?group=conversion")).statusCode,403)
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES ($1,'sales.proposals.read')",[clerk])
    const tx=await seed.connect()
    const submitted=randomUUID()
    try{
      await tx.query("BEGIN")
      await tx.query("INSERT INTO sales_proposals(id,tenant_id,order_id) VALUES($1,$2,$3)",[submitted,tenant,current])
      await tx.query("INSERT INTO sales_proposal_versions(tenant_id,proposal_id,version,customer_id,customer_name,customer_tax_id,valid_until,payment_terms,delivery_terms,amount_cents,status,created_by,sent_at) VALUES($1,$2,1,$1,'Cliente','52998224725',current_date+2,'À vista','Retirada',30450,'sent','cashier',now()-interval '10 days')",[tenant,submitted])
      await tx.query("COMMIT")
    } finally { tx.release() }
    const cohort=await get("?group=conversion")
    assert.equal(cohort.statusCode,200,cohort.body)
    assert.equal(cohort.json().sections[0].converted,1)
    assert.equal(cohort.json().sections[0].total,1)
    assert.equal((await get("?group=expiring")).json().sections[0].data[0].id,submitted)
  })
})
