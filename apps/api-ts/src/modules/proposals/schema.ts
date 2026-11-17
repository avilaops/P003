import { z } from "zod"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { mixedInputSchema } from "../commercial/mixed-model.js"
import { checkoutInputSchema } from "../orders/checkout-save.js"

const optional = z.preprocess(value => value === null ? undefined : value, z.string().optional())
const nullable = z.string().nullable().default(null)
export const proposalInputSchema = z.strictObject({
  customerId: z.string().uuid().transform(value => value.toLowerCase()), validUntil: z.string(), paymentTerms: z.string(), deliveryTerms: z.string(), notes: z.string(),
  commercial: z.strictObject({ simulation: mixedInputSchema, digest: z.string() }).optional(),
  checkout: checkoutInputSchema.optional(),
  items: z.array(z.strictObject({
    productId: normalizedDatabaseId, quantity: z.string(), unitPrice: nullable, structureColor: nullable, upholsteryColor: nullable,
    swingArmColor: optional, armColor: optional, plateHolderColor: optional, plateHolderType: optional,
  })),
}).transform(input => {
  for (const item of input.items) {
    if (item.armColor !== undefined) {
      const lowerAscii = (value: string) => value.trim().replace(/[A-Z]/g, c => c.toLowerCase())
      if (item.plateHolderColor !== undefined && lowerAscii(item.plateHolderColor) !== lowerAscii(item.armColor)) throw new Problem(422, "invalid_input", "Informe a cor dos anilheiros apenas em plateHolderColor")
      item.plateHolderColor ??= item.armColor
      delete item.armColor
    }
  }
  return input
})
export type ProposalInput = z.infer<typeof proposalInputSchema>
export function proposalId(value: string) {
  const id = z.string().uuid().safeParse(value)
  if (!id.success) throw new Problem(422, "invalid_input", "Identificador inválido")
  return id.data.toLowerCase()
}
export function proposalText(raw: string, limit: number, required: boolean) {
  const value = raw.trim()
  if (required && !value || Array.from(value).length > limit || value.includes("\0")) throw new Problem(422, "invalid_input", "Texto obrigatório ausente ou fora do limite")
  return value
}
export function proposalTransition(status: string, action: string, validity: string, today: string, converted: boolean) {
  const conflict = (title: string): never => { throw new Problem(409, "domain_conflict", title) }
  if (converted) conflict("Proposta já convertida em pedido")
  if (status === "draft" && action === "send" && validity >= today) return "sent"
  if (status === "sent" && action === "accept" && validity >= today) return "accepted"
  if (status === "sent" && action === "reject") return "rejected"
  if (["draft", "sent", "accepted"].includes(status) && action === "cancel") return "cancelled"
  if (["sent", "rejected", "accepted"].includes(status) && action === "revise") return "superseded"
  if (status === "accepted" && action === "convert") return "accepted"
  if (["draft", "sent", "accepted"].includes(status) && action === "approve-order") return validity >= today ? "accepted" : conflict("A validade expirou; revise a proposta antes de aprovar")
  if (status === "draft" && action === "send" || status === "sent" && action === "accept") conflict("A validade expirou; revise a proposta antes de enviar ou aceitar")
  return conflict("Ação incompatível com a situação da proposta")
}
