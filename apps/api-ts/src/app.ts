import Fastify, { type FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"

import { registerPartyRoutes } from "./modules/parties/routes.js"
import { registerDashboardRoutes } from "./modules/dashboard/routes.js"
import { registerReportRoutes } from "./modules/reports/routes.js"
import { registerCommercialApprovalRoutes } from "./modules/commercial/approvals.js"
import { registerCommercialSimulation } from "./modules/commercial/simulation.js"
import { registerCommercialConversion } from "./modules/commercial/conversion.js"
import { registerCommercialTables } from "./modules/commercial/tables.js"
import { registerOpportunityRoutes } from "./modules/opportunities/routes.js"
import { registerCommercialMetrics } from "./modules/commercial/metrics.js"
import { registerOrderRoutes } from "./modules/orders/routes.js"
import { registerPreferenceRoutes } from "./modules/preferences/routes.js"
import { registerProductRoutes } from "./modules/products/routes.js"
import { registerProposalRoutes } from "./modules/proposals/routes.js"
import { registerReferenceRoutes } from "./modules/reference-data/routes.js"
import { registerRegistrationSettingsRoutes } from "./modules/registration-settings/routes.js"
import { registerOutgoingNfseRoutes, type OutgoingNfseDependencies } from "./modules/outgoing-nfse/routes.js"
import { registerNfeEmail, type NfeEmailIO } from "./modules/nfe-email/routes.js"
import { authenticateRequest, type AccessDependencies } from "./platform/access.js"
import { Problem } from "./platform/problem.js"
import { parseJson, stringifyJson } from "./platform/json.js"
import { registerMcpDispatch } from "./platform/mcp-dispatch.js"

export type AppDependencies = AccessDependencies & { outgoingNfse?: OutgoingNfseDependencies; nfeEmail?: NfeEmailIO }

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
      await authenticateRequest(request, _dependencies)
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
      : databaseCode === "23505" ? new Problem(409, "domain_conflict", "Já existe um cadastro com estes dados nesta empresa")
      : databaseCode === "23503" || databaseCode === "23514" ? new Problem(422, "invalid_input", "Cadastro incompatível com os registros da empresa")
      : new Problem(500, "internal_error", "Erro interno")
    void reply
      .code(problem.status)
      .header("content-type", "application/problem+json")
      .header("cache-control", "no-store")
      .send(problem.toJSON())
  })
  registerPartyRoutes(app, _dependencies)
  registerDashboardRoutes(app, _dependencies)
  registerReportRoutes(app, _dependencies)
  registerCommercialApprovalRoutes(app, _dependencies)
  registerCommercialSimulation(app, _dependencies)
  registerCommercialConversion(app, _dependencies)
  registerCommercialTables(app, _dependencies)
  registerOpportunityRoutes(app, _dependencies)
  registerCommercialMetrics(app, _dependencies)
  registerOrderRoutes(app, _dependencies)
  registerPreferenceRoutes(app, _dependencies)
  registerProductRoutes(app, _dependencies)
  registerProposalRoutes(app, _dependencies)
  registerReferenceRoutes(app, _dependencies)
  registerRegistrationSettingsRoutes(app, _dependencies)
  registerOutgoingNfseRoutes(app, _dependencies)
  registerNfeEmail(app, _dependencies, _dependencies.nfeEmail)
  registerMcpDispatch(app, _dependencies)
  return app
}
