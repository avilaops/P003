import type { FastifyInstance } from "fastify"

import type { AccessDependencies } from "../../platform/access.js"
import { registerCustomFields } from "./custom-fields.js"
import { registerFiles } from "./files.js"
import { registerLabelTemplates } from "./label-templates.js"
import { registerWorkflows } from "./workflows.js"

export type SystemConfigDependencies = Record<string, never>

export function registerSystemConfigRoutes(app: FastifyInstance, dependencies: AccessDependencies, _io?: SystemConfigDependencies) {
  registerCustomFields(app, dependencies)
  registerLabelTemplates(app, dependencies)
  registerWorkflows(app, dependencies)
  registerFiles(app, dependencies)
}
