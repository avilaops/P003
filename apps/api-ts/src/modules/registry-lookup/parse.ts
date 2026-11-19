import { STATES, STATE_CODES, type LookupKind, type RegistryData, type StateRegistration } from "./model.js"

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

export function text(value: unknown, key: string): string | null {
  if (!isObject(value)) return null
  const raw = value[key]
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  return trimmed !== "" && [...trimmed].length <= 200 && !/\p{Cc}/u.test(trimmed) ? trimmed : null
}
const normalizeId = (raw: string) => raw.replace(/[./\- ]/g, "").toUpperCase()

function municipalityCode(value: unknown, state: string | undefined) {
  const code = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null
  const prefix = state === undefined ? undefined : STATE_CODES[state]
  return code !== null && prefix !== undefined && /^\d{7}$/.test(code) && code.startsWith(prefix) ? code : null
}

const STATUSES: [number, string][] = [[1, "NULA"], [2, "ATIVA"], [3, "SUSPENSA"], [4, "INAPTA"], [8, "BAIXADA"]]
const byLabel = (label: string | null) => STATUSES.find(([, name]) => name === label)?.[0]
// The source's registration status is independent of the ERP record's status.
function registrationFields(ws: boolean, record: Json, fields: Record<string, string>) {
  const raw = record.situacao_cadastral ?? null
  const key = ws ? "situacao_cadastral" : "descricao_situacao_cadastral"
  const description = text(record, key)?.toUpperCase() ?? null
  const malformed = (record[key] ?? null) !== null && description === null
  let code: number | undefined
  if (malformed) code = undefined
  else if (ws) code = byLabel(description)
  else {
    const numeric = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : typeof raw === "string" && /^\+?\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined
    if (numeric !== undefined) code = STATUSES.find(([known, label]) => known === numeric && (description === null || description === label))?.[0]
    else if (raw === null) code = byLabel(description)
  }
  fields.registrationStatusCode = code === undefined ? "unknown" : String(code)
  fields.registrationStatus = STATUSES.find(([known]) => known === code)?.[1] ?? "Não confirmada"
  const date = text(record, "data_situacao_cadastral")
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date) fields.registrationStatusDate = date
  const reason = ws ? text(record.motivo_situacao_cadastral, "descricao") : text(record, "descricao_motivo_situacao_cadastral")
  if (reason) fields.registrationStatusReason = reason
}

export function statusWarning(fields: Record<string, string>) {
  const code = fields.registrationStatusCode
  if (code === "2") return null
  if (["1", "3", "4", "8"].includes(code ?? "")) return `Situação cadastral do CNPJ: ${fields.registrationStatus ?? "Não confirmada"}. Confira a situação da empresa antes de continuar o cadastro ou a negociação.`
  return "Situação cadastral do CNPJ: não confirmada pela fonte consultada. Confira antes de continuar."
}

// Project only values that have an exact counterpart in company forms.
function companyFields(ws: boolean, value: Json, record: Json, fields: Record<string, string>) {
  const simples = ws
    ? isObject(value.simples) && text(value.simples, "simples")?.toLowerCase() === "sim" && (value.simples.data_exclusao_simples ?? null) === null
    : value.opcao_pelo_simples === true && (value.data_exclusao_do_simples ?? null) === null
  if (simples) fields.taxRegime = "simples"
  if (ws) {
    const description = text(record.atividade_principal, "descricao")
    if (description) fields.activityDescription = description
    const kind = text(record, "tipo_logradouro")
    if (fields.street !== undefined && kind) fields.street = `${kind} ${fields.street}`
  }
  const size = ws ? text(value.porte, "id") : typeof value.codigo_porte === "number" && Number.isInteger(value.codigo_porte) && value.codigo_porte >= 0 ? String(value.codigo_porte).padStart(2, "0") : null
  if (size === "01") fields.companySize = "micro"
  else if (size === "03") fields.companySize = "pequena" // "Demais" does not distinguish medium and large companies.
  const ddd = text(record, "ddd1"), number = text(record, "telefone1")
  const phone = ws ? number !== null && ddd !== null ? `${ddd}${number}` : null : text(record, "ddd_telefone_1")
  if (phone) { const digits = phone.replace(/\D/g, ""); if (digits.length >= 10 && digits.length <= 11) fields.phone = digits }
}

export function parseRegistry(source: string, kind: LookupKind, requested: string, state: string | null, value: unknown): { data: RegistryData; sourceUpdatedAt: string | null } | null {
  if (!isObject(value)) return null
  const via = source === "ViaCEP", ws = source === "CNPJ.ws", cep = kind === "cep"
  const record = ws ? value.estabelecimento : value
  if (!isObject(record)) return null
  const identity = text(record, cep ? "cep" : "cnpj")
  if (identity === null || normalizeId(identity) !== requested) return null
  const fields: Record<string, string> = {}
  const mapping: [string, string][] = cep
    ? via ? [["postalCode", "cep"], ["state", "uf"], ["city", "localidade"], ["street", "logradouro"], ["district", "bairro"]]
      : [["postalCode", "cep"], ["state", "state"], ["city", "city"], ["street", "street"], ["district", "neighborhood"]]
    : ws ? [["postalCode", "cep"], ["street", "logradouro"], ["district", "bairro"], ["number", "numero"], ["complement", "complemento"], ["tradeName", "nome_fantasia"], ["email", "email"]]
      : [["postalCode", "cep"], ["state", "uf"], ["city", "municipio"], ["street", "logradouro"], ["district", "bairro"], ["number", "numero"], ["complement", "complemento"], ["tradeName", "nome_fantasia"], ["activityDescription", "cnae_fiscal_descricao"], ["email", "email"]]
  for (const [target, key] of mapping) {
    const raw = record[key]
    if (raw !== undefined && raw !== null && typeof raw !== "string") return null
    let item = text(record, key)
    if (item !== null) {
      if (target === "postalCode") { item = normalizeId(item); if (!/^\d{8}$/.test(item)) return null }
      fields[target] = item
    }
  }
  if (!cep) {
    const legalName = text(value, "razao_social")
    if (legalName === null) return null
    fields.legalName = legalName
    fields.personType = "juridica"
    companyFields(ws, value, record, fields)
    if (kind === "cnpj") registrationFields(ws, record, fields)
    if (ws) {
      const uf = text(record.estado, "sigla"), city = text(record.cidade, "nome"), cnae = text(record.atividade_principal, "id")
      if (uf) fields.state = uf
      if (city) fields.city = city
      if (cnae) fields.cnae = cnae
    } else if (typeof value.cnae_fiscal === "number" && Number.isInteger(value.cnae_fiscal) && value.cnae_fiscal >= 0 && value.cnae_fiscal <= 9_999_999) fields.cnae = String(value.cnae_fiscal).padStart(7, "0")
  }
  if (fields.state !== undefined && !STATES.includes(fields.state)) return null
  if (cep && (fields.state === undefined || fields.city === undefined)) return null
  // Only documented IBGE identifiers, never provider-local city IDs or a code guessed from a name.
  const rawMunicipality = via && cep ? record.ibge : ws && !cep ? (isObject(record.cidade) ? record.cidade.ibge_id : undefined) : source === "BrasilAPI" && !cep ? record.codigo_municipio_ibge : undefined
  const municipality = municipalityCode(rawMunicipality, fields.state)
  if (municipality !== null) fields.municipalityCode = municipality
  const generic = cep && (fields.street === undefined || fields.district === undefined)
  const registrations: StateRegistration[] = []
  if (ws && Array.isArray(record.inscricoes_estaduais)) {
    // Missing registrations are unknown; never synthesize ISENTO or a taxpayer flag.
    if (record.inscricoes_estaduais.length > 100) return null
    for (const item of record.inscricoes_estaduais) {
      const uf = text(isObject(item) ? item.estado : undefined, "sigla")
      if (uf === null || !STATES.includes(uf)) return null
      if (state !== null && state !== uf) continue
      const number = text(item, "inscricao_estadual")
      if (number === null || number.length > 20 || !/^[A-Za-z0-9./-]+$/.test(number)) return null
      registrations.push({ state: uf, number, active: typeof (item as Json).ativo === "boolean" ? (item as Json).ativo as boolean : null, sourceUpdatedAt: text(item, "atualizado_em") })
    }
  }
  const sorted = Object.fromEntries(Object.entries(kind === "ie" ? {} : fields).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  return { data: { fields: sorted, stateRegistrations: registrations, genericPostalCode: generic, taxpayerStatus: "unknown" }, sourceUpdatedAt: text(value, "atualizado_em") }
}
