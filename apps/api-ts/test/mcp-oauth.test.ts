import assert from "node:assert/strict"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import test from "node:test"
import type { LightMyRequestResponse } from "fastify"

import { createTestContext, databaseTestOptions, type TestContext } from "./support/test-context.js"

// Routes of PR 10: the remote MCP (OAuth issuer + Streamable HTTP transport), against PostgreSQL.
const resource = "https://erp.avilaops.com/mcp"
const redirect = "https://claude.ai/api/mcp/auth_callback"
type Json = Record<string, any>

function pkce() {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}
const form = (values: Record<string, string>) => new URLSearchParams(values).toString()
const ok = (response: LightMyRequestResponse, status: number) => { assert.equal(response.statusCode, status, response.body); return response }

function client(ctx: TestContext) {
  const app = ctx.app
  const register = (body: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/mcp/oauth/register", headers: { "content-type": "application/json", ...headers }, payload: JSON.stringify(body) })
  const authorization = (clientId: string, challenge: string, extra: Record<string, string> = {}) => ({ client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource, state: "estado-1", ...extra })
  const grant = (persona: string | null, body: unknown) => app.inject({ method: "POST", url: "/mcp/oauth/grant", headers: { "content-type": "application/json", ...(persona ? { authorization: `Bearer ${persona}` } : {}) }, payload: JSON.stringify(body) })
  const token = (values: Record<string, string>, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/mcp/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, payload: form(values) })
  const revoke = (values: Record<string, string>, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/mcp/oauth/revoke", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, payload: form(values) })
  const rpc = (accessToken: string | null, message: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/mcp", headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...headers }, payload: typeof message === "string" ? message : JSON.stringify(message) })
  const call = async (accessToken: string, name: string, args: unknown) => (await rpc(accessToken, { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } })).json() as Json
  /** Full browser-free authorization: register → consent grant → code exchange. */
  const connect = async (persona: string, scope = "erp.read erp.write") => {
    const registered = ok(await register({ redirect_uris: [redirect], client_name: `Cliente ${persona}` }), 201).json() as Json
    const { verifier, challenge } = pkce()
    const granted = ok(await grant(persona, authorization(registered.client_id, challenge, { scope })), 201).json() as Json
    const code = new URL(granted.redirect_uri).searchParams.get("code")!
    const tokens = ok(await token({ grant_type: "authorization_code", client_id: registered.client_id, code, code_verifier: verifier, redirect_uri: redirect, resource }), 200).json() as Json
    return { clientId: registered.client_id as string, ...tokens } as Json & { clientId: string; access_token: string; refresh_token: string }
  }
  return { app, register, authorization, grant, token, revoke, rpc, call, connect }
}

test("MCP OAuth and transport keep the Rust contract, scopes, permissions and tenant isolation", databaseTestOptions, async t => {
  const ctx = await createTestContext({ permissions: ["catalog.products.read", "catalog.products.manage"], dependencies: { mcpResource: resource } })
  try {
    const mcp = client(ctx)

    await t.test("GET /.well-known/oauth-protected-resource + GET /.well-known/oauth-protected-resource/mcp + GET /.well-known/oauth-authorization-server [sucesso] metadados RFC 9728 e RFC 8414", async () => {
      for (const url of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        const response = ok(await ctx.app.inject({ method: "GET", url }), 200)
        assert.deepEqual(response.json(), { resource, authorization_servers: ["https://erp.avilaops.com"], scopes_supported: ["erp.read", "erp.write"], bearer_methods_supported: ["header"], resource_name: "Ávila ERP MCP" })
        assert.equal(response.headers["cache-control"], "no-store")
        assert.equal(response.headers["x-content-type-options"], "nosniff")
      }
      const server = ok(await ctx.app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server", headers: { origin: "https://claude.ai" } }), 200)
      const metadata = server.json() as Json
      assert.equal(metadata.issuer, "https://erp.avilaops.com")
      assert.equal(metadata.authorization_endpoint, "https://erp.avilaops.com/mcp/oauth/authorize")
      assert.equal(metadata.registration_endpoint, "https://erp.avilaops.com/mcp/oauth/register")
      assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"])
      assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"])
      assert.equal(server.headers["access-control-allow-origin"], "https://claude.ai")
      assert.equal(server.headers.vary, "Origin")
    })

    await t.test("GET /.well-known/oauth-authorization-server + GET /.well-known/oauth-protected-resource + GET /.well-known/oauth-protected-resource/mcp + GET /mcp [negado] origem de navegador não autorizada", async () => {
      for (const url of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/mcp", "/mcp/oauth/register"]) {
        const response = await ctx.app.inject({ method: url === "/mcp/oauth/register" ? "OPTIONS" : "GET", url, headers: { origin: "https://evil.example" } })
        assert.equal(response.statusCode, 403)
        assert.equal(response.headers["access-control-allow-origin"], undefined)
      }
    })

    await t.test("OPTIONS /mcp + OPTIONS /mcp/oauth/register + OPTIONS /mcp/oauth/token + OPTIONS /mcp/oauth/revoke [sucesso] preflight CORS", async () => {
      for (const url of ["/mcp", "/mcp/oauth/register", "/mcp/oauth/token", "/mcp/oauth/revoke"]) {
        const response = ok(await ctx.app.inject({ method: "OPTIONS", url, headers: { origin: "https://claude.ai", "access-control-request-method": "POST" } }), 204)
        assert.equal(response.headers["access-control-allow-methods"], "GET, POST, DELETE, OPTIONS")
        assert.equal(response.headers["access-control-allow-headers"], "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id")
        assert.equal(response.headers["access-control-max-age"], "600")
        assert.equal(response.headers["access-control-allow-origin"], "https://claude.ai")
      }
    })

    await t.test("POST /mcp/oauth/register [sucesso] registro dinâmico público e confidencial, só hash do segredo", async () => {
      const response = ok(await mcp.register({ redirect_uris: [redirect, "http://127.0.0.1:3334/callback"] }), 201)
      const body = response.json() as Json
      assert.match(body.client_id, /^mcp_client_/)
      assert.deepEqual({ ...body, client_id: undefined }, { client_id: undefined, client_name: "Cliente MCP", redirect_uris: [redirect, "http://127.0.0.1:3334/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "erp.read erp.write" })
      assert.equal(response.headers["cache-control"], "no-store")
      const confidential = ok(await mcp.register({ redirect_uris: [redirect], token_endpoint_auth_method: "client_secret_post", client_name: "Confidencial" }), 201).json() as Json
      assert.match(confidential.client_secret, /^mcp_secret_/)
      assert.equal(confidential.client_secret_expires_at, 0)
      const stored = await ctx.seed.query("SELECT secret_hash FROM mcp_oauth_clients WHERE id=$1", [confidential.client_id])
      assert.equal(stored.rows[0].secret_hash, createHash("sha256").update(confidential.client_secret).digest("hex"))
    })

    await t.test("POST /mcp/oauth/register [negado] metadados inválidos, mídia errada e limite por hora", async () => {
      for (const body of [
        { redirect_uris: [] }, { redirect_uris: ["http://example.com/cb"] }, { redirect_uris: ["https://example.com/cb#x"] }, { redirect_uris: ["https://*.example.com/cb"] },
        { redirect_uris: ["https://user:pass@example.com/cb"] }, { redirect_uris: [redirect], token_endpoint_auth_method: "private_key_jwt" },
        { redirect_uris: [redirect], grant_types: ["client_credentials"] }, { redirect_uris: [redirect], response_types: ["token"] }, { redirect_uris: [redirect], client_name: "" },
        { redirect_uris: Array.from({ length: 11 }, (_, index) => `https://example.com/${index}`) }, { client_name: "sem redirect" },
      ]) assert.deepEqual(ok(await mcp.register(body), 400).json(), { error: "invalid_client_metadata" }, JSON.stringify(body))
      ok(await ctx.app.inject({ method: "POST", url: "/mcp/oauth/register", headers: { "content-type": "text/plain" }, payload: "{}" }), 415)
      ok(await ctx.app.inject({ method: "POST", url: "/mcp/oauth/register", headers: { "content-type": "application/json" }, payload: "{" }), 400)
      ok(await ctx.app.inject({ method: "POST", url: "/mcp/oauth/register", headers: { "content-type": "application/json" }, payload: JSON.stringify({ redirect_uris: [redirect], client_name: "x".repeat(17_000) }) }), 413)
      const before = await ctx.seed.query("SELECT count(*)::int AS total FROM mcp_oauth_clients WHERE created_at>now()-interval '1 hour'")
      await ctx.seed.query("INSERT INTO mcp_oauth_clients(id,name,redirects,auth_method) SELECT 'quota_'||n,'Cota','[]','none' FROM generate_series(1,$1::int) n", [200 - before.rows[0].total])
      assert.deepEqual(ok(await mcp.register({ redirect_uris: [redirect] }), 429).json(), { error: "registration_limit" })
      await ctx.seed.query("UPDATE mcp_oauth_clients SET created_at=now()-interval '2 hours' WHERE id LIKE 'quota_%'")
    })

    const registered = ok(await mcp.register({ redirect_uris: [redirect], client_name: "Claude" }), 201).json() as Json
    const { challenge } = pkce()

    await t.test("GET /mcp/oauth/authorization-request [sucesso] descreve o cliente para a tela de consentimento", async () => {
      const query = new URLSearchParams(mcp.authorization(registered.client_id, challenge, { scope: "erp.write erp.read erp.read" }))
      assert.deepEqual(ok(await ctx.app.inject({ method: "GET", url: `/mcp/oauth/authorization-request?${query}` }), 200).json(), { client_name: "Claude", redirect_uri: redirect, scope: "erp.read erp.write" })
      const defaults = new URLSearchParams(mcp.authorization(registered.client_id, challenge))
      assert.equal((ok(await ctx.app.inject({ method: "GET", url: `/mcp/oauth/authorization-request?${defaults}` }), 200).json() as Json).scope, "erp.read erp.write")
    })

    await t.test("GET /mcp/oauth/authorization-request [negado] cliente, retorno, PKCE, recurso e escopo inválidos", async () => {
      const cases: [Record<string, string>, string][] = [
        [{ client_id: "mcp_client_desconhecido" }, "invalid_client"], [{ redirect_uri: "https://claude.ai/outro" }, "invalid_redirect_uri"],
        [{ code_challenge_method: "plain" }, "invalid_request"], [{ code_challenge: "curto" }, "invalid_request"], [{ response_type: "token" }, "invalid_request"],
        [{ resource: "https://erp.avilaops.com/outro" }, "invalid_request"], [{ scope: "erp.admin" }, "invalid_scope"], [{ state: "s".repeat(513) }, "invalid_request"],
      ]
      for (const [change, error] of cases) {
        const query = new URLSearchParams({ ...mcp.authorization(registered.client_id, challenge), ...change })
        assert.deepEqual(ok(await ctx.app.inject({ method: "GET", url: `/mcp/oauth/authorization-request?${query}` }), 400).json(), { error }, JSON.stringify(change))
      }
      const missing = new URLSearchParams(mcp.authorization(registered.client_id, challenge))
      missing.delete("code_challenge")
      ok(await ctx.app.inject({ method: "GET", url: `/mcp/oauth/authorization-request?${missing}` }), 400)
      ok(await ctx.app.inject({ method: "GET", url: `/mcp/oauth/authorization-request?${new URLSearchParams(mcp.authorization(registered.client_id, challenge))}&state=dup` }), 400)
    })

    await t.test("POST /mcp/oauth/grant [sucesso] consentimento emite código de uso único com state", async () => {
      const response = ok(await mcp.grant("user", mcp.authorization(registered.client_id, challenge)), 201)
      const target = new URL((response.json() as Json).redirect_uri)
      assert.equal(target.origin + target.pathname, redirect)
      assert.match(target.searchParams.get("code")!, /^mcp_code_/)
      assert.equal(target.searchParams.get("state"), "estado-1")
      const stored = await ctx.seed.query("SELECT c.hash,g.subject,g.scope,g.resource FROM mcp_oauth_codes c JOIN mcp_oauth_grants g ON g.id=c.grant_id WHERE c.hash=$1", [createHash("sha256").update(target.searchParams.get("code")!).digest("hex")])
      assert.deepEqual({ ...stored.rows[0], hash: undefined }, { hash: undefined, subject: "user", scope: "erp.read erp.write", resource })
    })

    await t.test("POST /mcp/oauth/grant [negado] sem sessão do usuário (401) e pedido inválido (400)", async () => {
      const anonymous = ok(await mcp.grant(null, mcp.authorization(registered.client_id, challenge)), 401)
      assert.equal((anonymous.json() as Json).status, 401)
      ok(await mcp.grant("invalido", mcp.authorization(registered.client_id, challenge)), 401)
      assert.deepEqual(ok(await mcp.grant("user", mcp.authorization(registered.client_id, challenge, { redirect_uri: "https://evil.example/cb" })), 400).json(), { error: "invalid_redirect_uri" })
      assert.deepEqual(ok(await mcp.grant("user", { client_id: registered.client_id }), 400).json(), { error: "invalid_request" })
    })

    await t.test("POST /mcp/oauth/token [sucesso] troca de código com PKCE e rotação do refresh token", async () => {
      const session = await mcp.connect("user")
      assert.match(session.access_token, /^mcp_at_/)
      assert.match(session.refresh_token, /^mcp_rt_/)
      assert.equal(session.token_type, "Bearer")
      assert.equal(session.expires_in, 900)
      assert.equal(session.scope, "erp.read erp.write")
      const plain = await ctx.seed.query("SELECT count(*)::int AS total FROM mcp_oauth_tokens WHERE hash IN ($1,$2)", [session.access_token, session.refresh_token])
      assert.equal(plain.rows[0].total, 0, "tokens são armazenados só como hash")
      const expiry = await ctx.seed.query("SELECT kind,expires_at<=now()+interval '15 minutes' AS short FROM mcp_oauth_tokens WHERE hash=$1", [createHash("sha256").update(session.access_token).digest("hex")])
      assert.deepEqual(expiry.rows[0], { kind: "access", short: true })
      const rotated = ok(await mcp.token({ grant_type: "refresh_token", client_id: session.clientId, refresh_token: session.refresh_token, resource }), 200)
      assert.equal(rotated.headers.pragma, "no-cache")
      const next = rotated.json() as Json
      assert.notEqual(next.refresh_token, session.refresh_token)
      ok(await mcp.rpc(next.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }), 200)
    })

    await t.test("POST /mcp/oauth/token [negado] código reutilizado, PKCE errado, cliente inválido e reuso de refresh revoga a concessão", async () => {
      const registeredClient = ok(await mcp.register({ redirect_uris: [redirect] }), 201).json() as Json
      const { verifier, challenge: codeChallenge } = pkce()
      const code = new URL((ok(await mcp.grant("user", mcp.authorization(registeredClient.client_id, codeChallenge)), 201).json() as Json).redirect_uri).searchParams.get("code")!
      const exchange = { grant_type: "authorization_code", client_id: registeredClient.client_id, code, code_verifier: verifier, redirect_uri: redirect, resource }
      assert.deepEqual(ok(await mcp.token({ ...exchange, resource: "https://outro/mcp" }), 400).json(), { error: "invalid_target" })
      assert.deepEqual(ok(await mcp.token({ ...exchange, code_verifier: pkce().verifier }), 400).json(), { error: "invalid_grant" })
      assert.deepEqual(ok(await mcp.token({ ...exchange, code_verifier: "curto" }), 400).json(), { error: "invalid_grant" })
      assert.deepEqual(ok(await mcp.token({ ...exchange, redirect_uri: "https://claude.ai/outro" }), 400).json(), { error: "invalid_grant" })
      assert.deepEqual(ok(await mcp.token({ ...exchange, client_secret: "nao-tem" }), 401).json(), { error: "invalid_client" })
      assert.deepEqual(ok(await mcp.token({ ...exchange, client_id: "mcp_client_x" }), 400).json(), { error: "invalid_client" })
      assert.deepEqual(ok(await mcp.token({ ...exchange, grant_type: "password" }), 400).json(), { error: "unsupported_grant_type" })
      ok(await ctx.app.inject({ method: "POST", url: "/mcp/oauth/token", headers: { "content-type": "application/json" }, payload: JSON.stringify(exchange) }), 415)
      ok(await ctx.app.inject({ method: "POST", url: "/mcp/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `${form(exchange)}&code=dup` }), 400)
      ok(await mcp.token(exchange), 200)
      assert.deepEqual(ok(await mcp.token(exchange), 400).json(), { error: "invalid_grant" }, "código é de uso único")

      const session = await mcp.connect("user")
      const rotated = ok(await mcp.token({ grant_type: "refresh_token", client_id: session.clientId, refresh_token: session.refresh_token, resource }), 200).json() as Json
      assert.deepEqual(ok(await mcp.token({ grant_type: "refresh_token", client_id: session.clientId, refresh_token: session.refresh_token, resource }), 400).json(), { error: "invalid_grant" })
      ok(await mcp.rpc(rotated.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }), 401)
      ok(await mcp.token({ grant_type: "refresh_token", client_id: session.clientId, refresh_token: rotated.refresh_token, resource }), 400)

      const narrowed = await mcp.connect("user")
      assert.deepEqual(ok(await mcp.token({ grant_type: "refresh_token", client_id: narrowed.clientId, refresh_token: narrowed.refresh_token, resource, scope: "erp.read" }), 400).json(), { error: "invalid_scope" })
    })

    await t.test("POST /mcp/oauth/token [sucesso] clientes confidenciais por client_secret_post e client_secret_basic", async () => {
      for (const method of ["client_secret_post", "client_secret_basic"] as const) {
        const confidential = ok(await mcp.register({ redirect_uris: [redirect], token_endpoint_auth_method: method }), 201).json() as Json
        const { verifier, challenge: codeChallenge } = pkce()
        const code = new URL((ok(await mcp.grant("user", mcp.authorization(confidential.client_id, codeChallenge)), 201).json() as Json).redirect_uri).searchParams.get("code")!
        const base = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, resource }
        const basic = `Basic ${Buffer.from(`${encodeURIComponent(confidential.client_id)}:${encodeURIComponent(confidential.client_secret)}`).toString("base64")}`
        const wrong = method === "client_secret_post" ? mcp.token({ ...base, client_id: confidential.client_id, client_secret: "errado" }) : mcp.token(base, { authorization: `Basic ${Buffer.from(`${confidential.client_id}:errado`).toString("base64")}` })
        assert.deepEqual(ok(await wrong, 401).json(), { error: "invalid_client" })
        const mismatched = method === "client_secret_post" ? mcp.token(base, { authorization: basic }) : mcp.token({ ...base, client_id: confidential.client_id, client_secret: confidential.client_secret })
        ok(await mismatched, 401)
        const right = method === "client_secret_post" ? mcp.token({ ...base, client_id: confidential.client_id, client_secret: confidential.client_secret }) : mcp.token(base, { authorization: basic })
        ok(await right, 200)
      }
    })

    const writer = await mcp.connect("user")
    const reader = await mcp.connect("user", "erp.read")
    const denied = await mcp.connect("denied")
    const outsider = await mcp.connect("outsider")

    await t.test("POST /mcp [negado] sem token, token inválido, versão de protocolo e mídia errada", async () => {
      for (const authorization of [undefined, "Bearer invalido", `Bearer ${writer.refresh_token}`, "Basic abc"]) {
        const response = ok(await ctx.app.inject({ method: "POST", url: "/mcp", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) }, payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }), 401)
        assert.equal(response.headers["www-authenticate"], 'Bearer resource_metadata="https://erp.avilaops.com/.well-known/oauth-protected-resource/mcp"')
        assert.deepEqual(response.json(), { error: "invalid_token" })
      }
      ok(await mcp.rpc(writer.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "2024-01-01" }), 400)
      ok(await mcp.rpc(writer.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }, { "content-type": "text/plain" }), 415)
    })

    await t.test("GET /mcp + DELETE /mcp [sucesso] transporte sem estado responde 405 com Allow", async () => {
      for (const method of ["GET", "DELETE"] as const) {
        const response = ok(await ctx.app.inject({ method, url: "/mcp", headers: { authorization: `Bearer ${writer.access_token}` } }), 405)
        assert.equal(response.headers.allow, "POST, OPTIONS")
      }
    })

    await t.test("GET /mcp + DELETE /mcp [negado] sem token MCP", async () => {
      for (const method of ["GET", "DELETE"] as const) ok(await ctx.app.inject({ method, url: "/mcp" }), 401)
    })

    await t.test("POST /mcp [sucesso] initialize, ping, notificações e erros JSON-RPC", async () => {
      const init = ok(await mcp.rpc(writer.access_token, { jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-06-18" } }), 200).json() as Json
      assert.equal(init.id, 7)
      assert.equal(init.result.protocolVersion, "2025-06-18")
      assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } })
      assert.equal(init.result.serverInfo.name, "avila-erp")
      assert.match(init.result.instructions, /tenant_id explícito/)
      assert.equal((ok(await mcp.rpc(writer.access_token, { jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "1999" } }), 200).json() as Json).result.protocolVersion, "2025-11-25")
      assert.deepEqual(ok(await mcp.rpc(writer.access_token, { jsonrpc: "2.0", id: "p", method: "ping" }), 200).json(), { jsonrpc: "2.0", id: "p", result: {} })
      ok(await mcp.rpc(writer.access_token, { jsonrpc: "2.0", method: "notifications/initialized" }), 202)
      ok(await mcp.rpc(writer.access_token, { jsonrpc: "2.0", method: "tools/list" }), 400)
      assert.deepEqual((ok(await mcp.rpc(writer.access_token, "{quebrado"), 200).json() as Json).error, { code: -32700, message: "Invalid JSON" })
      for (const message of [[], { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: {}, method: "ping" }, { jsonrpc: "2.0", id: 1 }]) {
        assert.equal((ok(await mcp.rpc(writer.access_token, message), 200).json() as Json).error.code, -32600)
      }
      assert.equal((ok(await mcp.rpc(writer.access_token, { jsonrpc: "2.0", id: 1, method: "resources/list" }), 200).json() as Json).error.code, -32601)
    })

    const listAll = async (accessToken: string) => {
      const names: Json[] = []
      let cursor: string | undefined
      do {
        const page = ok(await mcp.rpc(accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list", params: cursor ? { cursor } : {} }), 200).json() as Json
        assert.ok(page.result.tools.length <= 40)
        names.push(...page.result.tools)
        cursor = page.result.nextCursor
      } while (cursor)
      return names
    }

    await t.test("POST /mcp [sucesso] tools/list paginado e filtrado pelo escopo", async () => {
      const all = await listAll(writer.access_token), readOnly = await listAll(reader.access_token)
      assert.ok(all.length > 300, `catálogo com ${all.length} ferramentas`)
      assert.ok(readOnly.length > 100 && readOnly.length < all.length)
      assert.ok(readOnly.every(tool => tool.annotations.readOnlyHint === true))
      const names = all.map(tool => tool.name)
      assert.deepEqual(names, [...names].sort())
      const byName = new Map(all.map(tool => [tool.name, tool]))
      const list = byName.get("erp_get_tag_groups")!, update = byName.get("erp_put_tag_groups__id_")!
      assert.equal(list._meta["erp/path"], "/api/v1/tag-groups")
      assert.equal(update._meta["erp/method"], "PUT")
      assert.deepEqual(update.inputSchema.required, ["tenant_id", "path"])
      assert.deepEqual(Object.keys(update.inputSchema.properties.headers.properties), ["If-Match", "Idempotency-Key"])
      assert.deepEqual(update.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true })
      assert.equal(byName.get("erp_get_me")?.inputSchema.properties.body, undefined)
      assert.ok(names.every(name => name.length <= 64 && /^erp_(get|post|put|patch|delete)_/.test(name)))
      assert.ok(!names.some(name => name.includes("webhooks") || name.includes("integrations_nfse")))
      assert.equal((ok(await mcp.rpc(writer.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "99999" } }), 200).json() as Json).error.code, -32602)
      assert.equal((ok(await mcp.rpc(writer.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: 3 } }), 200).json() as Json).error.code, -32602)
    })

    let groupId = ""
    await t.test("POST /mcp [sucesso] tools/call de escrita com Idempotency-Key, If-Match 412 e replay", async () => {
      const key = randomUUID(), body = { code: "MCP", name: "Grupo MCP", status: "active" }
      const created = await mcp.call(writer.access_token, "erp_post_tag_groups", { tenant_id: ctx.tenant, headers: { "Idempotency-Key": key }, body })
      assert.equal(created.result.isError, false, JSON.stringify(created))
      assert.equal(created.result.structuredContent.status, 201)
      assert.equal(created.result.structuredContent.headers["x-erp-backend"], "typescript")
      assert.equal(created.result.structuredContent.headers.etag, '"1"')
      assert.deepEqual(JSON.parse(created.result.content[0].text), created.result.structuredContent)
      groupId = created.result.structuredContent.data.data.id
      const replay = await mcp.call(writer.access_token, "erp_post_tag_groups", { tenant_id: ctx.tenant, headers: { "Idempotency-Key": key }, body })
      assert.equal(replay.result.structuredContent.headers["idempotency-replayed"], "true")
      assert.equal(replay.result.structuredContent.data.data.id, groupId)
      const reused = await mcp.call(writer.access_token, "erp_post_tag_groups", { tenant_id: ctx.tenant, headers: { "Idempotency-Key": key }, body: { ...body, name: "Outro" } })
      assert.equal(reused.result.isError, true)
      assert.equal(reused.result.structuredContent.status, 409)
      const stale = await mcp.call(writer.access_token, "erp_put_tag_groups__id_", { tenant_id: ctx.tenant, path: { id: groupId }, headers: { "If-Match": '"9"', "Idempotency-Key": randomUUID() }, body })
      assert.equal(stale.result.structuredContent.status, 412)
      assert.equal(stale.result.isError, true)
      const invalid = await mcp.call(writer.access_token, "erp_post_tag_groups", { tenant_id: ctx.tenant, headers: { "Idempotency-Key": randomUUID() }, body: { code: "" } })
      assert.equal(invalid.result.structuredContent.status, 422)
      const updated = await mcp.call(writer.access_token, "erp_put_tag_groups__id_", { tenant_id: ctx.tenant, path: { id: groupId }, headers: { "If-Match": '"1"', "Idempotency-Key": randomUUID() }, body: { ...body, name: "Renomeado" } })
      assert.equal(updated.result.structuredContent.status, 200, JSON.stringify(updated))
      const audit = await ctx.seed.query("SELECT i.auth_subject FROM audit_log a JOIN identities i ON i.id=a.identity_id WHERE a.entity_id=$1 ORDER BY a.occurred_at, a.action DESC", [groupId])
      assert.deepEqual(audit.rows.map(row => row.auth_subject), ["user", "user"], "a auditoria registra a identidade do consentimento")
      const read = await mcp.call(reader.access_token, "erp_get_tag_groups__id_", { tenant_id: ctx.tenant, path: { id: groupId } })
      assert.equal(read.result.isError, false)
      assert.equal(read.result.structuredContent.data.data.name, "Renomeado")
      const listed = await mcp.call(reader.access_token, "erp_get_tag_groups", { tenant_id: ctx.tenant, query: { q: "renomeado", limit: 10 } })
      assert.equal(listed.result.structuredContent.data.total, 1)
    })

    await t.test("POST /mcp [negado] escopo insuficiente, permissão do ERP, outra empresa e argumentos inválidos", async () => {
      const body = { code: "NEG", name: "Negado", status: "active" }
      const scope = await mcp.call(reader.access_token, "erp_post_tag_groups", { tenant_id: ctx.tenant, headers: { "Idempotency-Key": randomUUID() }, body })
      assert.deepEqual(scope.result.structuredContent, { status: 403, error: "insufficient_scope" })
      assert.equal(scope.result.isError, true)
      const permission = await mcp.call(denied.access_token, "erp_get_tag_groups", { tenant_id: ctx.tenant })
      assert.equal(permission.result.structuredContent.status, 403, "o escopo não concede papéis no ERP")
      const foreign = await mcp.call(outsider.access_token, "erp_get_tag_groups__id_", { tenant_id: ctx.tenant, path: { id: groupId } })
      assert.equal(foreign.result.structuredContent.status, 403, "outra empresa não lê dados da empresa A")
      const own = await mcp.call(outsider.access_token, "erp_get_tag_groups", { tenant_id: ctx.otherTenant })
      assert.equal(own.result.structuredContent.status, 200)
      assert.equal(own.result.structuredContent.data.total, 0, "a empresa B não enxerga o grupo da empresa A")
      const missing = await mcp.call(outsider.access_token, "erp_get_tag_groups__id_", { tenant_id: ctx.otherTenant, path: { id: groupId } })
      assert.equal(missing.result.structuredContent.status, 404)
      const invalid: [string, unknown, string][] = [
        ["erp_get_tag_groups", { tenant_id: ctx.tenant, extra: 1 }, "Argumento desconhecido"],
        ["erp_get_tag_groups", {}, "Argumento obrigatório ausente"],
        ["erp_get_tag_groups", { tenant_id: "nao-uuid" }, "Empresa inválida"],
        ["erp_get_tag_groups", [], "Argumentos precisam ser um objeto"],
        ["erp_get_tag_groups__id_", { tenant_id: ctx.tenant, path: { id: ".." } }, "Parâmetro de caminho inválido"],
        ["erp_get_tag_groups__id_", { tenant_id: ctx.tenant, path: { id: { x: 1 } } }, "Parâmetro precisa ser um valor escalar"],
        ["erp_put_tag_groups__id_", { tenant_id: ctx.tenant, path: { id: groupId }, headers: { Authorization: "Bearer x" } }, "Cabeçalho não autorizado"],
        ["erp_put_tag_groups__id_", { tenant_id: ctx.tenant, path: { id: groupId }, headers: { "X-Tenant-Id": ctx.otherTenant } }, "Use tenant_id para selecionar a empresa"],
        ["erp_get_tag_groups", { tenant_id: ctx.tenant, body: {} }, "Argumento desconhecido"],
        ["erp_inexistente", {}, "Unknown tool"],
      ]
      for (const [name, args, message] of invalid) {
        const response = await mcp.call(writer.access_token, name, args)
        assert.deepEqual(response.error, { code: -32602, message }, `${name} ${JSON.stringify(args)}`)
      }
      const encoded = await mcp.call(writer.access_token, "erp_get_tag_groups__id_", { tenant_id: ctx.tenant, path: { id: "../../me" } })
      assert.equal(encoded.result.structuredContent.status, 404, "o caminho é codificado e não muda o destino")
      assert.deepEqual((await mcp.rpc(writer.access_token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).json(), { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Missing tool name" } })
    })

    await t.test("POST /mcp/oauth/revoke [sucesso] revoga a concessão e os tokens emitidos", async () => {
      const session = await mcp.connect("user")
      ok(await mcp.rpc(session.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }), 200)
      ok(await mcp.revoke({ client_id: session.clientId, token: session.refresh_token }), 200)
      ok(await mcp.rpc(session.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }), 401)
      ok(await mcp.token({ grant_type: "refresh_token", client_id: session.clientId, refresh_token: session.refresh_token, resource }), 400)
      ok(await mcp.revoke({ client_id: session.clientId, token: "mcp_at_desconhecido" }), 200)
    })

    await t.test("POST /mcp/oauth/revoke [negado] cliente inválido ou de outra concessão e token ausente", async () => {
      const session = await mcp.connect("user"), other = await mcp.connect("user")
      assert.deepEqual(ok(await mcp.revoke({ client_id: session.clientId }), 400).json(), { error: "invalid_request" })
      assert.deepEqual(ok(await mcp.revoke({ client_id: session.clientId, client_secret: "x", token: session.access_token }), 401).json(), { error: "invalid_client" })
      ok(await mcp.revoke({ client_id: other.clientId, token: session.access_token }), 200)
      ok(await mcp.rpc(session.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }), 200, )
      ok(await ctx.app.inject({ method: "POST", url: "/mcp/oauth/revoke", headers: { "content-type": "application/json" }, payload: "{}" }), 415)
    })
  } finally { await ctx.close() }
})
