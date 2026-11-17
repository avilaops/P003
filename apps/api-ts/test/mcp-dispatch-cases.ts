import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"

export async function verifyMcpDispatch(app: FastifyInstance, seed: Pool) {
  const resource = "https://erp.avilaops.com/mcp"
  const tenant = randomUUID(), foreign = randomUUID(), identity = randomUUID(), membership = randomUUID(), role = randomUUID()
  const subject = `mcp-dispatch-${randomUUID()}`
  const client = `mcp-client-${randomUUID()}`
  await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'MCP A',$3),($2,'MCP B',$4)", [tenant, foreign, tenant.replaceAll("-", "").slice(0, 14), foreign.replaceAll("-", "").slice(0, 14)])
  await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,$2,'mcp@example.test','MCP')", [identity, subject])
  await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [membership, tenant, identity])
  await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'mcp-only','MCP')", [role, tenant])
  await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, role])
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[])", [role, ["catalog.parties.read", "catalog.parties.manage", "catalog.products.read", "catalog.products.manage"]])
  await seed.query("INSERT INTO mcp_oauth_clients(id,name,redirects,auth_method) VALUES($1,'MCP fixture','[\"https://client.example.test/callback\"]','none')", [client])
  async function issue(options: { scope?: string; resource?: string; accessExpiry?: string; grantExpiry?: string; revoked?: boolean; kind?: string } = {}) {
    const grant = randomUUID(), token = `mcp_at_${randomUUID().replaceAll("-", "")}`
    await seed.query("INSERT INTO mcp_oauth_grants(id,client_id,subject,email,name,verified_email,scope,resource,expires_at,revoked_at) VALUES($1,$2,$3,'mcp@example.test','MCP',true,$4,$5,now()+$6::interval,CASE WHEN $7 THEN now() ELSE NULL END)", [grant, client, subject, options.scope ?? "erp.read erp.write", options.resource ?? resource, options.grantExpiry ?? "30 days", options.revoked ?? false])
    await seed.query("INSERT INTO mcp_oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,$3,now()+$4::interval)", [createHash("sha256").update(token).digest("hex"), grant, options.kind ?? "access", options.accessExpiry ?? "15 minutes"])
    return { grant, token }
  }
  const read = await issue({ scope: "erp.read" }), write = await issue()
  const call = (token: string, method: string, path: string, body?: object, extra: Record<string, string> = {}) => app.inject({
    method: "POST", url: "/internal/mcp/dispatch", headers: { authorization: `Bearer ${token}` },
    payload: { method, resource: path, headers: { "x-tenant-id": tenant, ...extra, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: Buffer.from(JSON.stringify(body)).toString("base64") } : {}) },
  })
  const preferences = await call(read.token, "GET", "/api/v1/preferences")
  assert.equal(preferences.statusCode, 200, preferences.body)
  assert.equal(preferences.json().tenantId, tenant)
  assert.equal(preferences.headers.etag, '"1"')
  const input = { personType: "juridica", legalName: "Cliente MCP", taxId: "04252011000110", isCustomer: true, isSupplier: false, status: "active", addresses: [], contacts: [] }
  assert.equal((await call(read.token, "POST", "/api/v1/parties", input, { "idempotency-key": randomUUID() })).statusCode, 403)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM parties WHERE tenant_id=$1", [tenant])).rows[0].count, 0)
  const key = randomUUID()
  const create = () => call(write.token, "POST", "/api/v1/parties", input, { "idempotency-key": key, "x-request-id": "mcp-create-request" })
  const saved = await create()
  assert.equal(saved.statusCode, 201, saved.body)
  assert.equal(saved.headers["x-request-id"], "mcp-create-request")
  const replay = await create()
  assert.equal(replay.statusCode, 201, replay.body)
  assert.deepEqual(replay.json(), saved.json())
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM parties WHERE tenant_id=$1", [tenant])).rows[0].count, 1)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM audit_log WHERE tenant_id=$1 AND entity_type='party'", [tenant])).rows[0].count, 1)
  const photo = Buffer.alloc(70000, 1)
  photo.set([255, 216, 255], 0)
  photo.set([255, 217], photo.length - 2)
  const photoDataUrl = `data:image/jpeg;base64,${photo.toString("base64")}`
  const product = await call(write.token, "POST", "/api/v1/products", { sku: "MCP-PHOTO", name: "Produto MCP", unit: "UN", basePrice: "1234.56", status: "active", photoDataUrl }, { "idempotency-key": randomUUID() })
  assert.equal(product.statusCode, 201, product.body)
  assert.equal(product.json().data.photoDataUrl, photoDataUrl)
  assert.equal((await call(read.token, "GET", "/api/v1/preferences", undefined, { "x-tenant-id": foreign })).statusCode, 403)
  for (const options of [{ resource: "https://outside.example.test/mcp" }, { accessExpiry: "-1 second" }, { grantExpiry: "-1 second" }, { revoked: true }, { kind: "refresh" }]) {
    const rejected = await issue(options)
    assert.equal((await call(rejected.token, "GET", "/api/v1/preferences")).statusCode, 401, JSON.stringify(options))
  }
  await seed.query("UPDATE mcp_oauth_grants SET revoked_at=now() WHERE id=$1", [write.grant])
  assert.equal((await create()).statusCode, 401, "Revocation must be checked even for a known command replay")
}
