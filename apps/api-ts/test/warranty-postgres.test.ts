import test from "node:test"
import { randomUUID } from "node:crypto"
import { readdir,readFile } from "node:fs/promises"
import { Pool } from "pg"
import { buildApp } from "../src/app.js"
import { PgClientAdapter } from "../src/platform/database.js"
import { verifyWarrantyCases } from "./warranty-cases.js"

test("garantias • contratos, saldo e alçada por empresa", {skip:!process.env.API_TS_TEST_ADMIN_URL}, async () => {
  const origin=new URL(process.env.API_TS_TEST_ADMIN_URL!)
  const suffix=randomUUID().replaceAll("-",""), role="warranty_role_"+suffix, database="warranty_"+suffix
  const admin=new Pool({connectionString:origin.toString()})
  await admin.query("CREATE DATABASE "+database)
  origin.pathname="/"+database
  const seed=new Pool({connectionString:origin.toString()}), api=new Pool({connectionString:origin.toString()})
  const app=buildApp({pool:{async connect(){
    const client=await api.connect()
    await client.query("SET ROLE "+role)
    return new PgClientAdapter(client)
  }},userinfoUrl:"http://auth.test/userinfo",fetchAuth:async()=>Response.json({sub:"reader",email:"reader@example.test"})})
  try {
    const migrations=new URL("../../../migrations/",import.meta.url)
    for (const file of (await readdir(migrations)).filter(name=>name.endsWith(".sql")).sort()) await seed.query(await readFile(new URL(file,migrations),"utf8"))
    await seed.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`)
    const [tenant,identity,membership,memberRole,order] = Array.from({length:5},()=>randomUUID()) as [string,string,string,string,string]
    const product="aa000000-0000-3000-2000-000000000001"
    await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Assistência','04252011000110')",[tenant])
    await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,'reader','reader@example.test','Técnico')",[identity])
    await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)",[membership,tenant,identity])
    await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'technician','Técnico')",[memberRole,tenant])
    await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)",[membership,memberRole])
    await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Cliente','52998224725',true,false,'active')",[tenant])
    await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'LD-1','Banco','UN',10000,'active')",[product,tenant])
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-01',10000,'draft')",[order,tenant])
    await seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'LD-1','Banco','UN',1000000,10000,10000)",[tenant,order,product])
    await verifyWarrantyCases(app,seed,tenant,role,memberRole,order,product)
  } finally {
    await app.close()
    await api.end()
    await seed.end()
    await admin.query("DROP DATABASE "+database)
    await admin.query("DROP ROLE IF EXISTS "+role)
    await admin.end()
  }
})
