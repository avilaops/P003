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
const argumentsSchema = z.strictObject({
  tenant_id: databaseId, path:z.strictObject({id:databaseId,movement:databaseId.optional()}).optional(),
  query:z.record(z.string(),queryField).optional(), body:z.record(z.string(),z.unknown()).optional(),
  headers:z.strictObject({"Idempotency-Key":z.string().max(100).optional(),"If-Match":z.string().max(100).optional()}).optional(),
})
type ToolRoute = {method:"GET"|"POST"|"PUT";resource:string;query?:boolean;key?:boolean;revision?:true|"optional";body?:boolean}
const routes = new Map<string, ToolRoute>([
  ["erp_get_orders__id__cancellations",{method:"GET",resource:"/api/v1/orders/:id/cancellations"}],
  ["erp_post_orders__id__cancel_completed",{method:"POST",resource:"/api/v1/orders/:id/cancel-completed",key:true,revision:true,body:true}],
  ["erp_get_production_orders",{method:"GET",resource:"/api/v1/production/orders",query:true}],
  ["erp_get_production_orders__id",{method:"GET",resource:"/api/v1/production/orders/:id"}],
  ["erp_get_production_stages",{method:"GET",resource:"/api/v1/production/stages"}],
  ["erp_post_production_orders",{method:"POST",resource:"/api/v1/production/orders",key:true,revision:true,body:true}],
  ["erp_post_production_orders__id__stage",{method:"POST",resource:"/api/v1/production/orders/:id/stage",key:true,revision:true,body:true}],
  ["erp_post_production_orders__id__consumptions",{method:"POST",resource:"/api/v1/production/orders/:id/consumptions",key:true,revision:true,body:true}],
  ["erp_post_production_orders__id__consumptions__movement__reverse",{method:"POST",resource:"/api/v1/production/orders/:id/consumptions/:movement/reverse",key:true,revision:true,body:true}],
  ["erp_post_production_stages",{method:"POST",resource:"/api/v1/production/stages",key:true,body:true}],
  ["erp_put_production_stages__id",{method:"PUT",resource:"/api/v1/production/stages/:id",key:true,revision:true,body:true}],
  ["erp_get_stock", { method: "GET", resource: "/api/v1/stock",query:true }],
  ["erp_get_stock_movements", { method: "GET", resource: "/api/v1/stock/movements",query:true }],
  ["erp_post_stock_movements", { method: "POST", resource: "/api/v1/stock/movements",key:true,body:true }],
  ["erp_get_warehouses",{method:"GET",resource:"/api/v1/warehouses",query:true}],
  ["erp_get_warehouses__id",{method:"GET",resource:"/api/v1/warehouses/:id"}],
  ["erp_post_warehouses",{method:"POST",resource:"/api/v1/warehouses",key:true,body:true}],
  ["erp_put_warehouses__id",{method:"PUT",resource:"/api/v1/warehouses/:id",key:true,revision:true,body:true}],
  ["erp_get_inventory_settings",{method:"GET",resource:"/api/v1/inventory-settings"}],
  ["erp_put_inventory_settings",{method:"PUT",resource:"/api/v1/inventory-settings",revision:true,body:true}],
  ["erp_get_inventory_counts",{method:"GET",resource:"/api/v1/inventory-counts",query:true}],
  ["erp_get_inventory_counts__id",{method:"GET",resource:"/api/v1/inventory-counts/:id"}],
  ["erp_post_inventory_counts",{method:"POST",resource:"/api/v1/inventory-counts",key:true,body:true}],
  ["erp_post_inventory_counts__id__lines",{method:"POST",resource:"/api/v1/inventory-counts/:id/lines",key:true,revision:"optional",body:true}],
  ["erp_post_inventory_counts__id__approve",{method:"POST",resource:"/api/v1/inventory-counts/:id/approve",key:true,revision:"optional"}],
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
    const isWrite = route.method !== "GET"
    if (!grant.scope.split(/\s+/).includes(isWrite ? "erp.write" : "erp.read")) return result(id, { status: 403, error: "insufficient_scope" }, true)
    const args = argumentsSchema.safeParse(params.arguments)
    if (!args.success) return invalid(id, -32602, "Argumentos da consulta ou lançamento inválidos")
    const {tenant_id:tenantId,path,query:filters,headers:requestedHeaders,body:input} = args.data
    if (Boolean(path)!==route.resource.includes(":id") || Boolean(path?.movement)!==route.resource.includes(":movement") || Boolean(filters)&&!route.query ||
        Boolean(requestedHeaders)!==Boolean(route.key||route.revision) ||
        route.revision!=="optional" && Boolean(requestedHeaders?.["If-Match"])!==Boolean(route.revision) ||
        Boolean(requestedHeaders?.["Idempotency-Key"])!==Boolean(route.key) || (input!==undefined)!==Boolean(route.body))
      return invalid(id,-32602,"Argumentos incompatíveis com a operação")
    const headers: Record<string, string> = { "x-tenant-id": tenantId }
    if (typeof request.headers["x-request-id"] === "string") headers["x-request-id"] = request.headers["x-request-id"]
    const query = new URLSearchParams()
    for (const [name,value] of Object.entries(filters??{})) query.set(name,String(value))
    for (const [name,value] of Object.entries(requestedHeaders??{})) if(value) headers[name.toLowerCase()]=value
    const body = input===undefined ? undefined : stringifyJson(input)
    if(body!==undefined) headers["content-type"]="application/json"
    const resourcePath=path ? route.resource.replace(":id",path.id).replace(":movement",path.movement??"") : route.resource
    const identity: AuthenticatedIdentity = { subject: grant.subject, email: grant.email, name: grant.name, emailVerified: grant.verified_email }
    const response = await runWithMcpIdentity(identity, () => app.inject({
      method: route.method, url: resourcePath + (query.size ? `?${query}` : ""), headers, ...(body === undefined ? {} : { payload: body }),
    }))
    const responseHeaders: Record<string, unknown> = {}
    for (const key of ["content-type", "x-request-id", "etag", "idempotency-replayed", "x-erp-backend", "retry-after"]) {
      if (response.headers[key] !== undefined) responseHeaders[key] = response.headers[key]
    }
    return result(id, { status: response.statusCode, headers: responseHeaders, data: response.body ? parseJson(response.body) : null }, response.statusCode >= 400)
  })
}
