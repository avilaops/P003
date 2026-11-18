import { validDocument } from "../parties/schema.js"
import { validateDate } from "../sales/fixed.js"
import { invalid } from "./ledger.js"

// Santander H7815 v8.5 • Cobrança simples eletrônica com registro em reais.
// Posições do manual são inclusivas e começam em 1.
export interface SantanderProfile {
  taxId: string
  name: string
  transmissionCode: string
  beneficiaryCode: string
  agency: string
  agencyDigit: string
  account: string
  accountDigit: string
  interestMonthlyBps?: number
  fineBps?: number
}

export interface SantanderTitle {
  ourNumber: string
  documentNumber: string
  controlNumber: string
  issuedOn: string
  dueOn: string
  cents: string
  payer: {
    taxId: string
    name: string
    address: string
    district: string
    postalCode: string
    city: string
    state: string
  }
}

export interface SantanderReturnEvent {
  ourNumber: string
  documentNumber: string
  controlNumber: string
  occurrence: string
  kind: "registered" | "rejected" | "settled" | "other"
  dueOn: string
  occurredOn: string
  creditOn: string | null
  payerTaxId: string
  nominalCents: string
  paidCents: string
  netCents: string
  feeCents: string
  interestCents: string
  discountCents: string
  abatementCents: string
  iofCents: string
  expenseCents: string
  otherCreditCents: string
  payerOccurrenceCents: string
  reasons: string[]
}

const states = new Set("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "))
const zeros = (length: number) => "0".repeat(length)
const field = (line: string, from: number, to = from) => line.slice(from - 1, to)

function fail(message: string): never {
  throw invalid("CNAB Santander • " + message)
}

function digits(value: string, width: number, label: string) {
  if (typeof value !== "string" || value.length !== width || !/^\d+$/.test(value)) fail(label + " inválido")
  return value
}

function sequenceField(value: number, width: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 10 ** width) fail("Sequencial fora do intervalo")
  return String(value).padStart(width, "0")
}

function alpha(value: string, width: number, label: string) {
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) fail(label + " inválido")
  const normalized = value.normalize("NFD").replace(/\p{M}/gu, "").trim().toUpperCase()
  if (!/^[\x20-\x7e]+$/.test(normalized) || normalized.length > width) fail(label + " fora das posições disponíveis")
  return normalized.padEnd(width)
}

function documentField(taxId: string) {
  const cpf = taxId?.length === 11
  if (!validDocument(taxId, cpf ? "fisica" : "juridica")) fail("CPF ou CNPJ inválido")
  return (cpf ? "1" : "2") + taxId.padStart(15, "0")
}

function bankDate(iso: string) {
  validateDate(iso)
  return iso.slice(8) + iso.slice(5, 7) + iso.slice(0, 4)
}

function isoDate(value: string) {
  digits(value, 8, "Data")
  return validateDate(value.slice(4) + "-" + value.slice(2, 4) + "-" + value.slice(0, 2))
}

function accountField(profile: SantanderProfile) {
  return digits(profile.agency, 4, "Agência") + digits(profile.agencyDigit, 1, "Dígito da agência") +
    digits(profile.account, 9, "Conta") + digits(profile.accountDigit, 1, "Dígito da conta")
}

export function validateSantanderProfile(profile: SantanderProfile): void {
  documentField(profile.taxId)
  alpha(profile.name, 30, "Nome do beneficiário")
  accountField(profile)
  digits(profile.transmissionCode, 15, "Código de transmissão")
  digits(profile.beneficiaryCode, 9, "Código do beneficiário")
  for (const rate of [profile.interestMonthlyBps ?? 0, profile.fineBps ?? 0]) {
    if (!Number.isInteger(rate) || rate < 0 || rate > 10000) fail("Juros ou multa fora do intervalo de 0% a 100%")
  }
}

export function santanderOurNumber(base: string) {
  if (typeof base !== "string" || !/^\d{1,12}$/.test(base) || /^0+$/.test(base)) fail("Base do nosso número inválida")
  let total = 0
  for (let index = 0; index < base.length; index++) {
    total += Number(base[base.length - 1 - index]) * (2 + index % 8)
  }
  const remainder = total % 11
  return base.padStart(12, "0") + (remainder <= 1 ? 0 : 11 - remainder)
}

function checkOurNumber(value: string) {
  if (!/^\d{13}$/.test(value) || value !== santanderOurNumber(value.slice(0, 12))) fail("Nosso número ou dígito inválido")
  return value
}

// Completa com os brancos reservados ao final de cada tipo de registro.
function row(content: string) {
  if (content.length > 240) fail("Registro excede 240 posições")
  return content.padEnd(240)
}

function prefix(sequence: number, segment: string) {
  return "03300013" + sequenceField(sequence, 5) + segment + " 01"
}

export function serializeSantander240(profile: SantanderProfile, sequence: number, generatedOn: string, titles: readonly SantanderTitle[]): string {
  validateSantanderProfile(profile)
  const tax = documentField(profile.taxId)
  const name = alpha(profile.name, 30, "Nome do beneficiário")
  const date = bankDate(generatedOn)
  const sequence6 = sequenceField(sequence, 6)
  const fine = profile.fineBps ?? 0
  const interest = profile.interestMonthlyBps ?? 0
  if (!titles.length || titles.length * (fine ? 3 : 2) > 99999) fail("Quantidade de boletos inválida para o lote")
  const lines = [
    row("03300000" + " ".repeat(8) + tax + profile.transmissionCode + " ".repeat(25) + name +
      "BANCO SANTANDER".padEnd(30) + " ".repeat(10) + "1" + date + " ".repeat(6) + sequence6 + "040"),
    row("03300011R01  030 " + tax + " ".repeat(20) + profile.transmissionCode + " ".repeat(5) +
      name + " ".repeat(80) + sequenceField(sequence, 8) + date),
  ]
  const seen = new Set<string>()
  const account = accountField(profile)
  const maxDue = String(Number(generatedOn.slice(0, 4)) + 10) + generatedOn.slice(4)
  for (const title of titles) {
    const ourNumber = checkOurNumber(title.ourNumber)
    if (seen.has(ourNumber)) fail("Nosso número repetido no mesmo arquivo")
    seen.add(ourNumber)
    const document = alpha(title.documentNumber, 15, "Seu número")
    const control = alpha(title.controlNumber, 25, "Controle do beneficiário")
    const issued = bankDate(title.issuedOn)
    const due = bankDate(title.dueOn)
    if (title.issuedOn > generatedOn || title.dueOn <= generatedOn || title.dueOn > maxDue)
      fail("Confira a emissão e o vencimento em relação à entrada da remessa")
    if (!/^[1-9]\d{0,14}$/.test(title.cents)) fail("Valor nominal inválido")
    const payer = title.payer
    const payerTax = documentField(payer.taxId)
    if (payer.taxId === profile.taxId ||
      (payerTax[0] === "2" && tax[0] === "2" && payer.taxId.slice(0, 8) === profile.taxId.slice(0, 8)))
      fail("O pagador e o beneficiário devem ter inscrições distintas")
    if (!states.has(payer.state)) fail("UF do pagador inválida")
    // Nota 18 especifica cinco casas para taxa de juros. Notas 22 e 32 contam o atraso após o vencimento.
    const mora = interest ? "2" + due + String(interest * 1000).padStart(15, "0") : "3" + zeros(23)
    lines.push(row(prefix(lines.length - 1, "P") + account + zeros(10) + "  " + ourNumber +
      "111  " + document + due + title.cents.padStart(15, "0") + "00000 02N" + issued +
      mora + zeros(54) + control + "000200000"))
    lines.push(row(prefix(lines.length - 1, "Q") + payerTax + alpha(payer.name, 40, "Nome do pagador") +
      alpha(payer.address, 40, "Endereço") + alpha(payer.district, 15, "Bairro") +
      digits(payer.postalCode, 8, "CEP") + alpha(payer.city, 15, "Cidade") + payer.state +
      "0" + " ".repeat(55) + zeros(12)))
    if (fine) {
      lines.push(row(prefix(lines.length - 1, "R") + zeros(48) + "2" + due + String(fine).padStart(15, "0")))
    }
  }
  lines.push(row("03300015" + " ".repeat(9) + sequenceField(lines.length, 6)))
  lines.push(row("03399999" + " ".repeat(9) + "000001" + sequenceField(lines.length + 1, 6)))
  return lines.join("\r\n") + "\r\n"
}

function readDocument(line: string, typeAt: number) {
  const type = field(line, typeAt)
  const padded = field(line, typeAt + 1, typeAt + 15)
  const value = type === "1" ? padded.slice(4) : padded.slice(1)
  if (documentField(value) !== type + padded) fail("Inscrição ou alinhamento inválido no retorno")
  return value
}

function headerSource(header: string) {
  if (header.length !== 240 || !header.startsWith("03300000") || field(header, 143) !== "2" ||
    field(header, 164, 166) !== "040") fail("Cabeçalho de retorno Santander 240 versão 040 inválido")
  return {
    taxId: readDocument(header, 17),
    agency: digits(field(header, 33, 36), 4, "Agência"),
    agencyDigit: digits(field(header, 37), 1, "Dígito da agência"),
    account: digits(field(header, 38, 46), 9, "Conta"),
    accountDigit: digits(field(header, 47), 1, "Dígito da conta"),
    beneficiaryCode: digits(field(header, 53, 61), 9, "Código do beneficiário"),
  }
}

export function readSantanderReturnSource(content: string) {
  return headerSource(content.split(/\r?\n/, 1)[0]!)
}

function readAmount(line: string, from: number, width = 15) {
  return BigInt(digits(field(line, from, from + width - 1), width, "Valor em centavos")).toString()
}

function readCount(line: string, from: number, width: number) {
  return Number(digits(field(line, from, from + width - 1), width, "Contador"))
}

function readEvent(t: string, u: string, account: string): SantanderReturnEvent {
  const occurrence = field(t, 16, 17)
  if (!/^[A-Z0-9]{2}$/.test(occurrence) || field(u, 16, 17) !== occurrence) fail("Ocorrências T e U incompatíveis")
  if (field(t, 18, 32) !== account || field(t, 54) !== "2" || field(t, 126, 127) !== "00")
    fail("Conta, carteira ou moeda incompatível no segmento T")
  const reasons = field(t, 209, 218).match(/../g)!.filter((v) => v !== "  " && v !== "00")
  if (reasons.some(v => !/^[0-9A-Z]{2}$/.test(v))) fail("Motivo de ocorrência inválido")
  const credit = field(u, 146, 153)
  const documentNumber = field(t, 55, 69).trimEnd()
  if (!documentNumber) fail("Seu número ausente no retorno")
  return {
    ourNumber: checkOurNumber(field(t, 41, 53)),
    documentNumber,
    controlNumber: field(t, 101, 125).trimEnd(),
    occurrence,
    kind: occurrence === "02" ? "registered" : occurrence === "03" ? "rejected" : occurrence === "06" ? "settled" : "other",
    dueOn: isoDate(field(t, 70, 77)),
    occurredOn: isoDate(field(u, 138, 145)),
    creditOn: credit === "00000000" ? null : isoDate(credit),
    payerTaxId: readDocument(t, 128),
    nominalCents: readAmount(t, 78),
    feeCents: readAmount(t, 194),
    interestCents: readAmount(u, 18),
    discountCents: readAmount(u, 33),
    abatementCents: readAmount(u, 48),
    iofCents: readAmount(u, 63),
    paidCents: readAmount(u, 78),
    netCents: readAmount(u, 93),
    expenseCents: readAmount(u, 108),
    otherCreditCents: readAmount(u, 123),
    payerOccurrenceCents: readAmount(u, 166),
    reasons,
  }
}

// Nota 38: os quatro saldos são a posição da carteira. Não são a soma das ocorrências T/U.
function portfolioPosition(line: string, start: number) {
  return { count: readCount(line, start, 6), cents: readAmount(line, start + 6, 17) }
}

export function parseSantander240(content: string, profile: SantanderProfile) {
  validateSantanderProfile(profile)
  const rows = content.replace(/\r?\n$/, "").split(/\r?\n/)
  if (rows.length < 6 || rows.some(r => r.length !== 240 || !r.startsWith("033") || /[^\x20-\x7e]/.test(r)))
    fail("Cada registro deve conter 240 caracteres ASCII e banco 033")
  const header = rows[0]!
  const source = headerSource(header)
  const account = accountField(profile)
  const tax = documentField(profile.taxId)
  if (source.taxId !== profile.taxId || source.beneficiaryCode !== profile.beneficiaryCode || field(header, 33, 47) !== account)
    fail("O retorno pertence a outro beneficiário, convênio ou conta")
  const sequence = readCount(header, 158, 6)
  const generatedOn = isoDate(field(header, 144, 151))
  const trailer = rows.at(-1)!
  if (!sequence || !trailer.startsWith("03399999") || readCount(trailer, 24, 6) !== rows.length)
    fail("Sequencial ou total de registros do arquivo inválido")
  const events: SantanderReturnEvent[] = []
  const lots = []
  let next = 1
  let previousLot = 0
  while (next < rows.length - 1) {
    const start = next
    const lotHeader = rows[next++]!
    const lot = field(lotHeader, 4, 7)
    const lotNumber = readCount(lotHeader, 4, 4)
    if (lotNumber <= previousLot || lotNumber === 9999 || field(lotHeader, 8, 17) !== "1T01  040 " ||
      field(lotHeader, 18, 33) !== tax || field(lotHeader, 34, 42) !== profile.beneficiaryCode ||
      field(lotHeader, 54, 68) !== account) fail("Identificação, serviço ou versão do lote de retorno inválido")
    previousLot = lotNumber
    const returnNumber = readCount(lotHeader, 184, 8)
    const recordedOn = isoDate(field(lotHeader, 192, 199))
    if (!returnNumber) fail("Número de retorno do lote inválido")
    while (next < rows.length - 1 && field(rows[next]!, 8) === "3") {
      const t = rows[next++]!
      const u = rows[next++]
      const detail = lot + "3"
      if (!u || field(t, 4, 8) !== detail || field(u, 4, 8) !== detail || field(t, 14, 15) !== "T " ||
        field(u, 14, 15) !== "U " || readCount(t, 9, 5) !== next - start - 2 ||
        readCount(u, 9, 5) !== next - start - 1) fail("Par T/U ou sequência de detalhes inválida")
      events.push(readEvent(t, u, account))
    }
    const end = rows[next++]
    if (!end || field(end, 4, 8) !== lot + "5" || readCount(end, 18, 6) !== next - start || next - start < 4)
      fail("Trailer ou quantidade de registros do lote inválido")
    lots.push({ lot, returnNumber, recordedOn, simple: portfolioPosition(end, 24), linked: portfolioPosition(end, 47),
      secured: portfolioPosition(end, 70), discounted: portfolioPosition(end, 93) })
  }
  if (readCount(trailer, 18, 6) !== lots.length) fail("Quantidade de lotes divergente")
  return { source, sequence, generatedOn, events, lots }
}
