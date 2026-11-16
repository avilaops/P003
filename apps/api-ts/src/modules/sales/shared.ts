import { z } from "zod"

import { Problem } from "../../platform/problem.js"
import { integer } from "../registrations/query.js"

export const salesListSchema = z.strictObject({
  q: z.string().max(160).default(""), status: z.string().max(20).default(""), sort: z.enum(["created", "updated"]).default("created"),
  offset: z.coerce.number().int().min(0).max(100_000).default(0), limit: z.coerce.number().int().min(1).max(100).default(25),
})

export function queryInput(value: unknown, statuses: readonly string[]) {
  const parsed = salesListSchema.safeParse(value)
  if (!parsed.success || !statuses.includes(parsed.data.status)) throw new Problem(422, "invalid_input", "Filtros inválidos")
  return { ...parsed.data, q: parsed.data.q.trim() }
}

export function orderSummary(row: Record<string, unknown>) {
  return { id: row.id, number: String(row.number), customerId: row.customer_id, customerName: row.customer_name, customerTaxId: row.customer_tax_id, dueDate: row.due_date, amount: row.amount, status: row.status, revision: integer(row.revision), updatedAt: row.updated_at, pricingOrigin: row.pricing_origin }
}

export function proposalSummary(row: Record<string, unknown>) {
  return { id: row.id, number: String(row.number), version: integer(row.version), revision: integer(row.revision), customerId: row.customer_id, customerName: row.customer_name, customerTaxId: row.customer_tax_id, validUntil: row.valid_until, paymentTerms: row.payment_terms, deliveryTerms: row.delivery_terms, notes: row.notes, amount: row.amount, status: row.status, expired: row.expired, orderId: row.order_id, isCurrent: row.is_current, createdAt: row.created_at, updatedAt: row.updated_at, sentAt: row.sent_at, decidedAt: row.decided_at, decidedBy: row.decided_by, decisionReason: row.decision_reason }
}
