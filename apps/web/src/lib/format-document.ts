// Display formatting for Brazilian documents and phone numbers. Values that do
// not have a recognizable shape are returned unchanged, never truncated.

const digits = (value: string) => value.replace(/\D/g, "")

export function formatTaxId(value: string | null | undefined): string {
  if (!value) return ""
  const raw = digits(value)
  if (raw.length === 11) return raw.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4")
  if (raw.length === 14) return raw.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
  return value
}

export function formatPhone(value: string | null | undefined): string {
  if (!value) return ""
  let raw = digits(value)
  if ((raw.length === 12 || raw.length === 13) && raw.startsWith("55")) raw = raw.slice(2)
  if (raw.length === 11) return raw.replace(/^(\d{2})(\d{5})(\d{4})$/, "($1) $2-$3")
  if (raw.length === 10) return raw.replace(/^(\d{2})(\d{4})(\d{4})$/, "($1) $2-$3")
  return value
}

// Search terms that are a CPF/CNPJ typed with punctuation are sent as digits only,
// so formatted and unformatted input finds the same record.
export function normalizeDocumentSearch(value: string): string {
  const trimmed = value.trim()
  return /^[\d.\-/\s]+$/.test(trimmed) && digits(trimmed).length >= 11 ? digits(trimmed) : trimmed
}
