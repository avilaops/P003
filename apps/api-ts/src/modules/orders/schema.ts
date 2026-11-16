import { z } from "zod"

const option = z.preprocess(value => value === null ? undefined : value, z.string().optional())
export const orderInputSchema = z.strictObject({
  customerId: z.string().uuid().transform(value => value.toLowerCase()), dueDate: z.string(),
  items: z.array(z.strictObject({ productId: z.string().uuid().transform(value => value.toLowerCase()), quantity: z.string(), structureColor: option, swingArmColor: option, armColor: option, plateHolderColor: option, plateHolderType: option, upholsteryColor: option })),
})
export type OrderInput = z.infer<typeof orderInputSchema>
