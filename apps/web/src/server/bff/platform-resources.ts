import "server-only"

// Recursos da plataforma SaaS (D10) implementados na API TypeScript: catálogo de
// parâmetros, fechamento do mês, implantação, consumo do plano e exportação integral.
const id = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
export type PlatformRoute = { path: RegExp; methods: string[]; query?: string[]; download?: true }
const routes: PlatformRoute[] = [
  { path: /^\/parameters$/, methods: ["GET"], query: ["q", "module"] },
  { path: /^\/parameters\/[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, methods: ["GET", "PUT"] },
  { path: /^\/period-close$/, methods: ["GET"], query: ["month"] },
  { path: /^\/onboarding$/, methods: ["GET"] },
  { path: /^\/company-account\/usage$/, methods: ["GET"] },
  { path: /^\/data-exports$/, methods: ["GET", "POST"] },
  { path: new RegExp(`^/data-exports/${id}$`, "i"), methods: ["GET"] },
  { path: new RegExp(`^/data-exports/${id}/file$`, "i"), methods: ["GET"], download: true },
]

export function platformRoute(method: string, resource: string) {
  return routes.find(route => route.methods.includes(method.toUpperCase()) && route.path.test(resource))
}
