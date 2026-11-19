import { z } from "zod"

import { Problem } from "../../platform/problem.js"

const nullableText = z.string().nullish().transform(value => value ?? null)
const profileSchema = z.strictObject({
  cpf: nullableText, rg: nullableText, birthDate: nullableText, admissionDate: nullableText, documentIssuedOn: nullableText,
  pis: nullableText, ctps: nullableText, address: nullableText, emergencyPhone: nullableText, photo: nullableText,
})
export const staffInputSchema = z.strictObject({
  name: z.string(), jobTitle: nullableText, code: z.string(), email: nullableText, phone: nullableText,
  isEmployee: z.boolean(), isSeller: z.boolean(), status: z.string(), profile: profileSchema.nullish().transform(value => value ?? undefined),
})
export type StaffInput = Omit<z.infer<typeof staffInputSchema>, "profile"> & { profile?: z.infer<typeof profileSchema> | undefined }

function invalid(title: string): never { throw new Problem(422, "invalid_input", title) }
function optional(value: string | null, maximum: number) {
  const text = value?.trim() || null
  if (text !== null && ([...text].length > maximum || /\p{Cc}/u.test(text))) invalid("Contato ou cargo fora do limite permitido")
  return text
}
function validCpf(cpf: string) {
  const digits = [...cpf].filter(character => /[0-9]/.test(character)).map(Number)
  if (digits.length !== 11 || digits.every(digit => digit === digits[0])) return false
  return [9, 10].every(position => {
    const sum = digits.slice(0, position).reduce((total, digit, index) => total + digit * (position + 1 - index), 0)
    const remainder = sum * 10 % 11
    return digits[position] === (remainder === 10 ? 0 : remainder)
  })
}

// Same normalisation and messages as the Rust handler; dates are checked by the route.
export function validateStaff(input: z.infer<typeof staffInputSchema>): StaffInput {
  let profile = input.profile
  if (profile) {
    profile = { ...profile }
    for (const key of ["cpf", "rg", "pis", "ctps", "emergencyPhone"] as const) profile[key] = optional(profile[key], 40)
    profile.address = optional(profile.address, 500)
    if (profile.cpf && !validCpf(profile.cpf)) invalid("CPF inválido")
    if (profile.photo !== null) {
      const [prefix, data] = [profile.photo.slice(0, Math.max(profile.photo.indexOf(","), 0)), profile.photo.slice(profile.photo.indexOf(",") + 1)]
      if (!profile.photo.includes(",")) invalid("Foto inválida")
      if (!["data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"].includes(prefix) || Buffer.byteLength(profile.photo) > 280_000 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) invalid("Use foto PNG, JPEG ou WebP de até 200 KB")
    }
  }
  const name = input.name.trim()
  if (!name || [...name].length > 200 || /\p{Cc}/u.test(name)) invalid("Nome deve conter de 1 a 200 caracteres, sem caracteres de controle")
  const code = input.code.trim().toUpperCase()
  if (!/^[A-Z0-9._-]{1,40}$/.test(code)) invalid("Código deve ter de 1 a 40 caracteres A-Z, 0-9, ponto, hífen ou underscore")
  const jobTitle = optional(input.jobTitle, 120), email = optional(input.email, 254), phone = optional(input.phone, 40)
  if (email !== null) {
    const parts = email.split("@")
    if (parts.length !== 2 || !parts[0] || !parts[1] || !/^[\x00-\x7f]*$/.test(email) || /\s/u.test(email)) invalid("Informe um endereço de e-mail válido ou deixe em branco")
  }
  if (!input.isEmployee && !input.isSeller) invalid("Selecione funcionário, vendedor ou ambos")
  if (!["active", "archived"].includes(input.status)) invalid("Situação inválida")
  return { name, jobTitle, code, email, phone, isEmployee: input.isEmployee, isSeller: input.isSeller, status: input.status, profile }
}
