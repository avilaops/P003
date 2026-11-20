import type { FastifyInstance } from "fastify"

import type { AccessDependencies } from "../../platform/access.js"
import { registerCheckouts } from "./checkouts.js"
import { registerDispatch } from "./dispatch.js"
import { registerPostings } from "./postings.js"

/** Logística: postagens, conferência de pedidos (checkout), volumes e fila de etiquetas. */
export function registerLogisticsRoutes(app: FastifyInstance, dependencies: AccessDependencies) {
  registerPostings(app, dependencies)
  registerCheckouts(app, dependencies)
  registerDispatch(app, dependencies)
}
