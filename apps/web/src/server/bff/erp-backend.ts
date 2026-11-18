import "server-only"
import { financeRoute } from "./finance-resources"
import { stockLocationPath } from "./stock-location-path"
export { financeRoute, stockLocationPath }

// Permanent ownership after the four-module transition. The previous release,
// rather than traffic flags, is the operational return path.
export type MigratedModule = "access" | "preferences" | "registrations" | "sales" | "reports" | "finance" | "inventory"
export type BackendEnvironment = { ERP_TYPESCRIPT_API_URL?: string | undefined; ERP_TYPESCRIPT_MODULES?: string | undefined }
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
const routes: { module: MigratedModule; methods: readonly string[]; path: RegExp }[] = [
  { module: "access", methods: ["GET"], path: /^\/me$/ },
  { module: "inventory", methods: ["GET","POST"], path: /^\/production\/(orders|stages)$/ },
  { module: "inventory", methods: ["GET","POST"], path: new RegExp("^/production/structures/"+uuid+"$", "i") },
  { module: "inventory", methods: ["GET"], path: new RegExp("^/production/orders/"+uuid+"$", "i") },
  { module: "inventory", methods: ["PUT"], path: new RegExp("^/production/stages/"+uuid+"$", "i") },
  { module: "inventory", methods: ["POST"], path: new RegExp("^/production/orders/"+uuid+"/(?:stage|postings|consumptions(?:/"+uuid+"/reverse)?)$", "i") },
  { module: "inventory", methods: ["GET","POST"], path: /^\/inventory-counts$/ },
  { module: "inventory", methods: ["GET"], path: new RegExp(`^/inventory-counts/${uuid}$`, "i") },
  { module: "inventory", methods: ["POST"], path: new RegExp(`^/inventory-counts/${uuid}/(?:lines|approve|cancel)$`, "i") },
  { module: "inventory", methods: ["GET","POST"], path: /^\/warehouses$/ },
  { module: "inventory", methods: ["GET","PUT"], path: new RegExp(`^/warehouses/${uuid}$`, "i") },
  { module: "inventory", methods: ["GET"], path: /^\/stock$/ },
  { module: "inventory", methods: ["GET", "POST"], path: /^\/stock\/movements$/ },
  { module: "reports", methods: ["GET", "POST"], path: /^\/financial-report\/email$/ },
  { module: "reports", methods: ["GET", "POST"], path: new RegExp(`^/receivables/${uuid}/email$`, "i") },
  { module: "reports", methods: ["GET", "POST"], path: new RegExp(`^/financial-payables/${uuid}/email$`, "i") },
  { module: "sales", methods: ["GET", "POST"], path: new RegExp(`^/commercial-contracts/${uuid}/email$`, "i") },
  { module: "sales", methods: ["GET", "POST"], path: new RegExp(`^/commercial-contracts/${uuid}/send-package$`, "i") },
  { module: "sales", methods: ["GET", "POST"], path: new RegExp(`^/commercial-contracts/${uuid}/qualified-reissue$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/commercial-contracts/${uuid}/prepare-signatures$`, "i") },
  { module: "sales", methods: ["GET", "POST"], path: new RegExp(`^/(?:orders|proposals)/${uuid}/email$`, "i") },
  { module: "preferences", methods: ["GET", "PUT"], path: /^\/preferences$/ },
  { module: "registrations", methods: ["GET"], path: /^\/products\/finishes$/ },
  { module: "registrations", methods: ["GET", "POST"], path: /^\/(?:parties|products|product-categories|product-groups|tag-groups|tags)$/ },
  { module: "registrations", methods: ["GET", "PUT"], path: new RegExp(`^/(?:parties|products|product-categories|product-groups|tag-groups|tags)/${uuid}$`, "i") },
  { module: "registrations", methods: ["GET", "PUT"], path: /^\/registration-settings\/(?:products|parties|contact-types|tax-profiles)$/ },
  { module: "sales", methods: ["GET", "POST"], path: /^\/(?:orders|proposals|opportunities)$/ },
  { module: "sales", methods: ["GET", "PUT"], path: new RegExp(`^/(?:orders|proposals|opportunities)/${uuid}$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/orders/${uuid}/(?:accept|confirm|cancel|complete|cancel-completed)$`, "i") },
  { module: "sales", methods: ["GET"], path: new RegExp(`^/orders/${uuid}/cancellations$`, "i") },
  { module: "sales", methods: ["GET"], path: new RegExp(`^/orders/${uuid}/pricing$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/orders/${uuid}/pricing/approve$`, "i") },
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
export function typescriptOrigin(environment: BackendEnvironment) {
  if (!environment.ERP_TYPESCRIPT_API_URL) throw Error("API TypeScript não configurada para o módulo ativo")
  const url = new URL(environment.ERP_TYPESCRIPT_API_URL)
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw Error("Origem da API TypeScript inválida")
  return url.origin
}
export function erpHealthOrigins(rustOrigin: string, environment: BackendEnvironment) {
  return [rustOrigin, typescriptOrigin(environment)]
}
export function selectErpBackend(method: string, resource: string, rustOrigin: string, environment: BackendEnvironment) {
  if (financeRoute(method, resource)) return { origin: typescriptOrigin(environment), backend: "typescript" as const, module: "finance" as const }
  if (stockLocationPath(resource,method.toUpperCase())) return { origin: typescriptOrigin(environment), backend: "typescript" as const, module: "inventory" as const }
  const route = routes.find(route => route.methods.includes(method.toUpperCase()) && route.path.test(resource))
  if (!route) return { origin: rustOrigin, backend: "rust" as const, module: null }
  return { origin: typescriptOrigin(environment), backend: "typescript" as const, module: route.module }
}
