import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../../app.js"
import { registerCteDistribution } from "./distribution.js"
import { registerCteInspection } from "./inspection.js"
import { registerCteLinks } from "./links.js"

/** Distribuição, conferência e vínculos comerciais de CT-e recebido (homologação). */
export function registerFiscalCte(app: FastifyInstance, deps: AppDependencies) {
  registerCteDistribution(app, deps)
  registerCteInspection(app, deps)
  registerCteLinks(app, deps)
}
