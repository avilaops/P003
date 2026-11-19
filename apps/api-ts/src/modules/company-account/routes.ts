import type { FastifyInstance } from "fastify"

import type { AccessDependencies } from "../../platform/access.js"

export type CompanyAccountDependencies = Record<string, never>

export function registerCompanyAccountRoutes(_app: FastifyInstance, _dependencies: AccessDependencies, _io?: CompanyAccountDependencies) {
  // Rotas serão registradas aqui (PR #285).
}
