import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { localCommercePostgres } from "./local-commerce-postgres.js"

test("funil preserva etapas, atividades, coorte e vínculos da proposta até o pedido com RLS", {skip:!process.env.API_TS_TEST_ADMIN_URL}, async()=>{
  await localCommercePostgres(async({app,seed,tenant,other,clerk})=>{
    const headers={authorization:"Bearer cashier","x-tenant-id":tenant}
    const request=(method:"GET"|"PUT"|"POST",url:string,payload?:object,rev?:number,key=randomUUID(),company=tenant)=>app.inject({method,url:"/api/v1/"+url,headers:{...headers,"x-tenant-id":company,"idempotency-key":key,...(rev?{"if-match":'"'+rev+'"'}:{})},...(payload?{payload}:{})})
    const ok=(r:{statusCode:number;body:string;json():any},code=200)=>{assert.equal(r.statusCode,code,r.body);return r.json()}
    const settings="opportunities/settings"
    const grant=(permissions:string[])=>seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])",[clerk,permissions])
    await grant(["sales.orders.read"])
    const baseline=ok(await request("GET",settings))
    assert.equal(baseline.canEdit,false)
    ok(await request("PUT",settings,baseline.data,1),403)
    await grant(["platform.company.manage","sales.orders.manage","sales.proposals.manage","sales.proposals.read","sales.proposals.decide"])
    const stages=[...baseline.data.stages,{code:"custom-ensaio",label:"Ensaio técnico",active:true}]
    ok(await request("PUT",settings,{stages},1))
    ok(await request("PUT",settings,{stages},1),412)
    const owner=ok(await request("GET","opportunities")).members[0].id
    const customer=randomUUID(),product=randomUUID()
    await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente','52998224725',true,false,'active')",[customer,tenant])
    await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'EQ-A','Peso','UN',1000,'active')",[product,tenant])
    const input={title:"Projeto",estimatedCents:1000,stage:"custom-ensaio",customerId:customer,ownerId:owner,companyName:"",companyTaxId:"",email:"",phone:"",source:"",contactName:"",notes:""}
    ok(await request("POST","opportunities",{...input,ownerId:randomUUID()}),422)
    ok(await request("POST","opportunities",{...input,stage:"lost"}),422)
    const lost=ok(await request("POST","opportunities",{...input,stage:"lost",lossReason:"Orçamento suspenso"}),201).data
    assert.equal(lost.lossReason,"Orçamento suspenso")
    const op=ok(await request("POST","opportunities",input),201).data,detail="opportunities/"+op.id
    ok(await request("GET",detail,undefined,undefined,randomUUID(),other),403)
    const a={kind:"visit",subject:"Medição",dueDate:"2027-02-12",ownerId:owner}
    const k=randomUUID(),activity=ok(await request("POST",detail+"/activities",a,1,k),201)
    assert.deepEqual(ok(await request("POST",detail+"/activities",a,1,k),201),activity)
    ok(await request("POST",detail+"/activities/"+activity.data.id+"/complete",{},2))
    assert.ok(ok(await request("GET",detail)).activities[0].completedAt)
    ok(await request("PUT",settings,{stages:stages.map(s=>s.code==="custom-ensaio"?{...s,label:"Validação técnica",active:false}:s)},2))
    ok(await request("POST","opportunities",input),422)
    ok(await request("PUT",detail,{...input,title:"Projeto revisado"},3))
    const proposal={opportunity:{id:op.id,revision:4},customerId:customer,validUntil:"2100-01-01",paymentTerms:"À vista",deliveryTerms:"Retirada",notes:"",items:[{productId:product,quantity:"1.000000",unitPrice:null}]}
    ok(await request("POST","proposals",{...proposal,opportunity:{id:op.id,revision:1}}),412)
    const key=randomUUID(),p=ok(await request("POST","proposals",proposal,undefined,key),201).data
    assert.equal(ok(await request("POST","proposals",proposal,undefined,key),201).data.id,p.id)
    assert.equal(ok(await request("GET",detail)).data.proposalId,p.id)
    ok(await request("POST","proposals/"+p.id+"/send",{},1))
    assert.equal(ok(await request("GET",detail)).data.stage,"proposed")
    ok(await request("POST","proposals/"+p.id+"/accept",{},2))
    const converted=ok(await request("POST","proposals/"+p.id+"/convert",{dueDate:"2100-01-01"},3)).data
    const final=ok(await request("GET",detail)).data
    assert.equal(final.orderId,converted.orderId)
    assert.equal(final.stage,"won")
    const summary=ok(await request("GET","opportunities?start=2000-01-01&end=2100-01-01"))
    assert.deepEqual(summary.conversion.find((row:{stage:string})=>row.stage==="custom-ensaio"),{stage:"custom-ensaio",reached:1,won:1})
    assert.equal(summary.filteredTotals.find((r:{stage:string})=>r.stage==="won").count,1)
    assert.equal(ok(await request("GET","opportunities?end=2000-01-01")).total,0)
    ok(await request("GET","opportunities?start=2100-01-01&end=2000-01-01"),422)
  })
})
