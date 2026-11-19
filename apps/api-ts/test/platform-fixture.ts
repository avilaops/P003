import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import type { LightMyRequestResponse } from "fastify"

import { buildApp, type AppDependencies } from "../src/app.js"
import { PgClientAdapter } from "../src/platform/database.js"
import { runMigrations } from "../src/platform/migrations.js"

/**
 * Fixture do PR #285 (plataforma/sistema). Equivale ao helper de fixture do #284
 * (`test/support/`), que ainda não foi mesclado: ao ser mesclado, trocar por ele.
 *
 * Cria banco descartável, duas empresas (A e B) e identidades por papel:
 *  - `admin`: todas as permissões listadas em `adminPermissions` na empresa A
 *  - `reader`: só as permissões de leitura informadas em `readerPermissions`
 *  - `visitor`: membro da empresa A sem nenhuma permissão
 *  - `other`: administrador, mas só da empresa B
 */
export type PlatformFixtureOptions = { adminPermissions: string[]; readerPermissions?: string[]; dependencies?: Partial<AppDependencies> }

export async function platformFixture(options: PlatformFixtureOptions) {
  const adminUrl = process.env.API_TS_TEST_ADMIN_URL
  if (!adminUrl) throw new Error("API_TS_TEST_ADMIN_URL não definida")
  const unique = randomUUID().replaceAll("-", ""), database = "plat_test_" + unique, role = "plat_app_" + unique
  const tenant = "11111111-1111-4111-8111-111111111111", otherTenant = "22222222-2222-4222-8222-222222222222"
  const admin = new Pool({ connectionString: adminUrl })
  const url = new URL(adminUrl)
  url.pathname = "/" + database
  const seed = new Pool({ connectionString: url.href }), runtime = new Pool({ connectionString: url.href })
  const app = buildApp({
    userinfoUrl: "http://fixture.test/userinfo",
    fetchAuth: async (_url, init) => {
      const token = new Headers(init?.headers).get("authorization") ?? ""
      const subject = token.replace(/^Bearer /, "")
      if (!["admin", "reader", "visitor", "other"].includes(subject)) return new Response(null, { status: 401 })
      return Response.json({ sub: subject, email: subject + "@example.test", email_verified: true })
    },
    pool: { async connect() {
      const client = await runtime.connect()
      await client.query(`SET ROLE ${role}`)
      return new PgClientAdapter(client)
    } },
    ...options.dependencies,
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
    await runMigrations(seed, { directory: fileURLToPath(new URL("../../../migrations/", import.meta.url)) })
    await seed.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    await seed.query(`GRANT USAGE ON SCHEMA public TO ${role};
      GRANT USAGE ON SCHEMA system_config TO ${role};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${role};
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role};
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA system_config TO ${role};
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`)
    await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa A','04252011000110'),($2,'Empresa B','52998224725')", [tenant, otherTenant])
    await seed.query("INSERT INTO identities(auth_subject,email,display_name) VALUES ('admin','admin@example.test','Administrador'),('reader','reader@example.test','Leitor'),('visitor','visitor@example.test','Visitante'),('other','other@example.test','Outra empresa')")
    await seed.query("INSERT INTO tenant_memberships(tenant_id,identity_id) SELECT $1,id FROM identities WHERE auth_subject IN ('admin','reader','visitor')", [tenant])
    await seed.query("INSERT INTO tenant_memberships(tenant_id,identity_id) SELECT $1,id FROM identities WHERE auth_subject='other'", [otherTenant])
    await seed.query("INSERT INTO roles(tenant_id,code,name) SELECT m.tenant_id,i.auth_subject,i.display_name FROM tenant_memberships m JOIN identities i ON i.id=m.identity_id")
    await seed.query("INSERT INTO membership_roles(membership_id,role_id) SELECT m.id,r.id FROM tenant_memberships m JOIN identities i ON i.id=m.identity_id JOIN roles r ON r.tenant_id=m.tenant_id AND r.code=i.auth_subject")
    const grant = (subject: string, tenantId: string, permissions: string[]) => seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT r.id,unnest($3::text[]) FROM roles r WHERE r.tenant_id=$1 AND r.code=$2", [tenantId, subject, permissions])
    await grant("admin", tenant, options.adminPermissions)
    await grant("other", otherTenant, options.adminPermissions)
    if (options.readerPermissions?.length) await grant("reader", tenant, options.readerPermissions)
    type Call = { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; token?: string | null; tenant?: string | null; body?: unknown; headers?: Record<string, string> }
    /** `token: null` omite o cabeçalho Authorization (caso 401); `tenant` padrão é a empresa A. */
    const call = ({ method, url, token = "admin", tenant: tenantHeader = tenant, body, headers = {} }: Call): Promise<LightMyRequestResponse> => app.inject({
      method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenantHeader ? { "x-tenant-id": tenantHeader } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    })
    return { app, seed, tenant, otherTenant, close, role, call }
  } catch (error) { await close(); throw error }
}
