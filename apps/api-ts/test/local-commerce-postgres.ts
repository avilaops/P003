import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { Pool } from "pg"
import { buildApp, type AppDependencies } from "../src/app.js"
import { PgClientAdapter } from "../src/platform/database.js"

type Fixture = {seed:Pool; app:ReturnType<typeof buildApp>;tenant:string;other:string;clerk:string}
export async function localCommercePostgres(run:(fixture:Fixture)=>Promise<void>, options:Pick<AppDependencies,"fiscalOperations">={}) {
  const origin=new URL(process.env.API_TS_TEST_ADMIN_URL!)
  assert.ok(["127.0.0.1","localhost","[::1]"].includes(origin.hostname),"Use PostgreSQL local descartável")
  const suffix=randomUUID().replaceAll("-",""), database="commerce_test_"+suffix, role="commerce_app_"+suffix
  const admin=new Pool({connectionString:origin.toString()})
  await admin.query(`CREATE DATABASE ${database}`)
  origin.pathname="/"+database
  const seed=new Pool({connectionString:origin.toString()}), runtime=new Pool({connectionString:origin.toString()})
  const app=buildApp({...options,pool:{async connect(){const db=await runtime.connect();await db.query(`SET ROLE ${role}`);return new PgClientAdapter(db)}},userinfoUrl:"http://auth.test",fetchAuth:async(_url,init)=>{const subject=new Headers(init?.headers).get("authorization")?.replace(/^Bearer /,"") || "cashier";if(subject.startsWith("erp_")) return new Response(null,{status:401});return Response.json({sub:subject,email:subject+"@example.test"})}})
  try {
    const migrations=new URL("../../../migrations/",import.meta.url)
    for (const name of (await readdir(migrations)).filter(n=>n.endsWith(".sql")).sort()) await seed.query(await readFile(new URL(name,migrations),"utf8"))
    await seed.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`)
    const tenant=randomUUID(), other=randomUUID(), identity=randomUUID(), membership=randomUUID(), clerk=randomUUID()
    await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa PDV','04252011000110'),($2,'Empresa B','52998224725')",[tenant,other])
    await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,'cashier','cashier@example.test','Operador')",[identity])
    await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)",[membership,tenant,identity])
    await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'clerk','Operador')",[clerk,tenant])
    await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)",[membership,clerk])
    await run({seed,app,tenant,other,clerk})
  } finally {
    await app.close(); await runtime.end(); await seed.end()
    await admin.query(`DROP DATABASE ${database}`)
    await admin.query(`DROP ROLE IF EXISTS ${role}`)
    await admin.end()
  }
}
