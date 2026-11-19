import { Problem } from "../../platform/problem.js"
import { validDocument } from "../parties/schema.js"

export const STATES = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"]
export const IE_STATES = ["BA", "GO", "MG", "PB", "PR", "PE", "RS", "SC", "SP", "SE"]
// IBGE prefix of each state, used to accept only municipality codes of the selected state.
export const STATE_CODES: Record<string, string> = { RO: "11", AC: "12", AM: "13", RR: "14", PA: "15", AP: "16", TO: "17", MA: "21", PI: "22", CE: "23", RN: "24", PB: "25", PE: "26", AL: "27", SE: "28", BA: "29", MG: "31", ES: "32", RJ: "33", SP: "35", PR: "41", SC: "42", RS: "43", MS: "50", MT: "51", GO: "52", DF: "53" }

export type LookupKind = "cep" | "cnpj" | "ie"
export type LookupContext = "company" | "party"
export type LookupInput = { kind: LookupKind; context: LookupContext; value: string; state: string | null }
export type LookupStatus = "found" | "not_found" | "unavailable" | "unsupported"
export type StateRegistration = { state: string; number: string; active: boolean | null; sourceUpdatedAt: string | null }
export type RegistryData = { fields: Record<string, string>; stateRegistrations: StateRegistration[]; genericPostalCode: boolean; taxpayerStatus: string }
export type LookupAttempt = { source: string; outcome: string }
export type LookupReply = {
  tenantId: string; kind: LookupKind; value: string; status: LookupStatus; data: RegistryData | null; source: string | null
  sourceUpdatedAt: string | null; fetchedAt: string; expiresAt: string | null; cached: boolean; attempts: LookupAttempt[]; warnings: string[]
}

// What the routes need from the provider layer; tests replace it with a stub.
export interface RegistryProvider {
  lookup(tenant: string, input: LookupInput): Promise<LookupReply>
  lookupRegistration(subject: string, input: LookupInput): Promise<LookupReply>
}

const invalid = (title: string) => new Problem(422, "invalid_input", title)

export function normalizeLookup(input: LookupInput): LookupInput {
  const raw = input.value.trim()
  if (Buffer.byteLength(raw) > 32 || raw === "") throw invalid("Informe o documento ou CEP")
  let value: string
  if (input.kind === "cep") {
    const plain = raw.replaceAll("-", "")
    if (!/^[0-9]+$/.test(plain) || plain.length !== 8 || !(raw.length === 8 || raw.length === 9 && raw[5] === "-")) throw invalid("Informe um CEP com oito dígitos")
    value = plain
  } else {
    if (!/^[A-Za-z0-9./\- ]+$/.test(raw)) throw invalid("CNPJ contém caracteres inválidos")
    value = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase()
    if (!validDocument(value, "juridica")) throw invalid("Informe CNPJ com dígitos verificadores válidos. CPF não possui consulta neste serviço")
  }
  const state = input.state === null ? null : input.state.trim().toUpperCase()
  if (state !== null && !STATES.includes(state) || input.kind === "ie" && state === null) throw invalid("Selecione a UF para consultar a inscrição estadual")
  return { ...input, value, state }
}
