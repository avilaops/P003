// One typed MCP tool per user-authenticated /api/v1 operation (port of apps/api/src/mcp/catalog.rs).
// The catalog derives from the same OpenAPI contract the api-ts publishes, so a
// newly registered route becomes a tool without a second list to maintain.
import { createHash } from "node:crypto"
import type { FastifyInstance } from "fastify"

import { stringifyJson } from "../../platform/json.js"
import { buildOpenApiDocument } from "../../platform/openapi.js"
import { channelServiceRoute } from "../commercial/channel-service.js"

type Json = Record<string, unknown>
type Parameter = { name: string; in: string; required?: boolean; schema?: Json; explode?: boolean }
export type Tool = {
  name: string
  method: string
  path: string
  readOnly: boolean
  definition: Json
  parameters: Parameter[]
  body: boolean
  bodyRequired: boolean
  openQuery: boolean
}

export class ToolArgumentError extends Error {}
const reject = (message: string): never => { throw new ToolArgumentError(message) }

// The ERP router is tenant scoped except these identity operations.
const untenanted = new Set(["/api/v1/companies", "/api/v1/company-registration/lookup"])
const forbiddenHeaders = new Set(["authorization", "cookie", "host"])
// Preconditions the business routes read. The TS contract does not list header
// parameters, so every write declares them; routes still decide if they are required.
const writeHeaders = { "If-Match": { type: "string", maxLength: 200 }, "Idempotency-Key": { type: "string", maxLength: 200 } }
const scalar = { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] }

/** Routes reachable by an end user. Webhooks, channel integrations and service routes are not tools. */
function userOperation(method: string, path: string, operation: Json) {
  const fastifyPath = path.replace(/\{(\w+)\}/g, ":$1")
  return Array.isArray(operation.security) && operation.security.some(item => typeof item === "object" && item !== null && "bearerAuth" in item) &&
    !path.startsWith("/api/v1/integrations/") && !path.startsWith("/api/v1/webhooks/") && !channelServiceRoute(method.toUpperCase(), fastifyPath)
}

/** Embedded zod schemas may carry local `$defs`; lift them to the tool root so `#/$defs/x` resolves. */
function hoist(schema: Json, definitions: Json) {
  const { $defs, ...rest } = schema
  if ($defs && typeof $defs === "object") Object.assign(definitions, $defs)
  return rest
}

export function toolName(method: string, path: string) {
  const slug = `erp_${method}_${path.replace(/^\/api\/v1\//, "")}`.replace(/[^A-Za-z0-9]/g, "_")
  return slug.length > 64 ? `${slug.slice(0, 51)}_${createHash("sha256").update(`${method}:${path}`).digest("hex").slice(0, 12)}` : slug
}

export function buildCatalog(app: FastifyInstance): Tool[] {
  const document = buildOpenApiDocument(app) as { paths: Record<string, Record<string, Json>> }
  const tools: Tool[] = []
  for (const [path, item] of Object.entries(document.paths)) {
    if (!path.startsWith("/api/v1/")) continue
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = item[method]
      if (!operation || !userOperation(method, path, operation)) continue
      const parameters = (operation.parameters as Parameter[] | undefined) ?? []
      const properties: Json = {}, required: string[] = [], definitions: Json = {}
      if (!untenanted.has(path)) {
        properties.tenant_id = { type: "string", format: "uuid", description: "Empresa explícita, verificada pelas regras de acesso do ERP." }
        required.push("tenant_id")
      }
      const pathFields = parameters.filter(parameter => parameter.in === "path")
      if (pathFields.length) {
        properties.path = { type: "object", properties: Object.fromEntries(pathFields.map(parameter => [parameter.name, parameter.schema ?? { type: "string" }])), required: pathFields.map(parameter => parameter.name), additionalProperties: false }
        required.push("path")
      }
      const queryFields = parameters.filter(parameter => parameter.in === "query")
      // Undocumented filters stay open: the route validates its own query with zod.
      const openQuery = method === "get" && !queryFields.length
      if (queryFields.length) {
        const requiredQuery = queryFields.filter(parameter => parameter.required).map(parameter => parameter.name)
        properties.query = { type: "object", properties: Object.fromEntries(queryFields.map(parameter => [parameter.name, hoist(parameter.schema ?? { type: "string" }, definitions)])), required: requiredQuery, additionalProperties: false }
        if (requiredQuery.length) required.push("query")
      } else if (openQuery) {
        properties.query = { type: "object", description: "Filtros e paginação aceitos pela operação.", additionalProperties: { anyOf: [scalar, { type: "array", items: scalar }] } }
      }
      const read = method === "get"
      if (!read) properties.headers = { type: "object", properties: writeHeaders, additionalProperties: false, description: "Precondições: revisão em If-Match e chave de idempotência da mesma intenção." }
      const documentedBody = (operation.requestBody as { content?: Record<string, { schema?: Json }> } | undefined)?.content?.["application/json"]?.schema
      const body = documentedBody !== undefined || ["post", "put", "patch"].includes(method)
      if (documentedBody) { properties.body = hoist(documentedBody, definitions); required.push("body") }
      else if (body) properties.body = { description: "Corpo JSON tipado da operação." }
      const name = toolName(method, path)
      const inputSchema: Json = { type: "object", properties, required, additionalProperties: false, ...(Object.keys(definitions).length ? { $defs: definitions } : {}) }
      const description = `${method.toUpperCase()} ${path}. ${typeof operation.summary === "string" ? operation.summary : "Operação implementada do ERP."} ${typeof operation.description === "string" ? operation.description : "Usa as permissões e regras da API. Preserve revisão e chave de idempotência em repetições."}`
      tools.push({
        name, method: method.toUpperCase(), path, readOnly: read, parameters, body, bodyRequired: documentedBody !== undefined, openQuery,
        definition: {
          name, description, inputSchema,
          annotations: { readOnlyHint: read, destructiveHint: !read, idempotentHint: read || method === "put" || method === "delete", openWorldHint: true },
          _meta: { "erp/path": path, "erp/method": method.toUpperCase() },
        },
      })
    }
  }
  tools.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw Error("MCP tool names must be unique")
  return tools
}

function scalarValue(value: unknown) {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  return reject("Parâmetro precisa ser um valor escalar")
}

function segment(value: string) {
  if (!value || value === "." || value === ".." || /\p{Cc}/u.test(value)) reject("Parâmetro de caminho inválido")
  return [...Buffer.from(value, "utf8")].map(byte => /[A-Za-z0-9\-._~]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("")
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const objectValue = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : reject("Grupo de parâmetros inválido")

export type ToolRequest = { method: string; url: string; headers: Record<string, string>; payload?: string }

/** Turns validated tool arguments into one in-memory request to the business router. */
export function toolRequest(tool: Tool, input: unknown): ToolRequest {
  if (input === undefined) input = {}
  if (typeof input !== "object" || input === null || Array.isArray(input)) reject("Argumentos precisam ser um objeto")
  const args = input as Json
  const schema = tool.definition.inputSchema as { properties: Json; required: string[] }
  if (Object.keys(args).some(key => !(key in schema.properties))) reject("Argumento desconhecido")
  if (schema.required.some(key => !(key in args))) reject("Argumento obrigatório ausente")
  const headers: Record<string, string> = { accept: "application/json, application/pdf, application/xml, text/event-stream" }
  if ("tenant_id" in args) {
    if (typeof args.tenant_id !== "string" || !uuid.test(args.tenant_id)) reject("Empresa inválida")
    headers["x-tenant-id"] = String(args.tenant_id).toLowerCase()
  }
  let path = tool.path
  if (args.path !== undefined) {
    const values = objectValue(args.path)
    for (const [name, value] of Object.entries(values)) {
      if (!tool.parameters.some(parameter => parameter.in === "path" && parameter.name === name)) reject("Parâmetro desconhecido")
      path = path.replace(`{${name}}`, segment(scalarValue(value)))
    }
  }
  if (/[{}]/.test(path)) reject("Parâmetro de caminho ausente")
  const query = new URLSearchParams()
  if (args.query !== undefined) {
    const values = objectValue(args.query)
    for (const [name, value] of Object.entries(values)) {
      const parameter = tool.parameters.find(item => item.in === "query" && item.name === name)
      if (!parameter && !tool.openQuery) reject("Parâmetro desconhecido")
      const list = Array.isArray(value) ? value.map(scalarValue) : [scalarValue(value)]
      for (const item of parameter?.explode === false ? [list.join(",")] : list) query.append(name, item)
    }
    for (const parameter of tool.parameters.filter(item => item.in === "query" && item.required)) if (!(parameter.name in values)) reject("Parâmetro obrigatório ausente")
  }
  if (args.headers !== undefined) {
    for (const [name, value] of Object.entries(objectValue(args.headers))) {
      const key = name.toLowerCase()
      if (key === "x-tenant-id") reject("Use tenant_id para selecionar a empresa")
      if (forbiddenHeaders.has(key)) reject("Cabeçalho não autorizado")
      if (!(name in writeHeaders)) reject("Parâmetro desconhecido")
      const text = scalarValue(value)
      if (/[\r\n]/.test(text) || text.length > 200) reject("Cabeçalho inválido")
      headers[key] = text
    }
  }
  let payload: string | undefined
  if (args.body !== undefined) {
    if (!tool.body) reject("Esta operação não recebe corpo")
    headers["content-type"] = "application/json"
    payload = stringifyJson(args.body)
  } else if (tool.bodyRequired) reject("Corpo obrigatório")
  return { method: tool.method, url: path + (query.size ? `?${query}` : ""), headers, ...(payload === undefined ? {} : { payload }) }
}
