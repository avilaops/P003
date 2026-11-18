import assert from "node:assert/strict"
import test from "node:test"
import {
  parseSantander240, readSantanderReturnSource, santanderOurNumber, serializeSantander240,
  type SantanderProfile, type SantanderTitle,
} from "../src/modules/finance-treasury/santander-240.js"

const profile: SantanderProfile = {
  taxId: "12ABC34501DE35", name: "Fábrica Exemplo", transmissionCode: "987654321012345",
  beneficiaryCode: "001234567", agency: "1234", agencyDigit: "5", account: "000123456", accountDigit: "7",
}
const title: SantanderTitle = {
  ourNumber: "0000031475787", documentNumber: "DOC0007", controlNumber: "CONTROLE0007",
  issuedOn: "2026-11-12", dueOn: "2026-12-05", cents: "12345",
  payer: { taxId: "52998224725", name: "José Exemplo", address: "Rua do Pátio, 10",
    district: "São João", postalCode: "01310100", city: "São Paulo", state: "SP" },
}

// Gabaritos posicionais independentes do serializador. Campos sem valor permanecem em branco.
function record(fields: Record<number, string>) {
  const line = Array<string>(240).fill(" ")
  for (const [start, value] of Object.entries(fields)) {
    const offset = Number(start) - 1
    assert.ok(offset + value.length <= 240)
    for (let i = 0; i < value.length; i++) line[offset + i] = value[i]!
  }
  return line.join("")
}

const zero = (n: number) => "0".repeat(n)
const inboundHeader = record({
  1: "03300000", 17: "2012ABC34501DE35", 33: "123450001234567", 53: "001234567",
  73: "FABRICA EXEMPLO", 103: "BANCO SANTANDER", 143: "217112026", 158: "000087040",
})

// O Santander pode devolver lote diferente de 0001, conforme nota 11.
function inboundLot(lot: string, movement: string, reason: string) {
  return [
    record({ 1: "033" + lot + "1T01  040", 18: "2012ABC34501DE35", 34: "001234567",
      54: "123450001234567", 74: "FABRICA EXEMPLO", 184: "00000999", 192: "17112026" }),
    record({ 1: "033" + lot + "300001T " + movement, 18: "123450001234567", 41: "0000031475787",
      54: "2DOC0007", 70: "05122026", 78: "000000000012345", 93: "03398765", 101: "CONTROLE0007",
      126: "001000052998224725", 144: "JOSE EXEMPLO", 194: "000000000000125", 209: reason.padEnd(10, "0") }),
    record({ 1: "033" + lot + "300002U " + movement, 18: "000000000000040", 33: "000000000000015",
      48: "000000000000020", 63: "000000000000005", 78: "000000000012350", 93: "000000000012224",
      108: "000000000000006", 123: "000000000000010", 138: "16112026", 146: movement === "06" ? "17112026" : "00000000",
      154: zero(27), 211: "000" }),
    record({ 1: "033" + lot + "5", 18: "000004", 24: "000210", 30: "01234567890123456",
      47: "000002", 53: "00000000000000078", 70: zero(46) }),
  ]
}

function inbound(movement = "06", reasons = "04") {
  return [inboundHeader, ...inboundLot("5207", movement, reasons), record({ 1: "03399999", 18: "000001000006" })]
}

test("Nosso número • módulo 11 e preenchimento dos exemplos da nota 15", () => {
  assert.equal(santanderOurNumber("3147578"), "0000031475787")
  assert.equal(santanderOurNumber("4870184"), "0000048701840")
  assert.equal(santanderOurNumber("14"), "0000000000140")
  assert.equal(santanderOurNumber("5"), "0000000000051")
  for (const value of ["0", "000000000000", "", "1234567890123", "P003"]) assert.throws(() => santanderOurNumber(value))
})

test("Remessa • gabarito integral de 240 posições para cada um dos seis registros", () => {
  const expected = [
    record({ 1: "03300000", 17: "2012ABC34501DE35", 33: "987654321012345", 73: "FABRICA EXEMPLO",
      103: "BANCO SANTANDER", 143: "115112026", 158: "000042040" }),
    record({ 1: "03300011R01  030", 18: "2012ABC34501DE35", 54: "987654321012345", 74: "FABRICA EXEMPLO",
      184: "00000042", 192: "15112026" }),
    record({ 1: "0330001300001P 01", 18: "123450001234567", 33: zero(10), 45: "0000031475787",
      58: "111", 63: "DOC0007", 78: "05122026", 86: "000000000012345", 101: "00000",
      107: "02N", 110: "12112026", 118: "3", 119: zero(77), 196: "CONTROLE0007",
      221: "000", 224: "2000", 228: "00" }),
    record({ 1: "0330001300002Q 01", 18: "1000052998224725", 34: "JOSE EXEMPLO", 74: "RUA DO PATIO, 10",
      114: "SAO JOAO", 129: "01310100", 137: "SAO PAULO", 152: "SP0", 210: zero(12) }),
    record({ 1: "03300015", 18: "000004" }),
    record({ 1: "03399999", 18: "000001000006" }),
  ]
  const result = serializeSantander240(profile, 42, "2026-11-15", [title])
  assert.equal(result, expected.join("\r\n") + "\r\n")
  assert.equal(Buffer.byteLength(result), 6 * 242)
})

test("Remessa • juros mensais e multa moratória por título, com contadores do segmento R", () => {
  const second = { ...title, ourNumber: "0000048701840", dueOn: "2027-02-01" }
  const rows = serializeSantander240({ ...profile, interestMonthlyBps: 125, fineBps: 215 }, 7, "2026-11-15", [title, second]).trimEnd().split("\r\n")
  assert.equal(rows.length, 10)
  assert.equal(rows[2]!.slice(117, 141), "205122026000000000125000")
  assert.equal(rows[4], record({ 1: "0330001300003R 01", 18: zero(48), 66: "2", 67: "05122026", 75: "000000000000215" }))
  assert.equal(rows[5]!.slice(8, 17), "00004P 01")
  assert.equal(rows[7]!.slice(65, 89), "201022027000000000000215")
  assert.equal(rows[8]!.slice(17, 23), "000008")
  assert.equal(rows[9]!.slice(17, 29), "000001000010")
})

test("Remessa • valores, inscrições, datas e identificadores fora do padrão são rejeitados", () => {
  for (const change of [{ cents: "0" }, { cents: "123.45" }, { cents: "1".repeat(16) }, { ourNumber: "0000031475780" },
    { issuedOn: "2026-11-16" }, { dueOn: "2026-11-15" }, { dueOn: "2036-11-16" }, { dueOn: "2027-02-29" },
    { documentNumber: "A".repeat(16) }, { controlNumber: "A".repeat(26) }]) {
    assert.throws(() => serializeSantander240(profile, 1, "2026-11-15", [{ ...title, ...change }]))
  }
  for (const change of [{ state: "ZZ" }, { postalCode: "ABC00001" }, { taxId: "52998224726" },
    { taxId: profile.taxId }, { name: "Nome\r\n" }, { district: " " }]) {
    assert.throws(() => serializeSantander240(profile, 1, "2026-11-15", [{ ...title, payer: { ...title.payer, ...change } }]))
  }
  for (const change of [{ interestMonthlyBps: 1.5 }, { fineBps: -1 }, { accountDigit: "X" }, { transmissionCode: "1" }]) {
    assert.throws(() => serializeSantander240({ ...profile, ...change }, 1, "2026-11-15", [title]))
  }
  assert.throws(() => serializeSantander240(profile, 1000000, "2026-11-15", [title]))
  assert.throws(() => serializeSantander240(profile, 1, "2026-11-15", []))
  assert.throws(() => serializeSantander240(profile, 1, "2026-11-15", [title, title]))
})

test("Retorno • conta, códigos, datas, centavos e posição da carteira têm campos independentes", () => {
  const content = inbound().join("\r\n") + "\r\n"
  const result = parseSantander240(content, profile)
  assert.deepEqual(result.source, {
    taxId: profile.taxId, agency: "1234", agencyDigit: "5", account: "000123456", accountDigit: "7", beneficiaryCode: "001234567",
  })
  assert.deepEqual(readSantanderReturnSource(content), result.source)
  assert.equal(result.sequence, 87)
  assert.equal(result.generatedOn, "2026-11-17")
  assert.deepEqual(result.events, [{
    ourNumber: "0000031475787", documentNumber: "DOC0007", controlNumber: "CONTROLE0007",
    occurrence: "06", kind: "settled", dueOn: "2026-12-05", occurredOn: "2026-11-16", creditOn: "2026-11-17",
    payerTaxId: "52998224725", nominalCents: "12345", paidCents: "12350", netCents: "12224", feeCents: "125",
    interestCents: "40", discountCents: "15", abatementCents: "20", iofCents: "5", expenseCents: "6", otherCreditCents: "10",
    payerOccurrenceCents: "0", reasons: ["04"],
  }])
  assert.deepEqual(result.lots[0], { lot: "5207", returnNumber: 999, recordedOn: "2026-11-17",
    simple: { count: 210, cents: "1234567890123456" }, linked: { count: 2, cents: "78" },
    secured: { count: 0, cents: "0" }, discounted: { count: 0, cents: "0" } })
})

test("Retorno • apenas movimento 06 representa liquidação, mesmo quando U informa pagamento", () => {
  const cases = [["02", "registered"], ["03", "rejected"], ["09", "other"], ["17", "other"],
    ["93", "other"], ["94", "other"], ["A4", "other"], ["99", "other"]]
  for (const [movement, expected] of cases) {
    const rows = inbound(movement, "Z8B6")
    const [event] = parseSantander240(rows.join("\n"), profile).events
    assert.equal(event!.kind, expected)
    assert.equal(event!.paidCents, "12350")
    assert.equal(event!.creditOn, null)
    assert.deepEqual(event!.reasons, ["Z8", "B6"])
  }
  const rows = [inboundHeader, ...inboundLot("5207", "02", "00"), ...inboundLot("5208", "06", "04"),
    record({ 1: "03399999", 18: "000002000010" })]
  assert.equal(parseSantander240(rows.join("\n"), profile).events.length, 2)
})

test("Retorno • valida origem, versão, referências, valores, pares T/U e contadores antes de liberar os eventos", () => {
  const changes: [number, number, string][] = [
    [0, 1, "341"], [0, 17, "1"], [0, 33, "9876"], [0, 53, "000000001"], [0, 143, "1"],
    [0, 144, "31022026"], [0, 158, "000000"], [0, 164, "030"], [1, 8, "1R01"], [1, 14, "030"],
    [1, 34, "000000001"], [1, 68, "0"], [2, 14, "Y"], [2, 18, "9876"], [2, 41, "0000031475780"],
    [2, 54, "1"], [2, 78, "X"], [2, 101, "\u00e1"], [2, 126, "09"], [2, 128, "2"],
    [3, 4, "5208"], [3, 9, "00001"], [3, 14, "T"], [3, 16, "17"], [3, 78, "-"], [3, 146, "31022026"], [3, 166, "X"],
    [4, 18, "000003"], [4, 30, "X"], [5, 18, "000002"], [5, 24, "000005"],
  ]
  for (const [line, start, value] of changes) {
    const rows = inbound()
    rows[line] = rows[line]!.slice(0, start - 1) + value + rows[line]!.slice(start - 1 + value.length)
    assert.throws(() => parseSantander240(rows.join("\n"), profile), "alteração na linha " + line + " posição " + start)
  }
  assert.throws(() => parseSantander240(inbound().join("\n") + "\n\n", profile))
  assert.throws(() => parseSantander240(inbound().slice(0, -1).join("\n"), profile))
  assert.throws(() => parseSantander240(inbound().join("\n"), { ...profile, accountDigit: "0" }))
})
