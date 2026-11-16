import Fastify, { type FastifyInstance } from "fastify"

import { registerPartyRoutes } from "./modules/parties/routes.js"
import { registerPreferenceRoutes } from "./modules/preferences/routes.js"
import { registerProductRoutes } from "./modules/products/routes.js"
import { registerReferenceRoutes } from "./modules/reference-data/routes.js"
import type { AccessDependencies } from "./platform/access.js"
import { Problem } from "./platform/problem.js"

export type AppDependencies = AccessDependencies

export function buildApp(_dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 65_536 })
  app.get("/health/live", async () => ({ status: "ok" }))
  app.setErrorHandler((error, _request, reply) => {
    const problem = error instanceof Problem
      ? error
      : new Problem(500, "internal_error", "Erro interno")
    void reply
      .code(problem.status)
      .header("content-type", "application/problem+json")
      .header("cache-control", "no-store")
      .send(problem.toJSON())
  })
  registerPartyRoutes(app, _dependencies)
  registerPreferenceRoutes(app, _dependencies)
  registerProductRoutes(app, _dependencies)
  registerReferenceRoutes(app, _dependencies)
  return app
}
