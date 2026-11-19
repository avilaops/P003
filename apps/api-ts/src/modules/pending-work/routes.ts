import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { approvalQueues } from "./approvals.contract.js"
import { pendingWork, pendingWorkSchema } from "./service.js"

/** Permissões que dão acesso a pelo menos um item do painel. Sem nenhuma delas, 403. */
export const pendingWorkPermissions = ["sales.orders.read", "sales.proposals.read", "finance.receivables.read", "finance.payables.read", "finance.accounts.read", "finance.categories.read", "fiscal.config.read"] as const
const noQuery = z.strictObject({})

export function registerPendingWorkRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/pending-work", { config: { openapi: {
    summary: "Painel de pendências do usuário (Visão geral, sino e mobile): só itens com contagem > 0, cada um com o link da lista que mostra o mesmo total",
    query: noQuery, response: pendingWorkSchema,
  } } }, async (request, reply) => {
    if (!noQuery.safeParse(request.query).success) throw new Problem(422, "invalid_input", "O painel de pendências não aceita filtros")
    const body = await authorizeRequest(request, dependencies, async context => {
      const visible = [...pendingWorkPermissions, ...approvalQueues.flatMap(queue => queue.permissions)]
      if (!visible.some(permission => context.permissions.includes(permission))) throw new Problem(403, "forbidden", "Seu perfil não acompanha pendências desta empresa")
      return pendingWork(context)
    })
    return reply.header("cache-control", "no-store").send(body)
  })
}
