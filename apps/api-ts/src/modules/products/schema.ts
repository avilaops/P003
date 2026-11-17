import { z } from "zod"
import { databaseId } from "../../platform/database-id.js"

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(value => value === null ? undefined : value, schema.optional())
const asciiUpper = (value: string) => value.replace(/[a-z]/g, character => character.toUpperCase())
const asciiLower = (value: string) => value.replace(/[A-Z]/g, character => character.toLowerCase())
const options = z.array(z.string().trim().refine(value => value.length > 0 && [...value].length <= 60 && !/\p{Cc}/u.test(value))).max(32).refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length)
const types = options.refine(values => values.length <= 2 && values.every(value => ["Standard", "Olímpico"].includes(value)))
function validPhoto(value: string) {
  if (value === "") return true
  if (value.length > 350000 || !value.startsWith("data:image/jpeg;base64,")) return false
  const encoded = value.slice("data:image/jpeg;base64,".length)
  const bytes = Buffer.from(encoded, "base64")
  return bytes.toString("base64") === encoded && bytes.length <= 262144 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217
}

export const productInputSchema = z.strictObject({
  categoryId: optional(z.string().trim().pipe(z.union([z.literal(""), databaseId]))),
  photoDataUrl: optional(z.string().refine(validPhoto)),
  sku: z.string().trim().transform(asciiUpper).pipe(z.string().min(1).max(80).regex(/^[A-Z0-9._/-]+$/)),
  name: z.string().trim().refine(value => value.length > 0 && [...value].length <= 200),
  unit: z.string().trim().transform(asciiUpper).pipe(z.string().regex(/^[A-Z]{1,6}$/)),
  ncm: z.string().regex(/^\d{8}$/).nullish().transform(value => value ?? null), cest: z.string().regex(/^\d{7}$/).nullish().transform(value => value ?? null),
  basePrice: z.string().regex(/^(0|[1-9]\d{0,11})\.\d{2}$/), status: z.enum(["active", "archived"]),
  structureColors: optional(options), swingArmColors: optional(options), upholsteryColors: optional(options),
  finishingPalette: optional(z.string().trim().pipe(z.enum(["", "dhz-hammerforce-pro", "dhz-sforce", "dhz-combined"]))),
  armColors: optional(options), plateHolderColors: optional(options), plateHolderTypes: optional(types),
  plateHolderType: optional(z.string().trim().toLowerCase().pipe(z.enum(["", "standard", "olympic", "olímpico"]))),
}).superRefine((value, context) => {
  if (value.armColors && value.plateHolderColors && JSON.stringify(value.armColors.map(asciiLower)) !== JSON.stringify(value.plateHolderColors.map(asciiLower))) context.addIssue({ code: "custom", message: "Informe as cores dos anilheiros apenas em plateHolderColors" })
  if (value.plateHolderType !== undefined && value.plateHolderTypes) {
    const legacy = value.plateHolderType === "" ? [] : [value.plateHolderType === "standard" ? "Standard" : "Olímpico"]
    if (JSON.stringify(value.plateHolderTypes.map(asciiLower)) !== JSON.stringify(legacy.map(asciiLower))) context.addIssue({ code: "custom", message: "Informe os tipos de anilheiro apenas em plateHolderTypes" })
  }
}).transform(({ armColors, plateHolderType, ...input }) => {
  if (input.plateHolderColors === undefined && armColors !== undefined) input.plateHolderColors = armColors
  if (input.plateHolderTypes === undefined && plateHolderType !== undefined) input.plateHolderTypes = plateHolderType === "" ? [] : [plateHolderType === "standard" ? "Standard" : "Olímpico"]
  // Rust skips Option::None fields when storing the normalized replay request.
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as typeof input
})

export type ProductInput = z.infer<typeof productInputSchema>
export function materialize(input: ProductInput) {
  return { ...input, categoryId: input.categoryId || null, photoDataUrl: input.photoDataUrl ?? null, structureColors: input.structureColors ?? [], swingArmColors: input.swingArmColors ?? [], finishingPalette: input.finishingPalette ?? "", upholsteryColors: input.upholsteryColors ?? [], plateHolderColors: input.plateHolderColors ?? [], plateHolderTypes: input.plateHolderTypes ?? [] }
}
