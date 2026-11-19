import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AccessDependencies } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { authorizedDomain, invalid, notFound } from "../../platform/domain.js"

const PERMISSION = "platform.integrations.manage"
const createSchema = z.strictObject({ name: z.string() })
const iso = (value: Date | string) => new Date(value).toISOString()

type Row = { id: string; name: string; key_prefix: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }
const summary = (row: Row) => ({
  id: row.id, name: row.name, keyPrefix: row.key_prefix, createdAt: iso(row.created_at),
  lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null, revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
})

export function registerServiceKeyRoutes(app: FastifyInstance, dependencies: AccessDependencies) {
  app.get("/api/v1/integrations/service-keys", async (request, reply) => {
    reply.header("cache-control", "no-store")
    return authorizedDomain(request, dependencies, PERMISSION, PERMISSION, false, async context => {
      const rows = await context.client.query<Row>("SELECT id,name,key_prefix,created_at,last_used_at,revoked_at FROM service_api_keys WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC", [context.tenantId])
      return { data: rows.rows.map(summary) }
    })
  })

  app.post("/api/v1/integrations/service-keys", async (request, reply) => {
    reply.header("cache-control", "no-store")
    const created = await authorizedDomain(request, dependencies, PERMISSION, PERMISSION, true, async context => {
      const input = createSchema.safeParse(request.body)
      const name = input.success ? input.data.name.trim() : ""
      if (!input.success || ![...name].length || [...name].length < 3 || [...name].length > 100) throw invalid("Nome da credencial deve ter entre 3 e 100 caracteres")
      const id = randomUUID()
      const secret = randomBytes(32).toString("hex")
      const key = `erp_${context.tenantId}_${secret}`
      const keyPrefix = `erp_${context.tenantId}_${secret.slice(0, 8)}`
      // Somente o SHA-256 da chave é persistido; o texto puro existe apenas nesta resposta.
      const hash = createHash("sha256").update(key).digest()
      const inserted = await context.client.query<{ created_at: Date }>(
        "INSERT INTO service_api_keys(id,tenant_id,name,key_prefix,key_hash,created_by_identity_id) SELECT $1,$2,$3,$4,$5,id FROM identities WHERE auth_subject=$6 RETURNING created_at",
        [id, context.tenantId, name, keyPrefix, hash, context.authSubject])
      await record(context, request.headers, "service_api_key", id, "platform.service_key.created", { name, keyPrefix })
      return { id, name, keyPrefix, key, createdAt: iso(inserted.rows[0]!.created_at) }
    })
    return reply.code(201).send(created)
  })

  app.delete<{ Params: { id: string } }>("/api/v1/integrations/service-keys/:id", async (request, reply) => {
    reply.header("cache-control", "no-store")
    await authorizedDomain(request, dependencies, PERMISSION, PERMISSION, true, async context => {
      if (!z.guid().safeParse(request.params.id).success) throw notFound()
      const id = request.params.id.toLowerCase()
      const changed = await context.client.query("UPDATE service_api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id", [context.tenantId, id])
      if (changed.rows.length === 0) {
        const exists = await context.client.query("SELECT 1 FROM service_api_keys WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])
        if (exists.rows.length === 0) throw notFound()
      } else await record(context, request.headers, "service_api_key", id, "platform.service_key.revoked", {})
    })
    return reply.code(204).send()
  })
}
