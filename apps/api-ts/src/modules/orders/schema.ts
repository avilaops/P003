import { z } from "zod"
import { normalizedDatabaseId } from "../../platform/database-id.js"

const option = z.preprocess(value => value === null ? undefined : value, z.string().optional())
export const orderInputSchema = z.strictObject({
  customerId: z.guid().transform(value => value.toLowerCase()), dueDate: z.string(),
  items: z.array(z.strictObject({ productId: normalizedDatabaseId, quantity: z.string(), structureColor: option, swingArmColor: option, armColor: option, plateHolderColor: option, plateHolderType: option, upholsteryColor: option })),
})
export type OrderInput = z.infer<typeof orderInputSchema>
