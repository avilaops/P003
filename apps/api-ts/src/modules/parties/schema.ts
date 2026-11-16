import { z } from "zod"

const text = (max: number) => z.string().trim().refine(value => value.length > 0 && [...value].length <= max && !/\p{Cc}/u.test(value))
const optionalText = (max: number) => z.string().trim().nullish().transform(value => value || null).refine(value => value === null || [...value].length <= max && !/\p{Cc}/u.test(value))
const asciiEmail = (value: string) => /^[\x00-\x7f]+$/.test(value) && !/\s/u.test(value) && /^[^@]+@[^@]+$/.test(value)
const statePrefixes: Record<string, string> = { RO: "11", AC: "12", AM: "13", RR: "14", PA: "15", AP: "16", TO: "17", MA: "21", PI: "22", CE: "23", RN: "24", PB: "25", PE: "26", AL: "27", SE: "28", BA: "29", MG: "31", ES: "32", RJ: "33", SP: "35", PR: "41", SC: "42", RS: "43", MS: "50", MT: "51", GO: "52", DF: "53" }

export function validDocument(value: string, person: "fisica" | "juridica") {
  if (person === "fisica" ? !/^\d{11}$/.test(value) : !/^[0-9A-Z]{12}\d{2}$/.test(value)) return false
  const digits = [...value].map(character => character.charCodeAt(0) - 48), length = digits.length
  if (digits.every(digit => digit === digits[0])) return false
  for (const end of [length - 2, length - 1]) {
    const sum = digits.slice(0, end).reduce((total, digit, index) => total + digit * (length === 11 ? end + 1 - index : (end - 1 - index) % 8 + 2), 0)
    const remainder = sum % 11
    if (digits[end] !== (remainder < 2 ? 0 : 11 - remainder)) return false
  }
  return true
}

const fiscal = z.strictObject({
  taxpayerIndicator: z.enum(["1", "2", "9"]),
  stateRegistration: optionalText(14).refine(value => value === null || /^\d{2,14}$/.test(value)),
}).refine(value => value.taxpayerIndicator !== "1" || value.stateRegistration !== null).refine(value => value.taxpayerIndicator !== "2" || value.stateRegistration === null)

const address = z.strictObject({
  label: text(80), postalCode: z.string().regex(/^[0-9.\- ]*$/).transform(value => value.replace(/\D/g, "")).pipe(z.string().length(8)),
  state: z.string().trim().toUpperCase().refine(value => Object.hasOwn(statePrefixes, value)), city: text(200), street: text(200), number: text(40), district: text(200),
  complement: optionalText(200), municipalityCode: optionalText(7).transform(value => value ?? undefined), primary: z.boolean().default(false),
}).refine(value => value.municipalityCode === undefined || /^\d{7}$/.test(value.municipalityCode) && value.municipalityCode.startsWith(statePrefixes[value.state]!))

const contact = z.strictObject({
  name: text(200), role: optionalText(80), email: optionalText(254).refine(value => value === null || asciiEmail(value) && value.split("@")[1]!.includes(".")),
  phone: optionalText(40), primary: z.boolean().default(false),
}).refine(value => value.email !== null || value.phone !== null)

const atMostOnePrimary = (items: readonly { primary: boolean }[]) => items.filter(item => item.primary).length <= 1
export const partyInputSchema = z.strictObject({
  personType: z.enum(["fisica", "juridica"]), legalName: text(200), tradeName: optionalText(200),
  taxId: z.string().regex(/^[A-Za-z0-9./\- ]*$/).transform(value => value.replace(/[^0-9A-Za-z]/g, "").toUpperCase()),
  email: optionalText(254).refine(value => value === null || asciiEmail(value)), phone: optionalText(40),
  isCustomer: z.boolean(), isSupplier: z.boolean(), status: z.enum(["active", "archived"]),
  fiscal: fiscal.nullable().optional(), addresses: z.array(address).max(10).refine(atMostOnePrimary).optional(), contacts: z.array(contact).max(10).refine(atMostOnePrimary).optional(),
}).refine(value => value.isCustomer || value.isSupplier).refine(value => validDocument(value.taxId, value.personType))

export type PartyInput = z.infer<typeof partyInputSchema>
