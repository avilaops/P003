import type { FastifyInstance } from "fastify"

import type { AccessDependencies } from "../../platform/access.js"

export type PlatformAdminDependencies = Record<string, never>

export function registerPlatformAdminRoutes(_app: FastifyInstance, _dependencies: AccessDependencies, _io?: PlatformAdminDependencies) {
  // Rotas serão registradas aqui (PR #285).
}
