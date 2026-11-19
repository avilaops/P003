// OAuth 2.1 issuer for the remote MCP (port of apps/api/src/mcp/oauth.rs).
// Auth Ávila credentials are never downstream tokens: the ERP issues its own
// opaque MCP tokens bound to the exact resource and stores only their hashes.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import type { FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authenticateRequest } from "../../platform/access.js"
import type { DatabaseClient, DatabasePool } from "../../platform/database.js"

export const scopesSupported = ["erp.read", "erp.write"] as const
export type McpCredential = { subject: string; email: string; name: string; verified_email: boolean; scope: string }

/** Answer in the OAuth error format (RFC 6749 §5.2), never as problem+json. */
export class OAuthFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
const failure = (status: number, code: string) => new OAuthFailure(status, code)
const invalidGrant = () => failure(400, "invalid_grant")

export const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const random = (prefix: string) => prefix + randomBytes(32).toString("base64url")
// Compare digests so neither length nor content leaks through timing.
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest())
const bytes = (value: string) => Buffer.byteLength(value)

async function transaction<T>(pool: DatabasePool, operation: (client: DatabaseClient) => Promise<T>): Promise<T> {
  let client: DatabaseClient
  try { client = await pool.connect() } catch { throw failure(503, "temporarily_unavailable") }
  try {
    await client.query("BEGIN")
    const result = await operation(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    try { await client.query("ROLLBACK") } catch { /* Preserve the original failure. */ }
    if (error instanceof OAuthFailure) throw error
    throw failure(503, "temporarily_unavailable")
  } finally { client.release() }
}

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"])
function validRedirect(value: string) {
  // A trailing "#" has an empty WHATWG hash but is still a fragment (RFC 6749 §3.1.2).
  if (bytes(value) > 1024 || value.includes("*") || value.includes("#") || /\p{Cc}/u.test(value)) return false
  let url: URL
  try { url = new URL(value) } catch { return false }
  return Boolean(url.hostname) && !url.username && !url.password &&
    (url.protocol === "https:" || url.protocol === "http:" && loopback.has(url.hostname))
}

const registrationSchema = z.object({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().nullish(),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).nullish(),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).nullish(),
  response_types: z.array(z.literal("code")).nullish(),
}).loose()

export async function register(dependencies: AppDependencies, input: unknown) {
  const parsed = registrationSchema.safeParse(input)
  if (!parsed.success || parsed.data.redirect_uris.some(uri => !validRedirect(uri))) throw failure(400, "invalid_client_metadata")
  const method = parsed.data.token_endpoint_auth_method ?? "none"
  const name = parsed.data.client_name ?? "Cliente MCP"
  if (!name || bytes(name) > 200) throw failure(400, "invalid_client_metadata")
  const id = random("mcp_client_"), secret = method === "none" ? undefined : random("mcp_secret_")
  await transaction(dependencies.pool, async client => {
    // Serialize the issuer-wide registration quota; client-controlled proxy headers are not trusted.
    await client.query("SELECT pg_advisory_xact_lock(697241068)")
    const recent = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM mcp_oauth_clients WHERE created_at>now()-interval '1 hour'")
    if (Number(recent.rows[0]?.count ?? 0) >= 200) throw failure(429, "registration_limit")
    await client.query("INSERT INTO mcp_oauth_clients(id,name,redirects,auth_method,secret_hash) VALUES($1,$2,$3::jsonb,$4,$5)",
      [id, name, JSON.stringify(parsed.data.redirect_uris), method, secret === undefined ? null : hash(secret)])
  })
  return {
    client_id: id, client_name: name, redirect_uris: parsed.data.redirect_uris, token_endpoint_auth_method: method,
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: scopesSupported.join(" "),
    ...(secret === undefined ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
  }
}

const authorizationSchema = z.object({
  client_id: z.string(), redirect_uri: z.string(), response_type: z.string(),
  code_challenge: z.string(), code_challenge_method: z.string(),
  scope: z.string().nullish(), resource: z.string(), state: z.string().nullish(),
}).loose()
type Authorization = z.infer<typeof authorizationSchema>
type Client = { name: string; redirects: unknown; auth_method: string; secret_hash: string | null }

async function findClient(pool: DatabasePool, id: string): Promise<Client> {
  if (bytes(id) > 100) throw failure(400, "invalid_client")
  const row = await transaction(pool, async client => (await client.query<Client>("SELECT name,redirects,auth_method,secret_hash FROM mcp_oauth_clients WHERE id=$1", [id])).rows[0])
  if (!row) throw failure(400, "invalid_client")
  return row
}

function scopes(value: string | null | undefined) {
  const items = [...new Set((value ?? scopesSupported.join(" ")).split(/\s+/).filter(Boolean))].sort()
  if (!items.length || items.some(item => !(scopesSupported as readonly string[]).includes(item))) throw failure(400, "invalid_scope")
  return items.join(" ")
}

async function validate(dependencies: AppDependencies, resource: string, raw: unknown): Promise<{ input: Authorization; client: Client; scope: string }> {
  const parsed = authorizationSchema.safeParse(raw)
  if (!parsed.success) throw failure(400, "invalid_request")
  const input = parsed.data
  if (input.response_type !== "code" || input.resource !== resource || bytes(input.state ?? "") > 512 ||
      input.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge)) throw failure(400, "invalid_request")
  const client = await findClient(dependencies.pool, input.client_id)
  if (!Array.isArray(client.redirects) || !client.redirects.includes(input.redirect_uri)) throw failure(400, "invalid_redirect_uri")
  return { input, client, scope: scopes(input.scope) }
}

/** Single-valued query parameters; repeated ones are ambiguous and rejected. */
export function singleValues(query: unknown) {
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (typeof value !== "string") throw failure(400, "invalid_request")
    values[key] = value
  }
  return values
}

export async function describeAuthorization(dependencies: AppDependencies, resource: string, query: unknown) {
  const { input, client, scope } = await validate(dependencies, resource, singleValues(query))
  return { client_name: client.name, redirect_uri: input.redirect_uri, scope }
}

export async function grant(request: FastifyRequest, dependencies: AppDependencies, resource: string) {
  // The consent screen sends the user's Auth Ávila session; it is never stored or forwarded.
  const identity = await authenticateRequest(request, dependencies)
  const { input, scope } = await validate(dependencies, resource, request.body)
  const id = randomUUID(), code = random("mcp_code_")
  await transaction(dependencies.pool, async client => {
    await client.query("INSERT INTO mcp_oauth_grants(id,client_id,subject,email,name,verified_email,scope,resource) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, input.client_id, identity.subject, identity.email, identity.name, identity.emailVerified, scope, resource])
    await client.query("INSERT INTO mcp_oauth_codes(hash,grant_id,redirect_uri,challenge) VALUES($1,$2,$3,$4)", [hash(code), id, input.redirect_uri, input.code_challenge])
  })
  const redirect = new URL(input.redirect_uri)
  redirect.searchParams.append("code", code)
  if (input.state !== undefined && input.state !== null) redirect.searchParams.append("state", input.state)
  return { redirect_uri: redirect.href }
}

/** Token and revocation requests are form encoded; every parameter appears at most once (RFC 6749 §3.2). */
export function readForm(request: FastifyRequest) {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") throw failure(415, "invalid_request")
  const form = new URLSearchParams(Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "")
  const values: Record<string, string> = {}
  for (const [key, value] of form) {
    if (key in values) throw failure(400, "invalid_request")
    values[key] = value
  }
  return values
}

const formDecode = (value: string) => new URLSearchParams(`v=${value}`).get("v") ?? ""

async function authenticateClient(pool: DatabasePool, authorization: string | undefined, input: Record<string, string>) {
  const invalidClient = () => failure(401, "invalid_client")
  let id = input.client_id ?? "", secret = input.client_secret, basic = false
  if (authorization !== undefined) {
    if (secret !== undefined || !authorization.startsWith("Basic ")) throw invalidClient()
    const encoded = authorization.slice(6)
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalidClient()
    const decoded = Buffer.from(encoded, "base64")
    const text = new TextDecoder("utf-8", { fatal: true })
    let pair: string
    try { pair = text.decode(decoded) } catch { throw invalidClient() }
    const separator = pair.indexOf(":")
    if (separator < 0) throw invalidClient()
    const basicId = formDecode(pair.slice(0, separator))
    if (id && id !== basicId) throw invalidClient()
    id = basicId
    secret = formDecode(pair.slice(separator + 1))
    basic = true
  }
  const client = await findClient(pool, id)
  const secretMatches = secret !== undefined && client.secret_hash !== null && same(hash(secret), client.secret_hash)
  const valid = client.auth_method === "none" ? secret === undefined && !basic
    : client.auth_method === "client_secret_basic" ? basic && secretMatches
    : client.auth_method === "client_secret_post" ? !basic && secretMatches : false
  if (!valid) throw invalidClient()
  return id
}

async function issue(client: DatabaseClient, grantId: string, scope: string) {
  const access = random("mcp_at_"), refresh = random("mcp_rt_")
  await client.query("INSERT INTO mcp_oauth_tokens(hash,grant_id,kind,expires_at) SELECT $1,id,'access',LEAST(expires_at,now()+interval '15 minutes') FROM mcp_oauth_grants WHERE id=$3 UNION ALL SELECT $2,id,'refresh',expires_at FROM mcp_oauth_grants WHERE id=$3",
    [hash(access), hash(refresh), grantId])
  return { access_token: access, token_type: "Bearer", expires_in: 900, refresh_token: refresh, scope }
}

export async function token(dependencies: AppDependencies, resource: string, authorization: string | undefined, input: Record<string, string>) {
  if (input.resource !== resource) throw failure(400, "invalid_target")
  const clientId = await authenticateClient(dependencies.pool, authorization, input)
  let reused = false
  const issued = await transaction(dependencies.pool, async client => {
    if (input.grant_type === "authorization_code") {
      const verifier = input.code_verifier, code = input.code
      if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !code || bytes(code) >= 200) throw invalidGrant()
      const row = (await client.query<{ id: string; scope: string; redirect_uri: string; challenge: string }>(
        "SELECT g.id,g.scope,c.redirect_uri,c.challenge FROM mcp_oauth_codes c JOIN mcp_oauth_grants g ON g.id=c.grant_id WHERE c.hash=$1 AND g.client_id=$2 AND g.resource=$3 AND c.consumed_at IS NULL AND c.expires_at>now() AND g.revoked_at IS NULL AND g.expires_at>now() FOR UPDATE OF c,g",
        [hash(code), clientId, resource])).rows[0]
      if (!row || input.redirect_uri !== row.redirect_uri || !same(createHash("sha256").update(verifier).digest("base64url"), row.challenge)) throw invalidGrant()
      await client.query("UPDATE mcp_oauth_codes SET consumed_at=now() WHERE hash=$1", [hash(code)])
      return issue(client, row.id, row.scope)
    }
    if (input.grant_type === "refresh_token") {
      const refresh = input.refresh_token
      if (!refresh || bytes(refresh) >= 200) throw invalidGrant()
      const row = (await client.query<{ id: string; scope: string; consumed: boolean }>(
        "SELECT g.id,g.scope,t.consumed_at IS NOT NULL AS consumed FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id=t.grant_id WHERE t.hash=$1 AND t.kind='refresh' AND g.client_id=$2 AND g.resource=$3 AND t.expires_at>now() AND g.revoked_at IS NULL AND g.expires_at>now() FOR UPDATE OF t,g",
        [hash(refresh), clientId, resource])).rows[0]
      if (!row) throw invalidGrant()
      if (row.consumed) {
        // Reuse of a rotated refresh token revokes the whole grant, committed before answering.
        await client.query("UPDATE mcp_oauth_grants SET revoked_at=now() WHERE id=$1", [row.id])
        reused = true
        return undefined
      }
      if (input.scope !== undefined && input.scope !== row.scope) throw failure(400, "invalid_scope")
      await client.query("UPDATE mcp_oauth_tokens SET consumed_at=now() WHERE hash=$1", [hash(refresh)])
      return issue(client, row.id, row.scope)
    }
    throw failure(400, "unsupported_grant_type")
  })
  if (reused || !issued) throw invalidGrant()
  return issued
}

export async function revoke(dependencies: AppDependencies, authorization: string | undefined, input: Record<string, string>) {
  const clientId = await authenticateClient(dependencies.pool, authorization, input)
  const value = input.token
  if (!value || bytes(value) >= 200) throw failure(400, "invalid_request")
  // Unknown or foreign tokens still answer 200 (RFC 7009 §2.2): nothing about them is disclosed.
  await transaction(dependencies.pool, client => client.query("UPDATE mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE client_id=$1 AND id IN (SELECT grant_id FROM mcp_oauth_tokens WHERE hash=$2)", [clientId, hash(value)]))
}

/** Reads the grant behind an MCP access token. Throws 401 `invalid_token` for anything else. */
export async function readCredential(pool: DatabasePool, resource: string, authorization: string | string[] | undefined): Promise<McpCredential> {
  const invalid = () => failure(401, "invalid_token")
  if (typeof authorization !== "string") throw invalid()
  const separator = authorization.indexOf(" ")
  const value = authorization.slice(separator + 1).trim()
  if (separator < 0 || authorization.slice(0, separator).toLowerCase() !== "bearer" || !value.startsWith("mcp_at_") || bytes(value) >= 200) throw invalid()
  const row = await transaction(pool, async client => (await client.query<McpCredential>(
    "SELECT g.subject,g.email,g.name,g.verified_email,g.scope FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id=t.grant_id WHERE t.hash=$1 AND t.kind='access' AND t.expires_at>now() AND g.resource=$2 AND g.revoked_at IS NULL AND g.expires_at>now()",
    [hash(value), resource])).rows[0])
  if (!row) throw invalid()
  return row
}

export function sendOAuthFailure(reply: FastifyReply, error: OAuthFailure) {
  return reply.code(error.status).header("cache-control", "no-store").send({ error: error.code })
}
