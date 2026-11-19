import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"

/** Parâmetros do documento de entrada (C5). Migrar ao catálogo de parâmetros (#302/G5) quando existir. */
export const entryParameters = { priceToleranceBps: 0, quantityToleranceBps: 0 }
const input = z.strictObject({ priceToleranceBps: z.number().int().min(0).max(10000), quantityToleranceBps: z.number().int().min(0).max(10000) })

export async function entryTolerance(c: Pick<AuthorizedContext, "client" | "tenantId">) {
  const row = (await c.client.query("SELECT price_tolerance_bps,quantity_tolerance_bps,revision FROM purchase_entry_settings WHERE tenant_id=$1", [c.tenantId])).rows[0]
  return {
    priceToleranceBps: Number(row?.price_tolerance_bps ?? entryParameters.priceToleranceBps),
    quantityToleranceBps: Number(row?.quantity_tolerance_bps ?? entryParameters.quantityToleranceBps),
    revision: revisionValue(row?.revision ?? 1),
    exists: Boolean(row),
  }
}

export function registerEntrySettings(app: FastifyInstance, deps: AppDependencies) {
  const url = "/api/v1/purchase-entry-settings"
  app.get(url, { config: { openapi: { summary: "Tolerância da conciliação de entrada" } } }, async (req, reply) => {
    const body = await authorizeRequest(req, deps, async c => {
      requirePermission(c, "purchasing.orders.read")
      const { exists: _e, ...data } = await entryTolerance(c)
      return { tenantId: c.tenantId, canEdit: c.permissions.includes("platform.company.manage"), data }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })
  app.put(url, { config: { openapi: { summary: "Altera a tolerância da conciliação de entrada", body: input } } }, async (req, reply) => {
    const expected = parseRevision(req.headers["if-match"])
    const body = await authorizeRequest(req, deps, async c => {
      requirePermission(c, "platform.company.manage")
      const parsed = input.safeParse(req.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Informe as tolerâncias de preço e quantidade entre 0 e 10000 pontos-base")
      const current = await entryTolerance(c)
      if (String(current.revision) !== String(expected)) throw new Problem(412, "revision_conflict", "A configuração mudou. Atualize a página")
      const revision = current.exists ? nextRevision(expected) : 1
      await c.client.query(
        `INSERT INTO purchase_entry_settings(tenant_id,price_tolerance_bps,quantity_tolerance_bps,revision) VALUES($1,$2,$3,$4)
         ON CONFLICT(tenant_id) DO UPDATE SET price_tolerance_bps=$2,quantity_tolerance_bps=$3,revision=$4,updated_at=now()`,
        [c.tenantId, parsed.data.priceToleranceBps, parsed.data.quantityToleranceBps, revision],
      )
      await record(c, req.headers, "purchase_entry_settings", c.tenantId, "purchase.entry_settings.updated", { ...parsed.data, revision })
      return { tenantId: c.tenantId, canEdit: true, data: { ...parsed.data, revision } }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })
}
