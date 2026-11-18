import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import type { AuthenticatedIdentity } from "../../platform/auth.js"
import { databaseId } from "../../platform/database-id.js"
import { parseJson, stringifyJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { runWithMcpIdentity } from "../../platform/request-identity.js"

type Grant = { subject: string; email: string; name: string; verified_email: boolean; scope: string }
type GrantReader = (authorization: string | string[] | undefined) => Promise<Grant>
const rpcCall = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.bigint(), z.null()]),
  method: z.literal("tools/call"),
  params: z.object({ name: z.string(), arguments: z.unknown() }),
})
const queryField = z.union([z.string(), z.number().int()])
const readArgs = z.strictObject({
  tenant_id: databaseId,
  query: z.record(z.string(), queryField).optional(),
})
const writeArgs = z.strictObject({
  tenant_id: databaseId,
  headers: z.strictObject({ "Idempotency-Key": z.string().max(100) }),
  body: z.record(z.string(), z.unknown()),
})
const routes = new Map<string, { method: "GET" | "POST"; resource: string }>([
  ["erp_get_stock", { method: "GET", resource: "/api/v1/stock" }],
  ["erp_get_stock_movements", { method: "GET", resource: "/api/v1/stock/movements" }],
  ["erp_post_stock_movements", { method: "POST", resource: "/api/v1/stock/movements" }],
])

function result(id: unknown, payload: Record<string, unknown>, isError: boolean) {
  return { jsonrpc: "2.0", id, result: { isError, content: [{ type: "text", text: stringifyJson(payload) }], structuredContent: payload } }
}

function invalid(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

export function registerInventoryMcp(app: FastifyInstance, resource: string, readGrant: GrantReader) {
  const origin = new URL(resource).origin
  const allowedOrigins = new Set([origin, "https://chatgpt.com", "https://chat.openai.com", "https://claude.ai", "https://claude.com",
    ...(process.env.ERP_MCP_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean)])
  const grants = new WeakMap<FastifyRequest, Grant>()
  app.post("/internal/mcp/inventory", {
    bodyLimit: 2_097_152,
    onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff")
      const clientOrigin = request.headers.origin
      if (clientOrigin !== undefined) {
        if (!allowedOrigins.has(clientOrigin)) return reply.code(403).send()
        reply.header("access-control-allow-origin", clientOrigin).header("vary", "Origin")
        reply.header("access-control-expose-headers", "WWW-Authenticate, MCP-Protocol-Version, X-Request-Id")
      }
      try { grants.set(request, await readGrant(request.headers.authorization)) }
      catch (error) {
        if (!(error instanceof Problem) || error.status !== 401) throw error
        return reply.code(401).header("www-authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`).send({ error: "invalid_token" })
      }
      const version = request.headers["mcp-protocol-version"]
      if (version !== undefined && !["2025-11-25", "2025-06-18", "2025-03-26"].includes(String(version))) return reply.code(400).send()
    },
  }, async request => {
    const message = rpcCall.safeParse(request.body)
    if (!message.success) return invalid(null, -32600, "Invalid Request")
    const { id, params } = message.data
    const route = routes.get(params.name)
    if (!route) return invalid(id, -32602, "Unknown tool")
    const grant = grants.get(request)!
    const isWrite = route.method === "POST"
    if (!grant.scope.split(/\s+/).includes(isWrite ? "erp.write" : "erp.read")) return result(id, { status: 403, error: "insufficient_scope" }, true)
    const args = isWrite ? writeArgs.safeParse(params.arguments) : readArgs.safeParse(params.arguments)
    if (!args.success) return invalid(id, -32602, "Argumentos da consulta ou lançamento inválidos")
    const { tenant_id: tenantId } = args.data
    const headers: Record<string, string> = { "x-tenant-id": tenantId }
    if (typeof request.headers["x-request-id"] === "string") headers["x-request-id"] = request.headers["x-request-id"]
    const query = new URLSearchParams()
    let body: string | undefined
    if ("headers" in args.data) {
      headers["idempotency-key"] = args.data.headers["Idempotency-Key"]
      headers["content-type"] = "application/json"
      body = stringifyJson(args.data.body)
    } else {
      for (const [name, value] of Object.entries(args.data.query ?? {})) query.set(name, String(value))
    }
    const identity: AuthenticatedIdentity = { subject: grant.subject, email: grant.email, name: grant.name, emailVerified: grant.verified_email }
    const response = await runWithMcpIdentity(identity, () => app.inject({
      method: route.method, url: route.resource + (query.size ? `?${query}` : ""), headers, ...(body === undefined ? {} : { payload: body }),
    }))
    const responseHeaders: Record<string, unknown> = {}
    for (const key of ["content-type", "x-request-id", "etag", "idempotency-replayed", "x-erp-backend", "retry-after"]) {
      if (response.headers[key] !== undefined) responseHeaders[key] = response.headers[key]
    }
    return result(id, { status: response.statusCode, headers: responseHeaders, data: response.body ? parseJson(response.body) : null }, response.statusCode >= 400)
  })
}
