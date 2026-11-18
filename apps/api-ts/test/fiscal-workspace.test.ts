import {registerInvoicePurchases} from "../src/modules/fiscal-incoming/purchase.js"
import {verifyOwnReturn} from "./self-return-cases.js"
import {registerOrderFinance} from "../src/modules/orders/settlements.js"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { Pool } from "pg"
import Fastify from "fastify"
import { registerFiscalIncoming } from "../src/modules/fiscal-workspace/incoming.js"
import { registerOrderLots } from "../src/modules/fiscal-workspace/order-lots.js"
import { verifyOrderFiscalLots } from "./order-fiscal-lot-cases.js"
import { registerFiscalOutgoing } from "../src/modules/fiscal-workspace/outgoing.js"
import {syntheticEmission,verifyFiscalEmission} from "./fiscal-emission-cases.js"
import {registerOutgoingImports} from "../src/modules/fiscal-workspace/outgoing-imports.js"
import {registerCertificates} from "../src/modules/fiscal-workspace/certificates.js"
import {registerFiscalSettings} from "../src/modules/fiscal-workspace/settings.js"
import {FiscalCertificateVault} from "../src/modules/outgoing-nfse/certificate-vault.js"
import {verifyFiscalArchive} from "./fiscal-archive-cases.js"
import {registerFiscalDrafts} from "../src/modules/fiscal-workspace/drafts.js"
import {registerEmission} from "../src/modules/fiscal-workspace/emission.js"
import {registerEmissionEvents} from "../src/modules/fiscal-workspace/emission-events.js"
import { sha256 } from "../src/modules/nfe-email/danfe.js"
import { PgClientAdapter } from "../src/platform/database.js"
import { Problem } from "../src/platform/problem.js"

test("PostgreSQL • situação por modelo, CSC, total da nota, recebimento e acesso consultivo", { skip:!process.env.API_TS_TEST_ADMIN_URL }, async () => {
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL!)
  assert.ok(["127.0.0.1","localhost","[::1]"].includes(url.hostname))
  const suffix = randomUUID().replaceAll("-","")
  const database = "fiscal_ws_"+suffix, role = "fiscal_ws_read_"+suffix
  const admin = new Pool({connectionString:url.toString()})
  await admin.query("CREATE DATABASE "+database)
  url.pathname="/"+database
  const seed = new Pool({connectionString:url.toString()}), runtime = new Pool({connectionString:url.toString()})
  const app = Fastify()
  try {
    const migrations = new URL("../../../migrations/",import.meta.url)
    for (const migration of (await readdir(migrations)).filter(name=>name.endsWith(".sql")).sort()) await seed.query(await readFile(new URL(migration,migrations),"utf8"))
    await seed.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`)
    const tenant=randomUUID(), other=randomUUID(), identity=randomUUID(), membership=randomUUID(), reader=randomUUID(), consumer=randomUUID()
    await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Emitente','04252011000110'),($2,'Outra','52998224725')",[tenant,other])
    await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,'reader','reader@example.test','Leitor')",[identity])
    await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)",[membership,tenant,identity])
    await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'reader','Leitor')",[reader,tenant])
    await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)",[membership,reader])
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'fiscal.monitor.read'),($1,'fiscal.nfe.read')",[reader])
    const deps = { pool: {connect:async()=>{const c=await runtime.connect();await c.query("SET ROLE "+role);return new PgClientAdapter(c)}},
      userinfoUrl:"https://auth.test/userinfo",fetchAuth:async(_url:RequestInfo|URL,init?:RequestInit)=>{const subject=new Headers(init?.headers).get("authorization")==="Bearer reviewer" ? "reviewer":"reader";return Response.json({sub:subject,email:subject+"@example.test"})} }
    registerOrderFinance(app,deps)
    const transport=syntheticEmission(),outgoingDeps={...deps,fiscalOperations:transport.operations,fiscalVault:new FiscalCertificateVault(JSON.stringify({active:"fixture",keys:{fixture:Buffer.alloc(32,1).toString("base64")}}))}
    registerFiscalDrafts(app,outgoingDeps);registerEmission(app,outgoingDeps);registerEmissionEvents(app,outgoingDeps)
    const pdf=Buffer.from("%PDF-1.7\nsynthetic")
    registerInvoicePurchases(app,outgoingDeps)
    registerFiscalSettings(app,outgoingDeps);registerCertificates(app,outgoingDeps);registerOutgoingImports(app,outgoingDeps,async()=>pdf)
    app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof Problem ? error.status : 500).send({error:String(error)}))
    registerFiscalOutgoing(app,deps);registerFiscalIncoming(app,deps,async input=>{assert.equal(input.issuerTaxId,"19131243000197");return pdf})
    registerOrderLots(app,deps,async input=>{assert.equal(input.issuerTaxId,input.xml.includes("<tpNF>0</tpNF>")?"04252011000110":"19131243000197");return pdf})
    const headers={authorization:"Bearer reader","x-tenant-id":tenant}
    const get=(path:string)=>app.inject({method:"GET",url:"/api/v1/fiscal/"+path,headers})
    const customer={recipient:{legalName:"Cliente",taxId:"52998224725"},items:[{grossTotal:"100.00",freightAmount:"12.50",discountAmount:"2.50"}]}
    await seed.query(`INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents)
      SELECT $1,gen_random_uuid(),'homologation',55,1,1,'{}',$2,10000 FROM generate_series(1,30)`,[tenant,customer])
    await seed.query(`INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents)
      VALUES($1,$2,'homologation',65,1,1,'{}',$3,10000)`,[tenant,consumer,customer])
    const key="35261019131243000197650010000000011000000017"
    const xml='<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe><total><ICMSTot><vNF>115.75</vNF></ICMSTot></total></infNFe></NFe></nfeProc>'
    await seed.query(`INSERT INTO fiscal_nfe_documents(tenant_id,id,model,status,series,number,issued_at,random_code,access_key,signed_xml,authorized_xml,protocol)
      VALUES($1,$2,65,'authorized',1,988,'2026-11-18T01:00:00Z','00000001',$3,$4,$4,'135260000000000')`,[tenant,consumer,key,xml])
    const emitted=await get("outgoing-documents?model=65&status=issued&from=2026-11-17&to=2026-11-17")
    assert.equal(emitted.statusCode,200,emitted.body)
    assert.equal(emitted.json().total,1);assert.equal(emitted.json().data[0].status,"authorized");assert.equal(emitted.json().data[0].amount,"115.75")
    const page=await get("outgoing-documents?model=55&offset=25")
    assert.equal(page.json().total,30,page.body);assert.equal(page.json().data.length,5);assert.equal(page.json().data[0].amount,"110.00")
    assert.deepEqual((await get("nfce-readiness?environment=homologation")).json().blockers,["nfce_csc_unavailable","nfce_numbering_unavailable"])
    await seed.query(`INSERT INTO fiscal_preferences(tenant_id,section,revision,data,secret_key_id,secret_nonce,secret_ciphertext,secret_context)
      VALUES($1,'nfce',1,$2,'fixture',decode(repeat('aa',12),'hex'),decode('bb','hex'),$3)`,
      [tenant,{environment:"homologation",state:"SP",series:1,nextNumber:1,cscId:"01",cscConfigured:true},"avila-erp:nfce-csc:v1:"+tenant+":04252011000110:homologation:01:1"])
    assert.deepEqual((await get("nfce-readiness?environment=homologation")).json().blockers,[])
    assert.ok((await get("nfce-readiness?environment=production")).json().blockers.includes("nfce_csc_unavailable"))
    const fid=(await seed.query(`INSERT INTO fiscal_received_nfes(tenant_id,access_key,issuer_document,issuer_name,recipient_document,number,series,issued_at,total_cents,item_count,environment,xml,xml_sha256,imported_by_identity_id)
      VALUES($1,$2,'19131243000197','Fornecedor','04252011000110',12,1,'2026-11-18T01:00Z',1000,1,1,$3,$4,$5) RETURNING id`,[tenant,key,xml,sha256(xml),identity])).rows[0].id
    const incoming=await get("received-nfes?from=2026-11-17&to=2026-11-17&purchase=unlinked")
    assert.equal(incoming.statusCode,200,incoming.body);assert.equal(incoming.json().total,1);assert.equal(incoming.json().canImport,false)
    assert.equal((await get("received-nfes?from=2026-11-18")).json().total,0)
    assert.equal((await get("received-nfes/"+fid)).json().canManage,false)
    assert.equal((await get("received-nfes/"+fid+"/xml")).body,xml)
    assert.deepEqual((await get("received-nfes/"+fid+"/danfe")).rawPayload,pdf)
    const foreign=await app.inject({url:"/api/v1/fiscal/received-nfes/"+fid,headers:{...headers,"x-tenant-id":other}})
    assert.equal(foreign.statusCode,403)
    await verifyOrderFiscalLots(seed,app,tenant,role,reader,identity)
    await verifyFiscalEmission(seed,app,tenant,reader,transport.calls)
    await verifyFiscalArchive(app,seed,tenant,reader)
    transport.enableSyntheticProduction()
    await verifyOwnReturn(app,seed,tenant)
    // Fail only at COMMIT, after SQL has returned the prospective new revision.
    await seed.query("CREATE FUNCTION test_reject_fiscal_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deferred fiscal fixture'; END $$")
    await seed.query("CREATE CONSTRAINT TRIGGER test_reject_fiscal_commit AFTER INSERT ON audit_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_reject_fiscal_commit()")
    for(const [resource,payload] of [
      ["return-policy",{windowDays:22,approvalAboveCents:"7500"}],
      ["settings/delivery",{notificationEmail:"teste@example.test",authorizedPeople:[]}],
    ] as const){
      const before=await get(resource)
      const rejected=await app.inject({method:"PUT",url:"/api/v1/fiscal/"+resource,headers:{...headers,"if-match":String(before.headers.etag),"idempotency-key":randomUUID()},payload})
      assert.equal(rejected.statusCode,500,rejected.body)
      assert.match(rejected.body,/deferred fiscal fixture/)
      assert.deepEqual((await get(resource)).json(),before.json())
    }
  } finally {
    await app.close();await runtime.end();await seed.end()
    await admin.query("DROP DATABASE "+database);await admin.query("DROP ROLE IF EXISTS "+role);await admin.end()
  }
})
