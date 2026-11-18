import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import { buildApp } from "../src/app.js"
import { PgClientAdapter } from "../src/platform/database.js"
import { runMigrations } from "../src/platform/migrations.js"

export async function stockFixture(adminUrl: string, migrationsDirectory = fileURLToPath(new URL("../../../migrations/", import.meta.url))) {
  const unique = randomUUID().replaceAll("-", ""), database = "stock_test_" + unique, role = "stock_app_" + unique
  const tenant = "11111111-1111-4111-8111-111111111111", otherTenant = randomUUID()
  const admin = new Pool({ connectionString: adminUrl })
  const url = new URL(adminUrl)
  url.pathname = "/" + database
  const seed = new Pool({ connectionString: url.href }), runtime = new Pool({ connectionString: url.href })
  const app = buildApp({ userinfoUrl: "http://fixture.test/userinfo",
    fetchAuth: async (_url, init) => {
      const token = new Headers(init?.headers).get("authorization")
      const subject = token === "Bearer fixture-editor-token" ? "editor" : token === "Bearer fixture-reader-token" ? "reader" : "visitor"
      return Response.json({ sub: subject, email: subject + "@example.test" })
    },
    pool: { async connect() {
      const client = await runtime.connect()
      await client.query(`SET ROLE ${role}`)
      return new PgClientAdapter(client)
    } },
  })
  async function close() {
    try {
      await app.close()
      await runtime.end()
      await seed.end()
      await admin.query(`DROP DATABASE IF EXISTS ${database}`)
      await admin.query(`DROP ROLE IF EXISTS ${role}`)
    } finally { await admin.end() }
  }
  try {
    await admin.query(`CREATE DATABASE ${database}`)
    await runMigrations(seed, { directory: migrationsDirectory })
    await seed.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    await seed.query(`GRANT USAGE ON SCHEMA public TO ${role};
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${role};
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`)
    await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa A','04252011000110'),($2,'Empresa B','52998224725')", [tenant, otherTenant])
    await seed.query(`
      INSERT INTO identities(auth_subject,email,display_name) VALUES ('reader','reader@example.test','Leitor'),('editor','editor@example.test','Operador'),('visitor','visitor@example.test','Visitante');
      INSERT INTO tenant_memberships(tenant_id,identity_id) SELECT t.id,i.id FROM tenants t CROSS JOIN identities i;
      INSERT INTO roles(tenant_id,code,name) SELECT t.id,i.auth_subject,i.display_name FROM tenants t CROSS JOIN identities i;
      INSERT INTO membership_roles(membership_id,role_id) SELECT m.id,r.id FROM tenant_memberships m JOIN identities i ON i.id=m.identity_id JOIN roles r ON r.tenant_id=m.tenant_id AND r.code=i.auth_subject;
      INSERT INTO role_permissions(role_id,permission_code) SELECT id,'inventory.stock.read' FROM roles WHERE code IN ('reader','editor');
      INSERT INTO role_permissions(role_id,permission_code) SELECT id,unnest(ARRAY['inventory.stock.manage','sales.orders.manage','sales.orders.read','catalog.products.manage','catalog.products.read']) FROM roles WHERE code='editor';
      INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) SELECT id,id,'fisica','Cliente','52998224725',true,false,'active' FROM tenants;
    `)
    return { app, seed, tenant, otherTenant, close, role }
  } catch (error) { await close(); throw error }
}
