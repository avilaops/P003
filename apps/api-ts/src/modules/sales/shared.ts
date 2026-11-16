import { revisionValue } from "../../platform/revision.js"
import { z } from "zod"

import { Problem } from "../../platform/problem.js"
import { integer, queryInteger, searchQuery } from "../registrations/query.js"

export const salesListSchema = z.strictObject({
  q: searchQuery, status: z.string().max(20).default(""), sort: z.enum(["created", "updated"]).default("created"),
  offset: queryInteger(0, 100_000).default(0), limit: queryInteger(1, 100).default(25),
})

export function queryInput(value: unknown, statuses: readonly string[], proposal = false) {
  const parsed = salesListSchema.safeParse(value)
  if (!parsed.success || !statuses.includes(parsed.data.status)) throw new Problem(422, "invalid_input", "Filtros inválidos")
  if ((proposal ? /\u0000/u : /\p{Cc}/u).test(parsed.data.q)) throw new Problem(422, "invalid_input", proposal ? "Texto obrigatório ausente ou fora do limite" : "Pesquisa inválida")
  return { ...parsed.data, q: parsed.data.q.trim() }
}

export function orderSearchNumber(value: string): string | null {
  const normalized = value.replace(/[a-z]/g, character => character.toUpperCase()), number = normalized.startsWith("PV-") ? normalized.slice(3) : normalized
  if (!/^\+?[0-9]+$/.test(number)) return null
  const exact = BigInt(number)
  return exact > 0n && exact <= 9223372036854775807n ? exact.toString() : null
}

export function orderSummary(row: Record<string, unknown>) {
  return { id: row.id, number: String(row.number), customerId: row.customer_id, customerName: row.customer_name, customerTaxId: row.customer_tax_id, dueDate: row.due_date, amount: row.amount, status: row.status, revision: revisionValue(row.revision), updatedAt: row.updated_at, pricingOrigin: row.pricing_origin }
}

export function proposalSummary(row: Record<string, unknown>) {
  return { id: row.id, number: String(row.number), version: integer(row.version), revision: revisionValue(row.revision), customerId: row.customer_id, customerName: row.customer_name, customerTaxId: row.customer_tax_id, validUntil: row.valid_until, paymentTerms: row.payment_terms, deliveryTerms: row.delivery_terms, notes: row.notes, amount: row.amount, status: row.status, expired: row.expired, orderId: row.order_id, isCurrent: row.is_current, createdAt: row.created_at, updatedAt: row.updated_at, sentAt: row.sent_at, decidedAt: row.decided_at, decidedBy: row.decided_by, decisionReason: row.decision_reason }
}
