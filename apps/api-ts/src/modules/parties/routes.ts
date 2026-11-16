import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { integer, parseListQuery } from "../registrations/query.js"

const partyQuerySchema = z.strictObject({
  q: z.string().max(160).default(""), status: z.enum(["active", "archived"]).optional(),
  role: z.enum(["customer", "supplier"]).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

function party(row: Record<string, unknown>) {
  return {
    id: row.id, revision: integer(row.revision), personType: row.person_type,
    legalName: row.legal_name, tradeName: row.trade_name, taxId: row.tax_id,
    email: row.email, phone: row.phone, isCustomer: row.is_customer,
    isSupplier: row.is_supplier, status: row.status, fiscal: row.fiscal,
    addresses: row.addresses ?? [], contacts: row.contacts ?? [],
  }
}

export function registerPartyRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/parties", async (request, reply) => {
    const parsed = partyQuerySchema.safeParse(request.query)
    if (!parsed.success) throw new Problem(422, "invalid_input", "Busca, paginação, situação ou papel inválido")
    const query = { ...parsed.data, q: parsed.data.q.trim() }
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "catalog.parties.read")
      const canEdit = context.permissions.includes("catalog.parties.manage")
      const rows = await context.client.query(
        "SELECT id,revision,person_type,legal_name,trade_name,tax_id,email,phone,is_customer,is_supplier,status,addresses,contacts,fiscal FROM parties WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND (strpos(lower(legal_name),lower($3))>0 OR strpos(lower(COALESCE(trade_name,'')),lower($3))>0 OR strpos(tax_id,upper($3))>0) AND ($4::text IS NULL OR ($4='customer' AND is_customer) OR ($4='supplier' AND is_supplier)) ORDER BY legal_name,id LIMIT $5 OFFSET $6",
        [context.tenantId, query.status ?? null, query.q, query.role ?? null, query.limit, query.offset],
      )
      const count = await context.client.query<{ total: string }>(
        "SELECT count(*)::text AS total FROM parties WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND (strpos(lower(legal_name),lower($3))>0 OR strpos(lower(COALESCE(trade_name,'')),lower($3))>0 OR strpos(tax_id,upper($3))>0) AND ($4::text IS NULL OR ($4='customer' AND is_customer) OR ($4='supplier' AND is_supplier))",
        [context.tenantId, query.status ?? null, query.q, query.role ?? null],
      )
      return { tenantId: context.tenantId, canEdit, data: rows.rows.map(party), total: integer(count.rows[0]?.total ?? 0), offset: query.offset, limit: query.limit }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
}
