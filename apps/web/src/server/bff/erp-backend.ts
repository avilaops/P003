import "server-only"
import { financeRoute } from "./finance-resources"
import { stockLocationPath } from "./stock-location-path"
export { financeRoute, stockLocationPath }

// Permanent ownership after the four-module transition. The previous release,
// rather than traffic flags, is the operational return path.
export type MigratedModule = "access" | "preferences" | "registrations" | "sales" | "reports" | "finance" | "inventory"
export type BackendEnvironment = { ERP_TYPESCRIPT_API_URL?: string | undefined; ERP_TYPESCRIPT_MODULES?: string | undefined }
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
export function salesPolicyResource(method: string, resource: string) {
 return method === "GET" ? /^\/commercial\/policies\/(queue|performance|store(?:\/[a-f0-9-]{36})?|catalog(?:\/[a-f0-9-]{36})?)$/i.test(resource) : method === "POST" && /^\/commercial\/policies\/(settings|decisions|plan|goals|store)$/.test(resource)
}
const routes: { module: MigratedModule; methods: readonly string[]; path: RegExp }[] = [
  { module:"sales", methods:["GET"], path:/^\/warranty-metrics$/ },
  { module:"sales", methods:["GET","POST"], path:new RegExp(`^/warranty-cases/${uuid}/records$`, "i") },
  { module:"sales", methods:["GET"], path:new RegExp(`^/warranty-evidence/${uuid}/file$`, "i") },
  { module: "sales", methods:["GET"],path:/^\/sales\/overview$/ },
  { module:"sales", methods:["GET","POST"], path:new RegExp(`^/warranty-cases/${uuid}/settlements$`,"i") },
  { module: "sales", methods: ["GET","POST"], path: /^\/warranty-(?:cases|policies|equipment)$/ },
  { module: "sales", methods: ["GET"], path: new RegExp(`^/warranty-(?:cases/${uuid}|service-orders|origins|staff)$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/warranty-(?:cases/${uuid}/(?:assignment|transition|approval|service-order|rma|quarantine)|service-orders/${uuid}/parts|(?:rmas|quarantines)/${uuid}/transition)$`, "i") },
  { module: "sales", methods: ["GET","PUT"], path: /^\/opportunities\/settings$/ },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/opportunities/${uuid}/activities(?:/${uuid}/complete)?$`, "i") },
  { module: "sales", methods: ["GET"], path: new RegExp(`^/sales-imports(?:/${uuid})?$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/sales-imports/(?:preview|${uuid}/confirm)$`, "i") },
  { module: "sales", methods: ["GET"], path: /^\/sales-channels\/[a-z0-9][a-z0-9_-]{0,47}\/orders$/ },
  { module: "sales", methods: ["GET", "PUT"], path: /^\/pos\/settings$/ },
  { module: "sales", methods: ["GET"], path: new RegExp(`^/pos/(?:products|sessions(?:/current|/${uuid})?|sales(?:/${uuid})?)$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/pos/(?:sessions(?:/${uuid}/(?:movements|sales|close))?|sales/${uuid}/cancel)$`, "i") },
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
  { module: "registrations", methods: ["GET"], path: /^\/data-quality\/(?:party|product)\/(?:duplicates|completeness)$/ },
  { module: "registrations", methods: ["POST"], path: /^\/data-quality\/merge$/ },
  { module: "registrations", methods: ["GET", "POST"], path: /^\/(?:parties|products|product-categories|product-groups|tag-groups|tags)$/ },
  { module: "registrations", methods: ["GET", "PUT"], path: new RegExp(`^/(?:parties|products|product-categories|product-groups|tag-groups|tags)/${uuid}$`, "i") },
  { module: "registrations", methods: ["GET", "PUT"], path: /^\/registration-settings\/(?:products|parties|contact-types|tax-profiles)$/ },
  { module: "sales", methods: ["GET", "POST"], path: /^\/(?:orders|proposals|opportunities)$/ },
  { module: "sales", methods: ["GET", "PUT"], path: new RegExp(`^/(?:orders|proposals|opportunities)/${uuid}$`, "i") },
  { module: "sales", methods: ["GET"], path: new RegExp(`^/orders/${uuid}/(?:document|finance|cancellations|documents/${uuid})$`, "i") },
  { module: "sales", methods: ["GET", "POST"], path: new RegExp(`^/orders/${uuid}/documents$`, "i") },
  { module: "sales", methods: ["GET", "PUT"], path: new RegExp(`^/orders/${uuid}/commission$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/orders/${uuid}/cancel-completed$`, "i") },
  { module: "sales", methods: ["GET"], path: new RegExp(`^/receivables/${uuid}$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/receivables/${uuid}/(?:payments|reverse-payment)$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/orders/${uuid}/(?:accept|confirm|cancel|complete)$`, "i") },
  { module: "sales", methods: ["GET"], path: new RegExp(`^/orders/${uuid}/pricing$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/orders/${uuid}/pricing/approve$`, "i") },
  { module: "sales", methods: ["POST"], path: new RegExp(`^/proposals/${uuid}/(?:send|accept|reject|cancel|revise|convert|approve-order)$`, "i") },
  { module: "sales", methods: ["GET", "PUT"], path: /^\/commercial\/approval-settings$/ },
  { module: "sales", methods: ["GET", "PUT"], path: /^\/commercial-settings\/(?:imported|national)$/ },
  { module: "sales", methods: ["POST"], path: /^\/commercial-settings\/(?:imported|national)\/preview$/ },
  { module: "sales", methods: ["GET"], path: /^\/price-tables\/(?:imported|national)(?:\/preview)?$/ },
  { module: "sales", methods: ["POST"], path: /^\/price-tables\/(?:imported|national)\/publish$/ },
  { module: "sales", methods: ["GET", "PUT"], path: new RegExp("^/product-costs/" + uuid + "$", "i") },
  { module: "sales", methods: ["GET", "POST"], path: /^\/fixed-expenses$/ },
  { module: "sales", methods: ["PUT"], path: new RegExp("^/fixed-expenses/" + uuid + "$", "i") },
  { module: "registrations", methods: ["GET"], path: /^\/financial-categories$/ },
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
  if (salesPolicyResource(method, resource)) return { origin: typescriptOrigin(environment), backend: "typescript" as const, module: "sales" as const }
  if (!route) return { origin: rustOrigin, backend: "rust" as const, module: null }
  return { origin: typescriptOrigin(environment), backend: "typescript" as const, module: route.module }
}
