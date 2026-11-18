import { z } from "zod"
import { Problem } from "../../platform/problem.js"
import { queryInteger } from "../registrations/query.js"
import { STATES } from "../commercial/parameters.js"
import { decimal } from "../sales/fixed.js"

export function invalid(title: string): never { throw new Problem(422, "invalid_input", title) }
export function conflict(title: string): never { throw new Problem(409, "domain_conflict", title) }
export function missing(): never { throw new Problem(404, "not_found", "Registro não encontrado") }
export const uuid = z.guid().transform(value => value.toLowerCase())
const text = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum).refine(value => !/\p{Cc}/u.test(value))
export const register = text(1, 80)
const amount = z.string().regex(/^(0|[1-9][0-9]{0,11})\.[0-9]{2}$/)
export const optionalId = uuid.nullish().transform(value => value ?? null)
export const openInput = z.strictObject({ register, cashAccountId: uuid, openingAmount: amount })
export const movementInput = z.strictObject({ direction: z.enum(["supply","withdrawal"]), amount, reason: text(3,200), sourceAccountId: optionalId, targetAccountId: optionalId })
export const closeInput = z.strictObject({ countedCash: amount, reason: text(3,500).nullish().transform(v => v ?? null) })
export const cancelInput = z.strictObject({ reason: text(3,500) })
export const checkoutInput = z.strictObject({
  items: z.array(z.strictObject({ productId: uuid, quantity: z.string().regex(/^(0|[1-9][0-9]{0,11})\.[0-9]{6}$/) })).min(1).max(100),
  payments: z.array(z.strictObject({ method: z.enum(["cash","pix","debit","credit"]), amount, accountId: uuid, tendered: amount.nullish().transform(v => v ?? null) })).min(1).max(20),
  expectedTotal: amount, customerId: optionalId, destination: z.enum(STATES), taxpayer: z.boolean()
})
const paging = { offset: queryInteger(0,100_000).default(0), limit: queryInteger(1,100).default(25) }
export const sessionsQuery = z.strictObject({ ...paging, register: register.optional(), status: z.enum(["open","closed"]).optional(), startDate: z.iso.date().optional(), endDate: z.iso.date().optional() })
export const currentQuery = z.strictObject({ register: register.optional() })
export const salesQuery = z.strictObject({ ...paging, sessionId: uuid.optional(), status: z.enum(["completed","cancelled"]).optional() })
export const productsQuery = z.strictObject({ ...paging, search: z.string().max(200).default(""), destination: z.enum(STATES), taxpayer: z.enum(["true","false"]).transform(v => v === "true") })
export function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  return result.success ? result.data : invalid("Verifique os campos do PDV e o formato dos valores")
}
export const money = (cents: bigint) => cents < 0n ? "-" + decimal(-cents, 2) : decimal(cents, 2)
export const minor = (value: string) => BigInt(value.replace(".", ""))
export type Open = z.infer<typeof openInput>
export type Close = z.infer<typeof closeInput>
export type Movement = z.infer<typeof movementInput>
export type Checkout = z.infer<typeof checkoutInput>
export type SessionsQuery = z.infer<typeof sessionsQuery>
export type SalesQuery = z.infer<typeof salesQuery>
export type ProductsQuery = z.infer<typeof productsQuery>
