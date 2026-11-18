import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { authorizeRequest, requirePermission, type AccessDependencies } from "../../platform/access.js"
import { BrowserUseRunError, runBrowserTask, type BrowserUseRuns } from "../../platform/browser-use.js"
import { Problem } from "../../platform/problem.js"

/** Runs spend the company's Browser Use credits, so only company administrators may start them. */
export const BROWSER_USE_PERMISSION = "platform.company.manage"
/** Upper bound for one HTTP request; the run is cancelled when it is exceeded. */
export const BROWSER_USE_ROUTE_TIMEOUT_MS = 5 * 60_000

export type BrowserUseDependencies = { runs: BrowserUseRuns; timeoutMs?: number }

const runRequestSchema = z.strictObject({
  task: z.string().trim().min(1).max(4_000),
  model: z.string().trim().min(1).max(64).optional(),
})

export function registerBrowserUseRoutes(app: FastifyInstance, dependencies: AccessDependencies, browserUse?: BrowserUseDependencies) {
  app.post("/api/v1/integrations/browser-use/runs", async (request, reply) => {
    reply.header("cache-control", "no-store")
    // Short read-only transaction: check the permission, then release the connection before the long run.
    await authorizeRequest(request, dependencies, async context => requirePermission(context, BROWSER_USE_PERMISSION), false)
    if (!browserUse) throw new Problem(503, "integration_unavailable", "Integração com o Browser Use não configurada")

    const body = runRequestSchema.safeParse(request.body)
    if (!body.success) throw new Problem(422, "invalid_input", "Tarefa inválida ou campos desconhecidos")

    try {
      return await runBrowserTask(body.data.task, {
        runs: browserUse.runs,
        timeoutMs: browserUse.timeoutMs ?? BROWSER_USE_ROUTE_TIMEOUT_MS,
        ...(body.data.model ? { model: body.data.model } : {}),
      })
    } catch (error) {
      if (error instanceof BrowserUseRunError && error.runId && !error.status) throw new Problem(504, "integration_timeout", "A execução no Browser Use não terminou a tempo e foi cancelada")
      if (error instanceof BrowserUseRunError && error.runId) throw new Problem(502, "integration_failed", "A execução no Browser Use não concluiu com um resultado válido")
      throw new Problem(502, "integration_unavailable", "Browser Use indisponível para iniciar a execução")
    }
  })
}
