import { z } from "zod"

const text = (max: number) => z.string().trim().refine(value => [...value].length > 0 && [...value].length <= max && !/[\p{Cc}]/u.test(value))
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(value => value === null ? undefined : value, schema.optional())
const profileRate = z.string().regex(/^(0|[1-9]\d?)(?:\.\d{1,4})?$/).transform(value => { const [whole, fraction = ""] = value.split("."); return `${whole}.${fraction.padEnd(4, "0")}` })
const exactRate = z.string().regex(/^(0|[1-9]\d?)\.\d{4}$/)
const twoDigits = z.string().regex(/^\d{2}$/)
const frame = z.string().regex(/^\d{3}$/)

const lineRules = z.strictObject({
  icmsRate: exactRate, ipiRate: exactRate,
  cfopSameState: z.string().regex(/^5\d{3}$/), cfopInterstateTaxpayer: z.string().regex(/^6\d{3}$/), cfopInterstateNonTaxpayer: z.string().regex(/^6\d{3}$/),
  icmsCst: twoDigits, ipiCst: twoDigits, ipiFrameCode: frame, pisCst: twoDigits, cofinsCst: twoDigits,
  ibsStateRate: exactRate, ibsCityRate: exactRate, cbsRate: exactRate,
  finalConsumer: z.boolean(), ipiInIcmsBase: z.boolean(), icmsOutOfContributions: z.boolean(),
  additionalInformation: z.string().refine(value => [...value].length <= 5000 && !/[\p{Cc}]/u.test(value.replaceAll("\n", ""))),
})
// Mirror the Rust contract: defaults' CST values are optional strings; only the
// complete lineRules require two-digit CST. Preserve that distinction.
const defaults = z.strictObject({
  icmsCst: optional(z.string()), pisCst: optional(z.string()), cofinsCst: optional(z.string()), ipiCst: optional(z.string()), ipiFrameCode: optional(frame),
  ibsStateRate: optional(profileRate), ibsCityRate: optional(profileRate), cbsRate: optional(profileRate),
  finalConsumer: optional(z.boolean()), ipiInIcmsBase: optional(z.boolean()), icmsOutOfContributions: optional(z.boolean()),
})
const taxProfile = z.strictObject({
  name: text(80), operationNature: text(60), pisRate: profileRate, cofinsRate: profileRate,
  ibsCbsCst: frame, classCode: z.string().regex(/^\d{6}$/), active: z.boolean(),
  productLine: optional(z.enum(["imported", "national"])), lineRules: optional(lineRules), defaults: optional(defaults),
}).refine(value => value.classCode.startsWith(value.ibsCbsCst)).refine(value => !value.lineRules || value.productLine !== undefined)
const uniqueNames = (values: readonly string[]) => new Set(values.map(value => value.toLowerCase())).size === values.length

export const schemas = {
  products: z.strictObject({ requireNcm: z.boolean(), requireCest: z.boolean(), upholsteryConfigurable: optional(z.boolean()) }),
  parties: z.strictObject({ requireEmail: z.boolean(), requirePhone: z.boolean() }),
  "contact-types": z.strictObject({ labels: z.array(text(80)).max(30).refine(uniqueNames) }),
  "tax-profiles": z.strictObject({ profiles: z.array(taxProfile).max(30).refine(values => uniqueNames(values.map(value => value.name))) }),
}

export const defaultsBySection = {
  products: { requireNcm: false, requireCest: false }, parties: { requireEmail: false, requirePhone: false },
  "contact-types": { labels: [] }, "tax-profiles": { profiles: [] },
}
export type Section = keyof typeof schemas
