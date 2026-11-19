import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { decimal, fixed } from "../sales/fixed.js"

// Sales and purchase settings share one contract: minimum order, longest payment term and contact rule.
type Kind = { path: string; table: string; contact: "require_customer_contact" | "require_supplier_contact"; field: "requireCustomerContact" | "requireSupplierContact"; read: string; entity: string; event: string }
const kinds: Kind[] = [
  { path: "/api/v1/sales-settings", table: "sales_settings", contact: "require_customer_contact", field: "requireCustomerContact", read: "sales.orders.read", entity: "sales_settings", event: "sales.settings.updated" },
  { path: "/api/v1/purchase-settings", table: "purchase_settings", contact: "require_supplier_contact", field: "requireSupplierContact", read: "purchasing.orders.read", entity: "purchase_settings", event: "purchase.settings.updated" },
]
const maximumCents = 99_999_999_999_999n

function schema(kind: Kind) {
  return z.strictObject({ minimumOrderAmount: z.string(), maximumPaymentTermDays: z.number().int().min(0).max(3650), [kind.field]: z.boolean() })
}
type Data = { minimumOrderAmount: string; maximumPaymentTermDays: number } & Record<string, string | number | boolean>

async function snapshot(context: AuthorizedContext, kind: Kind) {
  const { rows: [row] } = await context.client.query<Record<string, unknown>>(`SELECT revision,minimum_order_amount_cents,maximum_payment_term_days,${kind.contact} AS contact FROM ${kind.table} WHERE tenant_id=$1`, [context.tenantId])
  const data: Data | null = row ? { minimumOrderAmount: decimal(BigInt(String(row.minimum_order_amount_cents)), 2), maximumPaymentTermDays: Number(row.maximum_payment_term_days), [kind.field]: Boolean(row.contact) } : null
  return { tenantId: context.tenantId, revision: revisionValue(row?.revision ?? 1), canEdit: context.permissions.includes("platform.company.manage"), data }
}

export function registerOrderSettings(app: FastifyInstance, dependencies: AppDependencies) {
  for (const kind of kinds) {
    app.get(kind.path, async (request, reply) => {
      const body = await authorizeRequest(request, dependencies, async context => {
        if (!["platform.company.manage", "platform.company.read", kind.read].some(permission => context.permissions.includes(permission))) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
        return snapshot(context, kind)
      })
      return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body)
    })
    app.put(kind.path, async (request, reply) => {
      const expected = parseRevision(request.headers["if-match"])
      const body = await authorizeRequest(request, dependencies, async context => {
        requirePermission(context, "platform.company.manage")
        const parsed = schema(kind).safeParse(request.body)
        if (!parsed.success) throw new Problem(422, "invalid_input", "Preencha os três parâmetros, sem campos desconhecidos")
        const input = parsed.data as Data
        const cents = fixed(input.minimumOrderAmount, 2)
        if (cents > maximumCents) throw new Problem(422, "invalid_input", "Valor mínimo ou prazo fora do limite permitido")
        const current = await snapshot(context, kind)
        if (current.revision !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
        const next = nextRevision(expected), data: Data = { ...input, minimumOrderAmount: decimal(cents, 2) }
        await context.client.query(`INSERT INTO ${kind.table}(tenant_id,minimum_order_amount_cents,maximum_payment_term_days,${kind.contact},revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id) DO UPDATE SET minimum_order_amount_cents=$2,maximum_payment_term_days=$3,${kind.contact}=$4,revision=$5,updated_at=now()`, [context.tenantId, cents, input.maximumPaymentTermDays, input[kind.field], next])
        await record(context, request.headers, kind.entity, context.tenantId, kind.event, { previousRevision: expected, revision: next, previous: current.data, data })
        return { ...current, revision: next, data }
      })
      return reply.header("cache-control", "no-store").header("etag", `"${body.revision}"`).send(body)
    })
  }
}
