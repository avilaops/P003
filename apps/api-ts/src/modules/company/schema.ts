import { z } from "zod"

// Porte de platform/company_data.rs: cadastro da empresa e suas regras de validação.
const STATES = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"]
const SEGMENTS = ["Comércio", "E-commerce", "Serviços", "Indústria"]
const text = z.string().default("")

export const companySchema = z.strictObject({
  legalName: text, tradeName: text, personType: text, taxId: text, stateRegistration: text, municipalRegistration: text,
  suframa: text, cnae: text, mainActivity: text, taxRegime: text, companySize: text, activityDescription: text,
  segments: z.array(z.string()).default([]),
  postalCode: text, state: text, city: text, street: text, number: text, district: text, complement: text,
  contactName: text, phone: text, mobile: text, email: text, billingEmail: text, website: text,
  logoDataUrl: z.string().nullish(), partnerName: z.string().nullish(), partnerMobile: z.string().nullish(),
  substituteRegistrations: z.array(z.strictObject({ state: z.string(), value: z.string() })).default([]),
})
export type CompanyData = Omit<z.infer<typeof companySchema>, "logoDataUrl" | "partnerName" | "partnerMobile"> & {
  logoDataUrl?: string; partnerName?: string; partnerMobile?: string
}
export type FieldError = { field: string; message: string }

export function emptyCompany(): CompanyData {
  return companySchema.parse({}) as CompanyData
}

/** Normaliza o corpo (campos opcionais nulos viram ausentes, como `Option::None` no Rust). */
export function toCompanyData(input: z.infer<typeof companySchema>): CompanyData {
  const { logoDataUrl, partnerName, partnerMobile, ...rest } = input
  return { ...rest, ...(logoDataUrl == null ? {} : { logoDataUrl }), ...(partnerName == null ? {} : { partnerName }), ...(partnerMobile == null ? {} : { partnerMobile }) }
}

export function validDocument(value: string, person: string) {
  const length = person === "fisica" ? 11 : 14
  const characters = person === "fisica" ? /^[0-9]{11}$/.test(value) : /^[0-9A-Z]{12}[0-9]{2}$/.test(value)
  if (!characters) return false
  const digits = [...value].map(char => char.charCodeAt(0) - 48)
  if (digits.every(digit => digit === digits[0])) return false
  for (const end of [length - 2, length - 1]) {
    let sum = 0
    for (let index = 0; index < end; index += 1) sum += digits[index]! * (length === 11 ? end + 1 - index : ((end - 1 - index) % 8) + 2)
    const remainder = sum % 11
    if (digits[end] !== (remainder < 2 ? 0 : 11 - remainder)) return false
  }
  return true
}

// Lê só o cabeçalho (formato, dimensões); não decodifica os pixels como o `image` do Rust.
function imageSize(bytes: Buffer, format: string): [number, number] | undefined {
  if (format === "png") {
    if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a || bytes.toString("latin1", 12, 16) !== "IHDR") return undefined
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  }
  if (format === "jpeg") {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return undefined
      const marker = bytes[offset + 1]!
      if (marker === 0xff) { offset += 1; continue }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)]
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue }
      offset += 2 + bytes.readUInt16BE(offset + 2)
    }
    return undefined
  }
  if (bytes.length < 30 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP") return undefined
  const chunk = bytes.toString("latin1", 12, 16)
  if (chunk === "VP8X") return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1]
  if (chunk === "VP8L") return bytes[20] === 0x2f ? [(bytes.readUInt16LE(21) & 0x3fff) + 1, ((bytes.readUInt32LE(21) >> 14) & 0x3fff) + 1] : undefined
  if (chunk === "VP8 ") return bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a ? [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff] : undefined
  return undefined
}

function validLogo(value: string) {
  if (value === "") return true
  const comma = value.indexOf(",")
  if (comma < 0) return false
  const format = ({ "data:image/png;base64": "png", "data:image/jpeg;base64": "jpeg", "data:image/webp;base64": "webp" } as Record<string, string>)[value.slice(0, comma)]
  const encoded = value.slice(comma + 1)
  const max = 256 * 1024
  if (!format || encoded.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return false
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.length > max) return false
  const size = imageSize(bytes, format)
  return size !== undefined && size[0] > 0 && size[1] > 0 && size[0] <= 1024 && size[1] <= 1024
}

/** Valida e normaliza (nome, documento e CEP) in place; devolve os erros por campo. */
export function validateCompany(data: CompanyData): FieldError[] {
  const errors: FieldError[] = []
  const check = (valid: boolean, field: string, message: string) => { if (!valid) errors.push({ field, message }) }
  data.legalName = data.legalName.trim()
  const rawTaxId = data.taxId, rawPostalCode = data.postalCode
  data.taxId = [...data.taxId].filter(char => /^[A-Za-z0-9]$/.test(char)).join("").toUpperCase()
  data.postalCode = [...data.postalCode].filter(char => /^[0-9]$/.test(char)).join("")
  check(data.legalName !== "", "legalName", "Informe o nome empresarial")
  check(["juridica", "fisica"].includes(data.personType), "personType", "Selecione o tipo de pessoa")
  check([...rawTaxId].every(char => /^[A-Za-z0-9]$/.test(char) || "./- ".includes(char)) && validDocument(data.taxId, data.personType), "taxId", "Informe um CPF ou CNPJ válido para o tipo de pessoa")
  check(["simples", "presumido", "real"].includes(data.taxRegime), "taxRegime", "Selecione o regime tributário")
  check(["", "outros", "comercio", "servicos"].includes(data.mainActivity), "mainActivity", "Selecione uma atividade válida")
  check(["", "micro", "pequena", "media", "grande"].includes(data.companySize), "companySize", "Selecione um porte válido")
  check(data.segments.length > 0 && data.segments.length <= 4 && data.segments.every(segment => SEGMENTS.includes(segment)) && new Set(data.segments).size === data.segments.length, "segments", "Selecione segmentos válidos sem repetição")
  check([...rawPostalCode].every(char => /^[0-9]$/.test(char) || ".- ".includes(char)) && data.postalCode.length === 8, "postalCode", "Informe um CEP com oito dígitos")
  check(STATES.includes(data.state), "state", "Selecione uma UF válida")
  for (const field of ["city", "street", "number", "district"] as const) check(data[field].trim() !== "", field, "Campo obrigatório")
  for (const field of ["email", "billingEmail"] as const) {
    const value = data[field], at = value.indexOf("@")
    check(value === "" || (!/\s/.test(value) && at > 0 && value.slice(at + 1).includes(".") && !value.slice(at + 1).includes("@")), field, "Informe um e-mail válido")
  }
  check(data.website === "" || (() => {
    try { const url = new URL(data.website); return ["http:", "https:"].includes(url.protocol) && url.hostname !== "" && url.username === "" && url.password === "" } catch { return false }
  })(), "website", "Informe um endereço HTTP ou HTTPS")
  check(data.logoDataUrl === undefined || validLogo(data.logoDataUrl), "logoDataUrl", "Use uma imagem PNG, JPEG ou WebP de até 256 KB e 1024 pixels por lado")
  check(data.substituteRegistrations.length <= 27, "substituteRegistrations", "Máximo de 27 inscrições")
  const seen = new Set<string>()
  for (const registration of data.substituteRegistrations) {
    check(STATES.includes(registration.state) && registration.value.trim() !== "" && Buffer.byteLength(registration.value) <= 80 && !seen.has(registration.state), "substituteRegistrations", "Informe inscrições válidas sem repetir UF")
    seen.add(registration.state)
  }
  for (const [field, value] of Object.entries(data)) {
    if (typeof value === "string" && field !== "logoDataUrl") check(Buffer.byteLength(value) <= 300, field, "Máximo de 300 bytes por campo")
  }
  return errors
}
