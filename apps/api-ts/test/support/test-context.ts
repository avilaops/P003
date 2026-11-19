import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { InjectOptions, LightMyRequestResponse } from "fastify"
import { Pool } from "pg"
import { buildApp, type AppDependencies } from "../../src/app.js"
import { PgClientAdapter } from "../../src/platform/database.js"
import { runMigrations } from "../../src/platform/migrations.js"

/**
 * Fixture única dos testes de integração com PostgreSQL do api-ts.
 *
 *   const ctx = await createTestContext({ permissions: ["sales.orders.read"] })
 *   try {
 *     const ok = await ctx.as("user").get("/api/v1/orders")        // 200
 *     const no = await ctx.as("denied").get("/api/v1/orders")      // 403
 *   } finally { await ctx.close() }
 *
 * Cada contexto cria um banco descartável, aplica as migrações, cria duas
 * empresas e quatro identidades e usa o papel `NOSUPERUSER NOBYPASSRLS`,
 * como na produção. `close()` apaga o banco: não há estado entre testes.
 */

export const databaseTestOptions = { skip: process.env.API_TS_TEST_ADMIN_URL ? false : "defina API_TS_TEST_ADMIN_URL (PostgreSQL local descartável)" }

/** `user` tem as permissões pedidas; `denied` é membro sem permissão; `outsider` só pertence à outra empresa; `anonymous` não envia token. */
export type Persona = "user" | "denied" | "outsider" | "anonymous"

export type TestContextOptions = {
  /** Permissões do papel de `user` (códigos da tabela `permissions`). */
  permissions?: string[]
  /** Dependências extras repassadas ao `buildApp` (fiscalOperations, documentCopies, etc.). */
  dependencies?: Partial<AppDependencies>
}

export type RequestOptions = {
  body?: unknown
  query?: Record<string, string | number | boolean>
  headers?: Record<string, string>
  /** Vira `If-Match: "<revision>"`. */
  revision?: number
  /** Gerada automaticamente nas escritas; informe para repetir a mesma intenção. */
  idempotencyKey?: string
  /** Empresa ativa (`X-Tenant-Id`); padrão: empresa do contexto. */
  tenant?: string
}

export type TestClient = ReturnType<typeof makeClient>

const personas: Record<Exclude<Persona, "anonymous">, { code: string; name: string }> = {
  user: { code: "user", name: "Usuário de teste" },
  denied: { code: "denied", name: "Sem permissão" },
  outsider: { code: "outsider", name: "Outra empresa" },
}

export async function createTestContext(options: TestContextOptions = {}) {
  const adminUrl = process.env.API_TS_TEST_ADMIN_URL
  assert.ok(adminUrl, "Defina API_TS_TEST_ADMIN_URL (PostgreSQL local descartável)")
  const origin = new URL(adminUrl)
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "Use PostgreSQL local descartável")

  const unique = randomUUID().replaceAll("-", ""), database = "ctx_test_" + unique, role = "ctx_app_" + unique
  const admin = new Pool({ connectionString: adminUrl })
  origin.pathname = "/" + database
  const seed = new Pool({ connectionString: origin.href }), runtime = new Pool({ connectionString: origin.href })
  const app = buildApp({
    ...options.dependencies,
    userinfoUrl: "http://auth.test/userinfo",
    fetchAuth: async (_url, init) => {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? ""
      if (!(token in personas)) return new Response(null, { status: 401 })
      return Response.json({ sub: token, email: `${token}@example.test` })
    },
    pool: { async connect() { const client = await runtime.connect(); await client.query(`SET ROLE ${role}`); return new PgClientAdapter(client) } },
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      await app.close(); await runtime.end(); await seed.end()
      await admin.query(`DROP DATABASE IF EXISTS ${database}`)
      await admin.query(`DROP ROLE IF EXISTS ${role}`)
    } finally { await admin.end() }
  }

  try {
    await admin.query(`CREATE DATABASE ${database}`)
    await runMigrations(seed, { directory: fileURLToPath(new URL("../../../../migrations/", import.meta.url)) })
    await seed.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO ${role};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE ON TABLES TO ${role};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO ${role};
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${role};
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`)

    const tenant = randomUUID(), otherTenant = randomUUID()
    await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa A','04252011000110'),($2,'Empresa B','52998224725')", [tenant, otherTenant])
    const roles: Record<string, string> = {}
    for (const [key, persona] of Object.entries(personas)) {
      const home = key === "outsider" ? otherTenant : tenant
      const identity = randomUUID(), membership = randomUUID(), roleId = randomUUID()
      await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,$2,$3,$4)", [identity, persona.code, `${persona.code}@example.test`, persona.name])
      await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [membership, home, identity])
      await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,$3,$4)", [roleId, home, persona.code, persona.name])
      await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, roleId])
      roles[key] = roleId
    }

    /** Concede permissões a um papel (falha com mensagem clara se o código não existir). */
    const grant = async (persona: Exclude<Persona, "anonymous">, ...permissions: string[]) => {
      for (const code of permissions) {
        const known = await seed.query("SELECT 1 FROM permissions WHERE code=$1", [code])
        assert.equal(known.rowCount, 1, `Permissão desconhecida: ${code}`)
        await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2) ON CONFLICT DO NOTHING", [roles[persona], code])
      }
    }
    await grant("user", ...(options.permissions ?? []))
    // `outsider` tem todas as permissões na empresa B: prova que o isolamento é por empresa, não por papel.
    const everything = await seed.query("SELECT code FROM permissions")
    await grant("outsider", ...everything.rows.map(row => row.code as string))

    const as = (persona: Persona) => makeClient(app, persona, tenant)
    return { app, seed, tenant, otherTenant, as, grant, close, database, role }
  } catch (error) { await close(); throw error }
}

export type TestContext = Awaited<ReturnType<typeof createTestContext>>

/** Executa `run` e sempre apaga o banco, mesmo se a asserção falhar. */
export async function withTestContext(options: TestContextOptions, run: (ctx: TestContext) => Promise<void>) {
  const ctx = await createTestContext(options)
  try { await run(ctx) } finally { await ctx.close() }
}

function makeClient(app: ReturnType<typeof buildApp>, persona: Persona, tenant: string) {
  const send = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, init: RequestOptions = {}): Promise<LightMyRequestResponse> => {
    const headers: Record<string, string> = { "x-tenant-id": init.tenant ?? tenant, ...init.headers }
    if (persona !== "anonymous") headers.authorization = `Bearer ${persona}`
    if (method !== "GET") headers["idempotency-key"] = init.idempotencyKey ?? randomUUID()
    if (init.revision !== undefined) headers["if-match"] = `"${init.revision}"`
    const request: InjectOptions = { method, url, headers }
    if (init.query) request.query = Object.fromEntries(Object.entries(init.query).map(([key, value]) => [key, String(value)]))
    if (init.body !== undefined) request.payload = init.body as object
    return await app.inject(request)
  }
  return {
    persona,
    get: (url: string, init?: RequestOptions) => send("GET", url, init),
    post: (url: string, init?: RequestOptions) => send("POST", url, init),
    put: (url: string, init?: RequestOptions) => send("PUT", url, init),
    patch: (url: string, init?: RequestOptions) => send("PATCH", url, init),
    delete: (url: string, init?: RequestOptions) => send("DELETE", url, init),
  }
}
