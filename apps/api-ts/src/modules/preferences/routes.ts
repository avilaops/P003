import { parseRevision as revision } from "../../platform/revision.js"
import type { FastifyInstance } from "fastify"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { preferencesInputSchema } from "./schema.js"
import { getPreferences, putPreferences } from "./service.js"

export function registerPreferenceRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/preferences", { config: { openapi: { summary: "Ler preferências da empresa" } } }, async (request, reply) => {
    const data = await authorizeRequest(request, dependencies, getPreferences)
    return reply.header("cache-control", "no-store").header("etag", `"${data.revision}"`).send(data)
  })
  app.put("/api/v1/preferences", { config: { openapi: { summary: "Salvar preferências (If-Match obrigatório)", body: preferencesInputSchema } } }, async (request, reply) => {
    const expected = revision(request.headers["if-match"])
    const input = preferencesInputSchema.safeParse(request.body)
    if (!input.success) throw new Problem(422, "invalid_input", "Preferências inválidas ou campos desconhecidos")
    const data = await authorizeRequest(request, dependencies, context => putPreferences(context, expected, input.data))
    return reply.header("cache-control", "no-store").header("etag", `"${data.revision}"`).send(data)
  })
}
