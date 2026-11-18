import type { FastifyInstance } from "fastify"
import { authorizeRequest, requirePermission, type AccessDependencies } from "../../platform/access.js"
import { balances, history } from "./queries.js"
import { postMovement } from "./commands.js"
import { registerManualSettings } from "./manual-settings.js"
import { registerPeriods } from "./periods.js"
import { registerReplenishment } from "./replenishment.js"
import { registerSerials } from "./serials.js"

export function registerStockRoutes(app: FastifyInstance, dependencies: AccessDependencies) {
  registerManualSettings(app,dependencies)
  registerPeriods(app,dependencies)
  registerReplenishment(app,dependencies)
  registerSerials(app,dependencies)
  for (const [path, load] of [["/stock", balances], ["/stock/movements", history]] as const) {
    app.get(`/api/v1${path}`, async (request, reply) => {
      reply.header("cache-control", "no-store")
      return authorizeRequest<unknown>(request, dependencies, context => {
        requirePermission(context, "inventory.stock.read")
        return load(context, request.query)
      })
    })
  }
  app.post("/api/v1/stock/movements", async (request, reply) => {
    const result = await authorizeRequest(request, dependencies, context => postMovement(context, request.headers, request.body))
    return reply.code(201).header("cache-control", "no-store").send(result)
  })
}
