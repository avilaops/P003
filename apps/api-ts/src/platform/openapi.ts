import type { FastifyInstance } from "fastify"
import { z } from "zod"

/**
 * Contrato OpenAPI do api-ts, gerado das rotas realmente registradas no Fastify.
 *
 * Cada rota aparece com método, caminho, parâmetros e segurança. Quem porta ou
 * cria uma rota enriquece o contrato declarando os schemas zod que ela já usa:
 *
 *   app.put("/api/v1/x", { config: { openapi: { summary: "...", body: xInputSchema } } }, handler)
 *
 * `buildOpenApiDocument(app)` é a função que a rota `/openapi.json` (PR #285)
 * deve chamar; `pnpm --filter api-ts openapi` grava o resultado em `openapi.json`.
 */
export type RouteDocumentation = {
  summary?: string
  body?: z.ZodType
  query?: z.ZodType
  /** Schema da resposta de sucesso (código 200, ou `successStatus`). */
  response?: z.ZodType
  successStatus?: number
}

declare module "fastify" {
  interface FastifyContextConfig { openapi?: RouteDocumentation }
}

export type RegisteredRoute = { method: string; path: string; documentation?: RouteDocumentation }

const registry = new WeakMap<FastifyInstance, RegisteredRoute[]>()
const verbs = ["get", "put", "post", "delete", "patch", "options"] as const

/** Deve ser chamada antes de qualquer registro de rota (ver `buildApp`). */
export function trackRoutes(app: FastifyInstance) {
  const routes: RegisteredRoute[] = []
  registry.set(app, routes)
  app.addHook("onRoute", route => {
    for (const method of [route.method].flat()) {
      if (method === "HEAD") continue // Fastify cria HEAD automático para cada GET.
      const documentation = route.config?.openapi
      // `/x/:id?` atende `/x` e `/x/:id`: o contrato lista as duas operações.
      const optional = route.url.match(/^(.*)\/:\w+\?$/)
      for (const path of optional ? [optional[1] || "/", route.url.replace(/\?$/, "")] : [route.url]) routes.push({ method, path, ...(documentation ? { documentation } : {}) })
    }
  })
}

export function registeredRoutes(app: FastifyInstance): RegisteredRoute[] {
  const routes = registry.get(app)
  if (!routes) throw new Error("trackRoutes(app) não foi chamada antes do registro das rotas")
  return [...routes]
}

/** `/api/v1/orders/:id` → `/api/v1/orders/{id}`. */
export function openApiPath(path: string) {
  return path.replace(/:([A-Za-z_]\w*)\??/g, "{$1}").replace(/\*/g, "{wildcard}")
}

const jsonSchema = (schema: z.ZodType, io: "input" | "output") => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any", target: "draft-2020-12" }) as Record<string, unknown>
  return rest
}

const operationId = (method: string, path: string) =>
  method.toLowerCase() + path.replace(/[{}]/g, "").split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join("")

// Rotas /api/v1 exigem Bearer e empresa ativa, exceto as autenticadas por serviço (ver `buildApp`).
const requiresUser = (path: string) => path.startsWith("/api/v1/") && !path.startsWith("/api/v1/integrations/nfse/")

export function buildOpenApiDocument(app: FastifyInstance, info: { title?: string; version?: string } = {}) {
  const paths: Record<string, Record<string, unknown>> = {}
  const routes = registeredRoutes(app).sort((a, b) => openApiPath(a.path).localeCompare(openApiPath(b.path)) || a.method.localeCompare(b.method))
  for (const route of routes) {
    const method = route.method.toLowerCase()
    if (!(verbs as readonly string[]).includes(method)) continue
    const path = openApiPath(route.path), doc = route.documentation
    const parameters: unknown[] = [...path.matchAll(/\{(\w+)\}/g)].map(match => ({ name: match[1], in: "path", required: true, schema: { type: "string" } }))
    if (doc?.query) {
      const schema = jsonSchema(doc.query, "input") as { properties?: Record<string, unknown>; required?: string[] }
      for (const [name, value] of Object.entries(schema.properties ?? {})) parameters.push({ name, in: "query", required: schema.required?.includes(name) ?? false, schema: value })
    }
    const success = String(doc?.successStatus ?? 200)
    const operation: Record<string, unknown> = {
      operationId: operationId(method, path),
      ...(doc?.summary ? { summary: doc.summary } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(doc?.body ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(doc.body, "input") } } } } : {}),
      responses: {
        [success]: doc?.response ? { description: "Sucesso", content: { "application/json": { schema: jsonSchema(doc.response, "output") } } } : { description: "Sucesso" },
        default: { description: "Erro", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
      },
      ...(requiresUser(path) ? { security: [{ bearerAuth: [], tenantHeader: [] }] } : {}),
    }
    ;(paths[path] ??= {})[method] = operation
  }
  return {
    openapi: "3.1.0",
    info: { title: info.title ?? "ERP Ávila Ops API", version: info.version ?? "1.0.0" },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        tenantHeader: { type: "apiKey", in: "header", name: "X-Tenant-Id" },
      },
      schemas: {
        Problem: {
          type: "object",
          required: ["type", "title", "status"],
          properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "integer" } },
        },
      },
    },
  }
}
