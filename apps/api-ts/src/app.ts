import Fastify, { type FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { registerParticipantRoutes } from "./modules/contract-signatures/participant-routes.js"

import {registerCertificates} from "./modules/fiscal-workspace/certificates.js"
import {registerFiscalSettings} from "./modules/fiscal-workspace/settings.js"
import {registerOutgoingImports} from "./modules/fiscal-workspace/outgoing-imports.js"
import { registerEmissionEvents } from "./modules/fiscal-workspace/emission-events.js"
import { registerEmission } from "./modules/fiscal-workspace/emission.js"
import { registerFiscalDrafts } from "./modules/fiscal-workspace/drafts.js"
import type { FiscalOperations } from "./modules/fiscal-workspace/engine.js"
import { registerFiscalIncoming } from "./modules/fiscal-workspace/incoming.js"
import { registerFiscalReceipts } from "./modules/fiscal-incoming/routes.js"
import { registerOrderLots } from "./modules/fiscal-workspace/order-lots.js"
import { registerFiscalOutgoing } from "./modules/fiscal-workspace/outgoing.js"
import { registerLocationRoutes } from "./modules/inventory/location-routes.js"
import { registerCountRoutes } from "./modules/inventory/count-routes.js"
import { registerStockRoutes } from "./modules/inventory/routes.js"
import { registerProduction } from "./modules/production/routes.js"
import { registerPartyRoutes } from "./modules/parties/routes.js"
import { registerWarranties } from "./modules/warranties/routes.js"
import { registerDashboardRoutes } from "./modules/dashboard/routes.js"
import { registerReportRoutes } from "./modules/reports/routes.js"
import { registerPosSessionRoutes } from "./modules/pos-sessions/routes.js"
import { registerFinanceInsightRoutes } from "./modules/finance-insights/routes.js"
import { registerFinanceWalletRoutes } from "./modules/finance-wallets/routes.js"
import { registerFinanceManagementRoutes } from "./modules/finance-management/routes.js"
import { registerFinanceTreasuryRoutes } from "./modules/finance-treasury/routes.js"
import { registerCommercialApprovalRoutes } from "./modules/commercial/approvals.js"
import { registerCommercialSimulation } from "./modules/commercial/simulation.js"
import { registerCommercialConversion } from "./modules/commercial/conversion.js"
import { registerCommercialTables } from "./modules/commercial/tables.js"
import { registerCommercialPricingSettings } from "./modules/commercial/pricing-inputs.js"
import { channelServiceRoute } from "./modules/commercial/channel-service.js"
import { registerSalesPolicies } from "./modules/commercial/policy-routes.js"
import { registerOpportunityRoutes } from "./modules/opportunities/routes.js"
import { registerCommercialMetrics } from "./modules/commercial/metrics.js"
import { registerOrderRoutes } from "./modules/orders/routes.js"
import { registerSalesMail } from "./modules/sales/mail-routes.js"
import { registerSalesOverview } from "./modules/sales/overview.js"
import { registerPreferenceRoutes } from "./modules/preferences/routes.js"
import { registerProductRoutes } from "./modules/products/routes.js"
import { registerPosRoutes } from "./modules/pos/routes.js"
import { registerOrderImports } from "./modules/order-imports/routes.js"
import { registerProposalRoutes } from "./modules/proposals/routes.js"
import { registerSalesSimulator } from "./modules/sales-simulator/routes.js"
import { registerCatalogPublication } from "./modules/catalog-publication/routes.js"
import { registerOrderSettings } from "./modules/order-settings/routes.js"
import { registerReferenceRoutes } from "./modules/reference-data/routes.js"
import { registerRegistrationSettingsRoutes } from "./modules/registration-settings/routes.js"
import { registerOutgoingNfseRoutes, type OutgoingNfseDependencies } from "./modules/outgoing-nfse/routes.js"
import { registerNfeEmail, type NfeEmailIO } from "./modules/nfe-email/routes.js"
import { authenticateRequest, authorizeRequest, type AccessDependencies } from "./platform/access.js"
import { readAccessProfile } from "./platform/database.js"
import { Problem } from "./platform/problem.js"
import { parseJson, stringifyJson } from "./platform/json.js"
import { registerMcpDispatch } from "./platform/mcp-dispatch.js"
import { registerDocumentCopies, type DocumentCopyIO } from "./modules/document-copies/routes.js"
import { registerFinancialEmails } from "./modules/document-copies/financial-routes.js"
import { registerContractPackage } from "./modules/document-copies/contract-package-routes.js"
import { registerQualifiedReissue } from "./modules/contract-signatures/reissue.js"
import { registerContractTemplateArchive } from "./modules/contract-templates/archive.js"
import { registerBrowserUseRoutes, type BrowserUseDependencies } from "./modules/browser-use/routes.js"

export type AppDependencies = AccessDependencies & { fiscalVault?:import("./modules/outgoing-nfse/certificate-vault.js").FiscalCertificateVault; fiscalOperations?:FiscalOperations; outgoingNfse?: OutgoingNfseDependencies; nfeEmail?: NfeEmailIO; documentCopies?: DocumentCopyIO; browserUse?: BrowserUseDependencies; catalogMedia?: import("./platform/catalog-media.js").CatalogMedia }

export function buildApp(_dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 65_536 })
  const validateJson = app.getDefaultJsonParser("error", "error")
  app.removeContentTypeParser("application/json")
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    // Retain Fastify's JSON/prototype validation, then read exact integer tokens.
    validateJson(request, String(body), error => {
      if (error) return done(error)
      try { done(null, parseJson(String(body))) }
      catch { done(new Problem(422, "invalid_input", "JSON inválido ou campos desconhecidos")) }
    })
  })
  app.setReplySerializer(stringifyJson)
  app.addHook("onRequest", async (request, reply) => {
    const provided = request.headers["x-request-id"]
    const requestId = Array.isArray(provided) ? provided[0] ?? "" : provided ?? randomUUID()
    request.headers["x-request-id"] = requestId
    reply.header("x-request-id", requestId)
    if (request.routeOptions.url?.startsWith("/api/v1/") && !request.routeOptions.url.startsWith("/api/v1/integrations/nfse/")) {
      reply.header("x-erp-backend", "typescript")
      if (!channelServiceRoute(request.method,request.routeOptions.url)) await authenticateRequest(request, _dependencies)
    }
  })
  app.get("/health/live", async () => ({ status: "ok" }))
  app.get("/health/ready", async (_request, reply) => {
    const client = await _dependencies.pool.connect().catch(() => undefined)
    reply.header("cache-control", "no-store")
    if (!client) return reply.code(503).send({ status: "unavailable" })
    try { await client.query("SELECT 1"); return { status: "ready" } }
    catch { return reply.code(503).send({ status: "unavailable" }) }
    finally { client.release() }
  })
  app.setErrorHandler((error, request, reply) => {
    const databaseCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
    const problem = error instanceof Problem ? error
      : ["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY", "FST_ERR_CTP_BODY_TOO_LARGE", "FST_ERR_CTP_INVALID_MEDIA_TYPE"].includes(databaseCode) ? new Problem(422, "invalid_input", request.routeOptions.url === "/api/v1/preferences" ? "Preferências inválidas ou campos desconhecidos" : "JSON inválido ou campos desconhecidos")
      : databaseCode === "PF001" ? new Problem(409, "domain_conflict", "O período financeiro da empresa está fechado para a data informada")
      : databaseCode === "23505" ? new Problem(409, "domain_conflict", "Já existe um cadastro com estes dados nesta empresa")
      : databaseCode === "P4101" ? new Problem(409, "domain_conflict", error instanceof Error ? error.message : "O depósito não permite esta operação")
      : databaseCode === "23503" || databaseCode === "23514" ? new Problem(422, "invalid_input", "Cadastro incompatível com os registros da empresa")
      : new Problem(500, "internal_error", "Erro interno")
    void reply
      .code(problem.status)
      .header("content-type", "application/problem+json")
      .header("cache-control", "no-store")
      .send(problem.toJSON())
  })
  registerFiscalOutgoing(app, _dependencies)
  registerFiscalDrafts(app,_dependencies)
  registerEmission(app,_dependencies)
  registerEmissionEvents(app,_dependencies)
  registerOutgoingImports(app,_dependencies)
  registerFiscalSettings(app,_dependencies)
  registerCertificates(app,_dependencies)
  registerOrderLots(app, _dependencies)
  registerFiscalIncoming(app, _dependencies)
  registerFiscalReceipts(app, _dependencies)
  app.get("/api/v1/me", async (request, reply) => {
    reply.header("cache-control", "no-store")
    return authorizeRequest(request, _dependencies, async context => {
      const { subject, email, name } = context.identity
      return { identity: { subject, email, name }, ...await readAccessProfile(context) }
    })
  })
  registerStockRoutes(app, _dependencies)
  registerProduction(app, _dependencies)
  registerLocationRoutes(app, _dependencies)
  registerCountRoutes(app, _dependencies)
  registerPartyRoutes(app, _dependencies)
  registerWarranties(app, _dependencies)
  registerDashboardRoutes(app, _dependencies)
  registerReportRoutes(app, _dependencies)
  registerPosSessionRoutes(app, _dependencies)
  registerFinanceInsightRoutes(app, _dependencies)
  registerFinanceWalletRoutes(app, _dependencies)
  registerFinanceManagementRoutes(app, _dependencies)
  registerFinanceTreasuryRoutes(app, _dependencies)
  registerCommercialApprovalRoutes(app, _dependencies)
  registerCommercialSimulation(app, _dependencies)
  registerCommercialConversion(app, _dependencies)
  registerCommercialTables(app, _dependencies)
  registerCommercialPricingSettings(app, _dependencies)
  registerSalesPolicies(app, _dependencies)
  registerOpportunityRoutes(app, _dependencies)
  registerCommercialMetrics(app, _dependencies)
  registerOrderRoutes(app, _dependencies)
  registerSalesMail(app, _dependencies, _dependencies.documentCopies)
  registerSalesOverview(app, _dependencies)
  registerPreferenceRoutes(app, _dependencies)
  registerProductRoutes(app, _dependencies)
  registerPosRoutes(app, _dependencies)
  registerOrderImports(app, _dependencies)
  registerProposalRoutes(app, _dependencies)
  registerSalesSimulator(app, _dependencies)
  registerOrderSettings(app, _dependencies)
  registerCatalogPublication(app, _dependencies)
  registerReferenceRoutes(app, _dependencies)
  registerRegistrationSettingsRoutes(app, _dependencies)
  registerOutgoingNfseRoutes(app, _dependencies)
  registerNfeEmail(app, _dependencies, _dependencies.nfeEmail)
  registerMcpDispatch(app, _dependencies)
  registerDocumentCopies(app, _dependencies, _dependencies.documentCopies)
  registerFinancialEmails(app, _dependencies, _dependencies.documentCopies)
  registerContractPackage(app, _dependencies, _dependencies.documentCopies, _dependencies.nfeEmail?.render)
  registerQualifiedReissue(app, _dependencies)
  registerContractTemplateArchive(app, _dependencies)
  registerParticipantRoutes(app, _dependencies)
  registerBrowserUseRoutes(app, _dependencies, _dependencies.browserUse)
  return app
}
