import type { FastifyInstance } from "fastify"

import type { AccessDependencies } from "../../platform/access.js"

export type SystemConfigDependencies = Record<string, never>

export function registerSystemConfigRoutes(_app: FastifyInstance, _dependencies: AccessDependencies, _io?: SystemConfigDependencies) {
  // Rotas serão registradas aqui (PR #285).
}
