import Fastify, { type FastifyInstance } from "fastify"

import { registerPartyRoutes } from "./modules/parties/routes.js"
import { registerOrderRoutes } from "./modules/orders/routes.js"
import { registerPreferenceRoutes } from "./modules/preferences/routes.js"
import { registerProductRoutes } from "./modules/products/routes.js"
import { registerProposalRoutes } from "./modules/proposals/routes.js"
import { registerReferenceRoutes } from "./modules/reference-data/routes.js"
import { registerRegistrationSettingsRoutes } from "./modules/registration-settings/routes.js"
import { authenticateRequest, type AccessDependencies } from "./platform/access.js"
import { Problem } from "./platform/problem.js"

export type AppDependencies = AccessDependencies

export function buildApp(_dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 65_536 })
  app.addHook("onRequest", async request => {
    if (request.routeOptions.url?.startsWith("/api/v1/")) await authenticateRequest(request, _dependencies)
  })
  app.get("/health/live", async () => ({ status: "ok" }))
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
  registerOrderRoutes(app, _dependencies)
  registerPreferenceRoutes(app, _dependencies)
  registerProductRoutes(app, _dependencies)
  registerProposalRoutes(app, _dependencies)
  registerReferenceRoutes(app, _dependencies)
  registerRegistrationSettingsRoutes(app, _dependencies)
  return app
}
