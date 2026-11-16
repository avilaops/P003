import "server-only"

// Pure selection only. Session/auth headers and the single upstream request stay
// in the server-only proxy. Unsupported resources always keep their Rust route.
export type MigratedModule = "preferences" | "registrations" | "sales" | "reports"
export type BackendEnvironment = { ERP_TYPESCRIPT_API_URL?: string | undefined; ERP_TYPESCRIPT_MODULES?: string | undefined }
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
const routes: { module: MigratedModule; methods: readonly string[]; path: RegExp }[] = [
  { module: "preferences", methods: ["GET", "PUT"], path: /^\/preferences$/ },
  { module: "registrations", methods: ["GET", "POST"], path: /^\/(?:parties|products|product-categories|product-groups|tag-groups|tags)$/ },
  { module: "registrations", methods: ["GET", "PUT"], path: new RegExp(`^/(?:parties|products|product-categories|product-groups|tag-groups|tags)/${uuid}$`, "i") },
  { module: "registrations", methods: ["GET", "PUT"], path: /^\/registration-settings\/(?:products|parties|contact-types|tax-profiles)$/ },
  { module: "sales", methods: ["GET", "POST"], path: /^\/(?:orders|proposals|opportunities)$/ },
  { module: "sales", methods: ["GET", "PUT"], path: new RegExp(`^/(?:orders|proposals|opportunities)/${uuid}$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/orders/${uuid}/(?:accept|confirm|cancel|complete)$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/proposals/${uuid}/(?:send|accept|reject|cancel|revise|convert|approve-order)$`, "i") },
  { module: "sales", methods: ["GET", "PUT"], path: /^\/commercial\/approval-settings$/ },
  { module: "sales", methods: ["GET"], path: new RegExp(`^/commercial/orders/${uuid}$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/commercial/orders/${uuid}/decision$`, "i") },
  { module: "sales", methods: ["GET"], path: /^\/commercial\/(?:tables\/(?:imported|national)|metrics\/(?:orders|commissions))$/ },
  { module: "sales", methods: ["POST"], path: /^\/commercial\/(?:mixed\/)?(?:simulate|orders)$/ },
  { module: "reports", methods: ["GET"], path: /^\/dashboard$/ },
  { module: "reports", methods: ["GET", "POST"], path: /^\/system\/custom-reports$/ },
  { module: "reports", methods: ["PUT"], path: new RegExp(`^/system/custom-reports/${uuid}$`, "i") },
]
function enabledModules(environment: BackendEnvironment) {
  const rawModules = environment.ERP_TYPESCRIPT_MODULES?.trim() ?? ""
  const enabled = rawModules === "" ? [] : rawModules.split(",").map(value => value.trim())
  if (enabled.some(value => !["preferences", "registrations", "sales", "reports"].includes(value)) || enabled.length !== new Set(enabled).size) throw Error("Configuração dos módulos TypeScript inválida")
  return enabled
}
function typescriptOrigin(environment: BackendEnvironment) {
  if (!environment.ERP_TYPESCRIPT_API_URL) throw Error("API TypeScript não configurada para o módulo ativo")
  const url = new URL(environment.ERP_TYPESCRIPT_API_URL)
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw Error("Origem da API TypeScript inválida")
  return url.origin
}
export function erpHealthOrigins(rustOrigin: string, environment: BackendEnvironment) {
  return enabledModules(environment).length ? [rustOrigin, typescriptOrigin(environment)] : [rustOrigin]
}
export function selectErpBackend(method: string, resource: string, rustOrigin: string, environment: BackendEnvironment) {
  const route = routes.find(route => route.methods.includes(method.toUpperCase()) && route.path.test(resource))
  if (!route) return { origin: rustOrigin, backend: "rust" as const, module: null }
  if (!enabledModules(environment).includes(route.module)) return { origin: rustOrigin, backend: "rust" as const, module: route.module }
  return { origin: typescriptOrigin(environment), backend: "typescript" as const, module: route.module }
}
