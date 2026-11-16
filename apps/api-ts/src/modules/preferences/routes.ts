import type { FastifyInstance } from "fastify"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { preferencesInputSchema } from "./schema.js"
import { getPreferences, putPreferences } from "./service.js"

function revision(value: string | string[] | undefined): number {
  if (value === undefined) throw new Problem(428, "revision_required", "Recarregue o cadastro antes de salvar")
  if (Array.isArray(value)) throw new Problem(400, "invalid_revision", "Revisão inválida")
  const match = /^"([1-9][0-9]*)"$/.exec(value)
  if (!match?.[1]) throw new Problem(400, "invalid_revision", "Revisão inválida")
  const parsed = Number(match[1])
  if (!Number.isSafeInteger(parsed)) throw new Problem(400, "invalid_revision", "Revisão inválida")
  return parsed
}

export function registerPreferenceRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/preferences", async (request, reply) => {
    const data = await authorizeRequest(request, dependencies, getPreferences)
    return reply.header("cache-control", "no-store").header("etag", `"${data.revision}"`).send(data)
  })
  app.put("/api/v1/preferences", async (request, reply) => {
    const expected = revision(request.headers["if-match"])
    const input = preferencesInputSchema.safeParse(request.body)
    if (!input.success) throw new Problem(422, "invalid_input", "Preferências inválidas ou campos desconhecidos")
    const data = await authorizeRequest(request, dependencies, context => putPreferences(context, expected, input.data))
    return reply.header("cache-control", "no-store").header("etag", `"${data.revision}"`).send(data)
  })
}
