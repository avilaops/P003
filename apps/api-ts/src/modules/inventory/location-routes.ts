import type { FastifyInstance, FastifyRequest } from "fastify"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { locationSettings, setLocations } from "./locations.js"
import { listTransfers, postTransfer, transferItems } from "./transfers.js"
import { registerDocumentLocations } from "./document-locations.js"

export function registerLocationRoutes(app: FastifyInstance, dependencies: AccessDependencies) {
  registerDocumentLocations(app,dependencies)
  function run<T>(request: FastifyRequest, operation: (context: AuthorizedContext) => Promise<T>) {
    return authorizeRequest(request, dependencies, context => {
      requirePermission(context, "inventory.stock.read")
      if (request.method !== "GET") requirePermission(context, "inventory.stock.manage")
      return operation(context)
    })
  }
  function transferId(value: unknown) {
    const id = normalizedDatabaseId.safeParse(value)
    if (!id.success) throw new Problem(422,"invalid_input","Identificador de transferência inválido")
    return id.data
  }
  app.get("/api/v1/stock/locations", (req, reply) => {
    reply.header("cache-control","no-store")
    return run(req, locationSettings)
  })
  app.put("/api/v1/stock/locations", async (req, reply) => {
    const result = await run(req, context => setLocations(context,req.headers,req.body))
    return reply.header("cache-control","no-store").header("etag", '"'+String(result.revision)+'"').send(result)
  })
  app.get("/api/v1/stock/transfers", (req, reply) => {
    reply.header("cache-control","no-store")
    return run(req, context => listTransfers(context,req.query))
  })
  app.get<{ Params: {id: string} }>("/api/v1/stock/transfers/:id", (req, reply) => {
    reply.header("cache-control","no-store")
    return run(req, async context => ({ tenantId: context.tenantId, items: await transferItems(context,transferId(req.params.id)) }))
  })
  app.post("/api/v1/stock/transfers", async (req, reply) => {
    const result = await run(req, context => postTransfer(context,req.headers,req.body))
    return reply.code(201).header("cache-control","no-store").header("etag",'"1"').send(result)
  })
  app.post<{ Params: {id: string} }>("/api/v1/stock/transfers/:id/reverse", async (req, reply) => {
    const result = await run(req, context => postTransfer(context,req.headers,req.body,transferId(req.params.id)))
    return reply.code(201).header("cache-control","no-store").header("etag",'"1"').send(result)
  })
}
