import assert from "node:assert/strict"
import test from "node:test"

import { authenticate } from "../src/platform/auth.js"
import { authorizeRequest } from "../src/platform/access.js"
import { Problem } from "../src/platform/problem.js"
import { withTenantTransaction, type DatabaseClient, type DatabasePool } from "../src/platform/database.js"

const tenant = "11111111-1111-4111-8111-111111111111"

test("authenticate fails closed before business access for missing and refused tokens", async () => {
  let calls = 0
  const fetchAuth: typeof fetch = async (_input, init) => {
    calls += 1
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer refused")
    return new Response(null, { status: 401 })
  }

  await assert.rejects(() => authenticate(undefined, "http://auth.test/oauth/userinfo", fetchAuth),
    (error: unknown) => error instanceof Problem && error.status === 401 && error.code === "missing_token")
  assert.equal(calls, 0)
  await assert.rejects(() => authenticate("Bearer refused", "http://auth.test/oauth/userinfo", fetchAuth),
    (error: unknown) => error instanceof Problem && error.status === 401 && error.code === "invalid_token")
  assert.equal(calls, 1)
})

test("tenant transaction scopes RLS locally, commits success and always releases the client", async () => {
  const events: string[] = []
  const client: DatabaseClient = {
    async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      events.push(`${sql}:${JSON.stringify(values ?? [])}`)
      if (sql.includes("FROM tenants tenant")) return { rows: [{ tenant_id: tenant, permissions: ["platform.preferences.read"] }] as unknown as T[] }
      return { rows: [] as T[] }
    },
    release() { events.push("RELEASE") },
  }
  const pool: DatabasePool = { async connect() { events.push("CONNECT"); return client } }

  const value = await withTenantTransaction(pool, tenant, "subject-1", async context => {
    assert.deepEqual(context.permissions, ["platform.preferences.read"])
    return "ok"
  })

  assert.equal(value, "ok")
  assert.deepEqual(events.slice(0, 4), [
    "CONNECT",
    "BEGIN:[]",
    `SELECT set_config('app.tenant_id',$1,true),set_config('app.auth_subject',$2,true):[\"${tenant}\",\"subject-1\"]`,
    `SELECT tenant.id AS tenant_id,COALESCE(array_agg(DISTINCT role_permission.permission_code) FILTER (WHERE role_permission.permission_code IS NOT NULL),'{}') AS permissions FROM tenants tenant JOIN tenant_memberships membership ON membership.tenant_id=tenant.id JOIN identities identity ON identity.id=membership.identity_id LEFT JOIN membership_roles membership_role ON membership_role.membership_id=membership.id LEFT JOIN roles role ON role.id=membership_role.role_id LEFT JOIN role_permissions role_permission ON role_permission.role_id=role.id WHERE tenant.id=$1 AND identity.auth_subject=$2 AND tenant.status='active' AND membership.status='active' GROUP BY tenant.id:[\"${tenant}\",\"subject-1\"]`,
  ])
  assert.deepEqual(events.slice(-2), ["COMMIT:[]", "RELEASE"])
})

test("tenant transaction rolls back and releases on forbidden access", async () => {
  const events: string[] = []
  const client: DatabaseClient = {
    async query<T extends Record<string, unknown>>(sql: string) { events.push(sql); return { rows: [] as T[] } },
    release() { events.push("RELEASE") },
  }
  const pool: DatabasePool = { async connect() { return client } }

  await assert.rejects(() => withTenantTransaction(pool, tenant, "outsider", async () => "never"),
    (error: unknown) => error instanceof Problem && error.status === 403)
  assert.deepEqual(events.slice(-2), ["ROLLBACK", "RELEASE"])
})

test("request authorization validates identity and tenant before acquiring a database connection", async () => {
  let connections = 0
  const pool: DatabasePool = { async connect() { connections += 1; throw new Error("must not connect") } }
  const request = { headers: { authorization: "Bearer valid" } }
  await assert.rejects(
    () => authorizeRequest(request, { pool, userinfoUrl: "http://auth.test/oauth/userinfo", fetchAuth: async () => Response.json({ sub: "subject-1", email: "user@example.test", email_verified: true }) }, async () => "never"),
    (error: unknown) => error instanceof Problem && error.status === 400 && error.code === "missing_tenant",
  )
  assert.equal(connections, 0)
})
