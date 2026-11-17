import { createHash } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../app.js"
import type { AuthenticatedIdentity } from "./auth.js"
import { Problem } from "./problem.js"
import { runWithMcpIdentity } from "./request-identity.js"

type Credential = { subject: string; email: string; name: string; verified_email: boolean; scope: string }
const allowedHeaders = new Set(["x-tenant-id", "if-match", "idempotency-key", "content-type", "accept", "x-request-id"])
const responseHeaders = ["content-type", "cache-control", "etag", "retry-after", "content-disposition", "location", "x-request-id", "x-erp-backend", "idempotency-replayed"]
const inputSchema = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  resource: z.string().max(8192),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
})

async function credential(authorization: string | string[] | undefined, dependencies: AppDependencies): Promise<Credential> {
  const invalid = () => new Problem(401, "invalid_token", "Credencial MCP inválida")
  if (typeof authorization !== "string") throw invalid()
  const separator = authorization.indexOf(" ")
  const token = authorization.slice(separator + 1).trim()
  if (separator < 0 || authorization.slice(0, separator).toLowerCase() !== "bearer" || !token.startsWith("mcp_at_") || Buffer.byteLength(token) >= 200) throw invalid()
  const client = await dependencies.pool.connect()
  try {
    const result = await client.query<Credential>("SELECT g.subject,g.email,g.name,g.verified_email,g.scope FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id=t.grant_id WHERE t.hash=$1 AND t.kind='access' AND t.expires_at>now() AND g.resource=$2 AND g.revoked_at IS NULL AND g.expires_at>now()", [createHash("sha256").update(token).digest("hex"), dependencies.mcpResource])
    if (!result.rows[0]) throw invalid()
    return result.rows[0]
  } finally { client.release() }
}

export function registerMcpDispatch(app: FastifyInstance, dependencies: AppDependencies) {
  if (!dependencies.mcpResource) return
  const credentials = new WeakMap<object, Credential>()
  app.post("/internal/mcp/dispatch", {
    // A product body can contain an inline photo. Its existing inner route
    // limit still applies after decoding; this bounds the base64 envelope.
    bodyLimit: 3_000_000,
    onRequest: async request => { credentials.set(request, await credential(request.headers.authorization, dependencies)) },
  }, async (request, reply) => {
    const grant = credentials.get(request)!
    const parsed = inputSchema.safeParse(request.body)
    if (!parsed.success) throw new Problem(422, "invalid_input", "Despacho MCP inválido")
    const input = parsed.data
    const scope = input.method === "GET" ? "erp.read" : "erp.write"
    if (!grant.scope.split(/\s+/).includes(scope)) throw new Problem(403, "insufficient_scope", "Escopo MCP insuficiente")

    let url: URL
    try { url = new URL(input.resource, "http://erp.internal") }
    catch { throw new Problem(422, "invalid_input", "Recurso MCP inválido") }
    if (!input.resource.startsWith("/api/v1/") || url.origin !== "http://erp.internal" || url.hash || url.pathname !== input.resource.split("?")[0]) {
      throw new Problem(422, "invalid_input", "Recurso MCP inválido")
    }
    if (!app.hasRoute({ method: input.method, url: url.pathname })) throw new Problem(404, "not_found", "Operação não migrada")
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(input.headers)) {
      const key = name.toLowerCase()
      if (!allowedHeaders.has(key) || key in headers || /[\r\n]/.test(value)) throw new Problem(422, "invalid_input", "Cabeçalho MCP inválido")
      headers[key] = value
    }
    headers["x-request-id"] ??= String(request.headers["x-request-id"])
    const body = input.body === undefined ? undefined : Buffer.from(input.body, "base64")
    if (body && (body.toString("base64") !== input.body || body.length > 2_097_152 || input.method === "GET" && body.length > 0)) {
      throw new Problem(422, "invalid_input", "Corpo MCP inválido")
    }
    const identity: AuthenticatedIdentity = { subject: grant.subject, email: grant.email, name: grant.name, emailVerified: grant.verified_email }
    const response = await runWithMcpIdentity(identity, () => app.inject({ method: input.method, url: input.resource, headers, ...(body === undefined ? {} : { payload: body }) }))
    for (const name of responseHeaders) {
      const value = response.headers[name]
      if (value !== undefined) reply.header(name, value)
    }
    return reply.code(response.statusCode).send(response.rawPayload)
  })
}
