import type { FastifyInstance, FastifyRequest } from "fastify"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { approveCount } from "./count-approval.js"
import { cancelCount, countLine, createCount } from "./count-commands.js"
import { countDetail, listCounts } from "./count-query.js"

export function registerCountRoutes(app: FastifyInstance, deps: AccessDependencies) {
  const path = "/api/v1/inventory-counts"
  type Params = { Params: { id: string } }
  function run<T>(req: FastifyRequest, permission: string, op: (ctx: AuthorizedContext) => Promise<T>) {
    return authorizeRequest(req, deps, (ctx) => {
      requirePermission(ctx, "inventory.counts.read")
      requirePermission(ctx, permission)
      return op(ctx)
    })
  }
  function id(raw: string) {
    const parsed = normalizedDatabaseId.safeParse(raw)
    if (!parsed.success) throw new Problem(404, "not_found", "Identificador de inventário inválido")
    return parsed.data
  }
  app.get(path, (req, reply) => {
    reply.header("cache-control", "no-store")
    return run(req, "inventory.counts.read", (ctx) => listCounts(ctx, req.query))
  })
  app.get<Params>(path + "/:id", async (req, reply) => {
    const data = await run(req, "inventory.counts.read", (ctx) => countDetail(ctx, id(req.params.id)))
    return reply
      .header("cache-control", "no-store")
      .header("etag", '"' + String(data.count.revision) + '"')
      .send(data)
  })
  app.post(path, async (req, reply) => {
    const data = await run(req, "inventory.counts.manage", (ctx) => createCount(ctx, req.headers, req.body))
    return reply
      .code(201)
      .header("cache-control", "no-store")
      .header("etag", '"' + String(data.revision) + '"')
      .send(data)
  })
  app.post<Params>(path + "/:id/lines", async (req, reply) => {
    await run(req, "inventory.counts.manage", (ctx) => countLine(ctx, req.headers, id(req.params.id), req.body))
    return reply.code(204).header("cache-control", "no-store").send()
  })
  app.post<Params>(path + "/:id/approve", async (req, reply) => {
    const data = await run(req, "inventory.counts.approve", (ctx) => approveCount(ctx, req.headers, id(req.params.id)))
    return reply.header("cache-control", "no-store").send(data)
  })
  app.post<Params>(path + "/:id/cancel", async (req, reply) => {
    const data = await run(req, "inventory.counts.manage", (ctx) => cancelCount(ctx, req.headers, id(req.params.id), req.body))
    return reply.header("cache-control", "no-store").send(data)
  })
}
