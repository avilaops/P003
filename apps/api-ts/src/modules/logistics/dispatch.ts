import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import { requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { databaseId } from "../../platform/database-id.js"
import { authorizedDomain, conflict, notFound } from "../../platform/domain.js"
import { CHECKOUT_MANAGE, CHECKOUT_READ, parseBody, POSTINGS_MANAGE, POSTINGS_READ, reply, validId } from "./shared.js"

// Porte de `apps/api/src/domains/logistics_dispatch.rs`: fila de etiquetas e vínculo de volumes à postagem.
export const postingPackagesSchema = z.strictObject({ checkoutId: databaseId.transform(value => value.toLowerCase()) })
const emptyBody = z.union([z.undefined(), z.null(), z.strictObject({})])

async function labels(context: AuthorizedContext, checkoutId: string | null) {
  const rows = await context.client.query("SELECT j.id,j.checkout_id,j.package_id,j.status,j.created_at,p.package_number,p.label_code FROM logistics_label_jobs j JOIN logistics_checkout_packages p ON p.tenant_id=j.tenant_id AND p.id=j.package_id WHERE j.tenant_id=$1 AND ($2::uuid IS NULL OR j.checkout_id=$2) ORDER BY j.created_at DESC,j.id DESC LIMIT 100", [context.tenantId, checkoutId])
  return rows.rows.map(row => ({ id: row.id, checkoutId: row.checkout_id, packageId: row.package_id, packageNumber: row.package_number, labelCode: row.label_code, status: row.status, createdAt: row.created_at }))
}

export function registerDispatch(app: FastifyInstance, dependencies: AccessDependencies) {
  app.get("/api/v1/logistics/labels", { config: { openapi: { summary: "Listar a fila de etiquetas da empresa" } } }, async (request, response) => {
    const body = await authorizedDomain(request, dependencies, CHECKOUT_READ, CHECKOUT_MANAGE, false, async (context, canEdit) =>
      ({ tenantId: context.tenantId, canEdit, data: await labels(context, null) }))
    return reply(response, 200, body)
  })

  // No Rust esta rota ignorava o `{id}` e listava a fila inteira; aqui filtra pela conferência.
  app.get<{ Params: { id: string } }>("/api/v1/logistics/checkouts/:id/labels", { config: { openapi: { summary: "Listar etiquetas de uma conferência" } } }, async (request, response) => {
    if (!validId(request.params.id)) throw notFound()
    const body = await authorizedDomain(request, dependencies, CHECKOUT_READ, CHECKOUT_MANAGE, false, async (context, canEdit) => {
      const exists = await context.client.query("SELECT 1 FROM logistics_checkouts WHERE tenant_id=$1 AND id=$2", [context.tenantId, request.params.id])
      if (!exists.rows.length) throw notFound()
      return { tenantId: context.tenantId, canEdit, data: await labels(context, request.params.id) }
    })
    return reply(response, 200, body)
  })

  app.post<{ Params: { id: string } }>("/api/v1/logistics/checkouts/:id/labels", { config: { openapi: { summary: "Enfileirar etiquetas dos volumes etiquetados (Idempotency-Key)", successStatus: 201 } } }, async (request, response) => {
    const key = commandKey(request.headers["idempotency-key"])
    if (!validId(request.params.id)) throw notFound()
    const checkoutId = request.params.id
    const result = await authorizedDomain(request, dependencies, CHECKOUT_READ, CHECKOUT_MANAGE, true, async context => {
      parseBody(emptyBody, request.body, "Entrada inválida")
      const commandRequest = { checkoutId }
      const previous = await replay(context, key, "logistics.labels.queue", commandRequest)
      if (previous) return { replayed: true, body: previous }
      const checkout = (await context.client.query<{ status: string }>("SELECT status FROM logistics_checkouts WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, checkoutId])).rows[0]
      if (!checkout) throw notFound()
      if (checkout.status === "cancelled") throw conflict("Checkout cancelado")
      const packages = await context.client.query<{ id: string }>("SELECT id FROM logistics_checkout_packages WHERE tenant_id=$1 AND checkout_id=$2 AND status='labelled' ORDER BY package_number", [context.tenantId, checkoutId])
      if (!packages.rows.length) throw conflict("Nenhum volume etiquetável encontrado")
      const jobIds: string[] = []
      for (const item of packages.rows) {
        const job = await context.client.query<{ id: string }>("INSERT INTO logistics_label_jobs(id,tenant_id,checkout_id,package_id) VALUES($1,$2,$3,$4) ON CONFLICT (tenant_id,package_id) DO UPDATE SET updated_at=now() RETURNING id", [randomUUID(), context.tenantId, checkoutId, item.id])
        jobIds.push(job.rows[0]!.id)
      }
      const body = { tenantId: context.tenantId, data: { checkoutId, jobIds, status: "queued" } }
      await record(context, request.headers, "logistics_labels", checkoutId, "logistics.labels.queued", body)
      await remember(context, key, "logistics.labels.queue", commandRequest, body)
      return { replayed: false, body }
    })
    return reply(response, result.replayed ? 200 : 201, result.body)
  })

  app.post<{ Params: { id: string } }>("/api/v1/logistics/postings/:id/packages", { config: { openapi: { summary: "Vincular volumes embalados à postagem (Idempotency-Key)", body: postingPackagesSchema } } }, async (request, response) => {
    const key = commandKey(request.headers["idempotency-key"])
    if (!validId(request.params.id)) throw notFound()
    const postingId = request.params.id
    const body = await authorizedDomain(request, dependencies, CHECKOUT_READ, CHECKOUT_MANAGE, true, async context => {
      // O vínculo altera a postagem: além da conferência, exige gestão de postagens (o Rust não exigia).
      requirePermission(context, POSTINGS_READ)
      requirePermission(context, POSTINGS_MANAGE)
      const input = parseBody(postingPackagesSchema, request.body, "Entrada inválida")
      const commandRequest = { postingId, ...input }
      const previous = await replay(context, key, "logistics.posting.packages", commandRequest)
      if (previous) return previous
      const posting = (await context.client.query<{ status: string }>("SELECT status FROM logistics_postings WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, postingId])).rows[0]
      if (!posting) throw notFound()
      if (posting.status === "cancelled" || posting.status === "delivered") throw conflict("Postagem encerrada não recebe volumes")
      const packages = await context.client.query<{ id: string; posting_id: string | null }>("SELECT p.id,l.posting_id FROM logistics_checkout_packages p LEFT JOIN logistics_posting_packages l ON l.tenant_id=p.tenant_id AND l.package_id=p.id WHERE p.tenant_id=$1 AND p.checkout_id=$2 AND p.status='packed' ORDER BY p.package_number", [context.tenantId, input.checkoutId])
      if (!packages.rows.length) throw conflict("Nenhum volume embalado encontrado")
      if (packages.rows.some(item => item.posting_id !== null && item.posting_id !== postingId)) throw conflict("Há volume desta conferência vinculado a outra postagem")
      for (const item of packages.rows) {
        await context.client.query("INSERT INTO logistics_posting_packages(tenant_id,posting_id,package_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [context.tenantId, postingId, item.id])
      }
      const result = { tenantId: context.tenantId, data: { postingId, checkoutId: input.checkoutId, packageIds: packages.rows.map(item => item.id) } }
      await record(context, request.headers, "logistics_posting", postingId, "logistics.posting.packages_linked", result)
      await remember(context, key, "logistics.posting.packages", commandRequest, result)
      return result
    })
    return reply(response, 200, body)
  })
}
