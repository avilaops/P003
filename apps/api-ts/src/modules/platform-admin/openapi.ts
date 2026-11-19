// TODO(#284): substituir pelo gerador de contrato OpenAPI do TypeScript (e o teste de
// cobertura de rotas) assim que o #284 for mesclado. Este documento mínimo só lista
// as operações registradas no Fastify, para que /openapi.json exista no api-ts.

export type RegisteredRoute = { method: string; path: string }

const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])

/** Lê a árvore de `app.printRoutes({ commonPrefix: false })` e devolve método + caminho completo. */
export function collectRoutes(tree: string): RegisteredRoute[] {
  const routes: RegisteredRoute[] = []
  const stack: string[] = []
  for (const line of tree.split("\n")) {
    const match = /^((?:[│ ] {3})*)[├└]── (\S+)(?: \(([^)]*)\))?\s*$/.exec(line)
    if (!match) continue
    const depth = match[1]!.length / 4
    stack.length = depth
    stack[depth] = match[2]!
    for (const method of (match[3] ?? "").split(",").map(item => item.trim().toUpperCase())) {
      if (methods.has(method)) routes.push({ method, path: stack.join("") })
    }
  }
  return routes
}

export function buildOpenApiDocument(routes: RegisteredRoute[]) {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const route of [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
    const path = route.path.replace(/:([A-Za-z_][A-Za-z_0-9]*)/g, "{$1}")
    const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map(item => ({ name: item[1], in: "path", required: true, schema: { type: "string" } }))
    const protectedRoute = path.startsWith("/api/v1/")
    ;(paths[path] ??= {})[route.method.toLowerCase()] = {
      parameters: [...parameters, ...(protectedRoute ? [{ name: "X-Tenant-Id", in: "header", required: true, schema: { type: "string", format: "uuid" } }] : [])],
      ...(protectedRoute ? { security: [{ bearerAuth: [] }] } : {}),
      responses: { default: { description: "Resposta da operação" } },
    }
  }
  return {
    openapi: "3.1.0",
    info: { title: "Ávila ERP API", version: "0.1.0", description: "Operações registradas no api-ts. Sem dados demonstrativos." },
    paths,
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  }
}
