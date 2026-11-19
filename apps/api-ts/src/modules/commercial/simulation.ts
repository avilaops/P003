import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { requireCommercialRead } from "./access.js"
import { reloadTenantPermissions } from "../../platform/database.js"
import { Problem } from "../../platform/problem.js"
import { negotiationInputSchema } from "./negotiation-model.js"
import { prepareNegotiation } from "./prepare.js"
import { mixedInputSchema } from "./mixed-model.js"
import { prepareMixed } from "./mixed-prepare.js"

export function registerCommercialSimulation(app: FastifyInstance, dependencies: AppDependencies) {
  app.post("/api/v1/commercial/mixed/simulate", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requireCommercialRead(context)
      await context.client.query("SELECT id FROM tenants WHERE id=$1 FOR SHARE", [context.tenantId])
      const parsed = mixedInputSchema.safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Simulação inválida ou campos desconhecidos")
      const prepared = await prepareMixed(context, parsed.data)
      await reloadTenantPermissions(context)
      requireCommercialRead(context)
      const director = context.permissions.includes("platform.company.manage") && context.permissions.includes("sales.approvals.director") ? prepared.director : null
      return { tenantId: context.tenantId, digest: prepared.digest, sale: {...prepared.sale,...(prepared.sale.approvalReasons.length ? {approvalLevel:prepared.director.requiresDirector?"director":"manager"}:{})}, director }
    }, false)
    return reply.header("cache-control", "no-store").send(body)
  })
  app.post("/api/v1/commercial/simulate", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read")
      await context.client.query("SELECT id FROM tenants WHERE id=$1 FOR SHARE", [context.tenantId])
      const parsed = negotiationInputSchema.safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Simulação inválida ou campos desconhecidos")
      const prepared = await prepareNegotiation(context, parsed.data)
      await reloadTenantPermissions(context)
      const director = context.permissions.includes("platform.company.manage") && context.permissions.includes("sales.approvals.director") ? prepared.director : null
      return { tenantId: context.tenantId, version: prepared.version, digest: prepared.digest, sale: {...prepared.sale,...(prepared.sale.approvalReasons.length ? {approvalLevel:prepared.director.requiresDirector?"director":"manager"}:{})}, director }
    }, false)
    return reply.header("cache-control", "no-store").send(body)
  })
}
