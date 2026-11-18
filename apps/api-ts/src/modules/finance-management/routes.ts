import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../../app.js"
import { registerInvoiceWorker } from "./invoice-worker.js"
import { registerAccounting } from "./accounting.js"
import { registerCommissions } from "./commissions.js"

export function registerFinanceManagementRoutes(app: FastifyInstance, deps: AppDependencies) {
  registerCommissions(app, deps)
  registerAccounting(app, deps)
  registerInvoiceWorker(app, deps.pool)
}
