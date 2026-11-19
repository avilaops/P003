import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { Pool } from "pg"

import type { AuthorizedContext } from "../src/platform/access.js"
import { PgClientAdapter } from "../src/platform/database.js"
import { Problem } from "../src/platform/problem.js"
import { archiveTemplateDraft, templatePortal, type TemplatePortal } from "../src/modules/contract-templates/archive.js"

const MANAGE = "platform.integrations.manage"
const pdf = Buffer.from("%PDF-1.7\nsynthetic template")

test("portal archive sends DELETE with the token and requires the archived confirmation", async () => {
  const calls: { url: string; method: string; token: string | null }[] = []
  const reply = (body: unknown, status = 200) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", token: new Headers(init?.headers).get("x-auth-token") })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  const env = { DOCUSEAL_URL: "https://contrato.avilaops.com", DOCUSEAL_API_TOKEN: "token-de-teste-com-tamanho" }
  await templatePortal(env, reply({ id: 7, archived_at: "2026-11-18T12:00:00Z" })).archiveTemplate(7)
  assert.deepEqual(calls, [{ url: "https://contrato.avilaops.com/api/templates/7", method: "DELETE", token: env.DOCUSEAL_API_TOKEN }])
  for (const portal of [templatePortal(env, reply({ id: 7, archived_at: null })), templatePortal(env, reply({ id: 8, archived_at: "x" })),
    templatePortal(env, reply({}, 500)), templatePortal({ ...env, DOCUSEAL_URL: "https://outro.example.test" }, reply({ id: 7, archived_at: "x" })),
    templatePortal({ DOCUSEAL_URL: env.DOCUSEAL_URL }, reply({ id: 7, archived_at: "x" }))])
    await assert.rejects(portal.archiveTemplate(7), (error: unknown) => error instanceof Problem && error.status === 503)
})

test("PostgreSQL archives a model once, keeps versions and audit, and hides it from ordinary reads",
  { skip: !process.env.API_TS_TEST_ADMIN_URL }, async () => {
  const adminUrl = new URL(process.env.API_TS_TEST_ADMIN_URL!)
  const suffix = randomUUID().replaceAll("-", "")
  const db = "template_archive_" + suffix, role = "template_archive_" + suffix
  const admin = new Pool({ connectionString: adminUrl.toString() })
  await admin.query("CREATE DATABASE " + db)
  adminUrl.pathname = "/" + db
  const seed = new Pool({ connectionString: adminUrl.toString() })
  const tenant = randomUUID(), other = randomUUID(), subject = "archive-tester"
  const published = randomUUID(), pending = randomUUID(), plain = randomUUID()
  const archived: number[] = []
  const portal: TemplatePortal = { async archiveTemplate(id) { archived.push(id) } }
  const failing: TemplatePortal = { async archiveTemplate() { throw new Problem(503, "contract_portal_unavailable", "indisponível") } }

  async function inTenant<T>(tenantId: string, permissions: string[], action: (context: AuthorizedContext) => Promise<T>) {
    const pg = await seed.connect()
    try {
      await pg.query("BEGIN")
      await pg.query("SET LOCAL ROLE " + role)
      await pg.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.auth_subject',$2,true)", [tenantId, subject])
      const context = { client: new PgClientAdapter(pg), tenantId, authSubject: subject, permissions,
        identity: { subject } } as unknown as AuthorizedContext
      const result = await action(context)
      await pg.query("COMMIT")
      return result
    } catch (error) { await pg.query("ROLLBACK"); throw error }
    finally { pg.release() }
  }
  const archive = (id: string, revision: number, key = randomUUID(), tenantId = tenant, port = portal, permissions = [MANAGE]) =>
    inTenant(tenantId, permissions, context => archiveTemplateDraft(context, id, revision, key, { "x-request-id": "req-1" }, port))
  const visible = (tenantId = tenant) => inTenant(tenantId, [], async context =>
    (await context.client.query<{ id: string }>("SELECT id FROM commercial_template_drafts ORDER BY id")).rows.map(row => row.id))
  const rejects = (promise: Promise<unknown>, status: number) =>
    assert.rejects(promise, (error: unknown) => error instanceof Problem && error.status === status)

  try {
    const directory = new URL("../../../migrations/", import.meta.url)
    for (const name of (await readdir(directory)).filter(n => n.endsWith(".sql")).sort()) await seed.query(await readFile(new URL(name, directory), "utf8"))
    await seed.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS")
    await seed.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO " + role)
    await seed.query("GRANT UPDATE ON commercial_template_drafts TO " + role)
    await seed.query("GRANT INSERT ON domain_commands,audit_log,outbox_events TO " + role)
    for (const [id, tax] of [[tenant, "04252011000110"], [other, "11222333000181"]] as const)
      await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Teste',$2)", [id, tax])
    await seed.query("INSERT INTO identities(auth_subject,email,display_name) VALUES($1,'a@example.test','Teste')", [subject])
    for (const id of [published, pending, plain])
      await seed.query("INSERT INTO commercial_template_drafts(tenant_id,id,definition,pdf,revision) VALUES($1,$2,$3,$4,2)",
        [tenant, id, { name: "Modelo " + id.slice(0, 4), pages: 1, roles: ["Cliente"], fields: [] }, pdf])
    for (const [draft, revision, external] of [[published, 1, 41], [published, 2, 42], [pending, 1, null]] as const)
      await seed.query(`INSERT INTO commercial_template_versions(tenant_id,id,draft_id,draft_revision,definition_json,pdf,request_hash,external_id,published_at)
        VALUES($1,$2,$3,$4,'{}',$5,'hash',$6,$7)`, [tenant, randomUUID(), draft, revision, pdf, external, external ? new Date() : null])

    await rejects(archive(published, 2, randomUUID(), tenant, portal, []), 403)
    await rejects(archive(published, 1), 412)
    await rejects(archive(published, 2, randomUUID(), other), 404)
    await rejects(archive(pending, 2), 409)
    await rejects(archive(published, 2, randomUUID(), tenant, failing), 503)
    assert.equal((await visible()).length, 3, "uma falha do portal não arquiva o modelo no ERP")

    const key = randomUUID()
    const result = await archive(published, 2, key)
    assert.deepEqual(result, { tenantId: tenant, id: published, archived: true, revision: "3", archivedTemplates: [41, 42] })
    assert.deepEqual(archived, [41, 42])
    assert.deepEqual(await archive(published, 2, key), result, "a mesma chave repete a resposta sem chamar o portal")
    assert.deepEqual(archived, [41, 42])
    await rejects(archive(published, 3), 404)
    assert.deepEqual(await visible(), [pending, plain].sort())

    const kept = await seed.query("SELECT count(*)::int AS n FROM commercial_template_versions WHERE draft_id=$1", [published])
    assert.equal(kept.rows[0].n, 2, "as versões publicadas são preservadas")
    const audit = await seed.query("SELECT action,details FROM audit_log WHERE entity_id=$1", [published])
    assert.equal(audit.rows.length, 1)
    assert.equal(audit.rows[0].action, "contract_template_draft.archived")
    assert.deepEqual(audit.rows[0].details.archivedTemplates, [41, 42])

    const unpublished = await archive(plain, 2)
    assert.deepEqual(unpublished.archivedTemplates, [])
    assert.deepEqual(await visible(), [pending])
  } finally {
    await seed.end()
    await admin.query("DROP DATABASE " + db + " WITH (FORCE)")
    await admin.query("DROP ROLE IF EXISTS " + role)
    await admin.end()
  }
})
