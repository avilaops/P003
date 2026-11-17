import { z } from "zod"

export const outgoingNfseStatusSchema = z.enum([
  "pending",
  "processing",
  "authorized",
  "rejected",
  "uncertain",
  "cancelled",
])

export type OutgoingNfseStatus = z.infer<typeof outgoingNfseStatusSchema>

const transitions: Readonly<Record<OutgoingNfseStatus, readonly OutgoingNfseStatus[]>> = {
  pending: ["processing", "rejected"],
  processing: ["authorized", "rejected", "uncertain"],
  authorized: ["cancelled"],
  rejected: [],
  uncertain: ["authorized", "rejected"],
  cancelled: [],
}

export function assertOutgoingNfseTransition(from: OutgoingNfseStatus, to: OutgoingNfseStatus) {
  if (transitions[from].includes(to)) return
  if (from === "uncertain" && to === "processing") {
    throw new Error("Emissão incerta exige consulta antes de nova transmissão")
  }
  throw new Error(`Transição de NFS-e inválida: ${from} → ${to}`)
}

const taxIdSchema = z.string().regex(/^(?:\d{11}|\d{14})$/)
const decimalAmountSchema = z.string().regex(/^(?:0|[1-9]\d{0,11})\.\d{2}$/)

export const outgoingNfseCreateSchema = z.object({
  externalId: z.string().trim().min(1).max(120),
  environment: z.enum(["homologation", "production"]),
  competenceDate: z.iso.date(),
  amount: decimalAmountSchema,
  serviceCode: z.string().trim().regex(/^\d{4,9}$/),
  description: z.string().trim().min(1).max(2_000),
  customer: z.object({
    name: z.string().trim().min(1).max(200),
    taxId: taxIdSchema,
    email: z.email().max(320).optional(),
  }).strict(),
}).strict()

export type OutgoingNfseCreateInput = z.infer<typeof outgoingNfseCreateSchema>
