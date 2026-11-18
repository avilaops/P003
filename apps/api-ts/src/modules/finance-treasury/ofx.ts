import { invalid } from "./ledger.js"
import { validateDate } from "../sales/fixed.js"

function field(block: string, tag: string, required = true) {
  const match = new RegExp("<" + tag + "\\s*>\\s*([^<\\r\\n]*)", "i").exec(block)
  const value = (match?.[1] ?? "")
    .trim()
    .replace(
      /&(amp|lt|gt|quot|apos);/g,
      (_, key: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[key]!,
    )
  if (required && !value) throw invalid("Campo OFX ausente • " + tag)
  return value
}
export function bankDate(raw: string) {
  if (!/^\d{8}(?:\d{6}(?:\.\d+)?(?:\[[^\]]+\])?)?$/.test(raw)) throw invalid("Data bancária inválida")
  return validateDate(raw.slice(0, 4) + "-" + raw.slice(4, 6) + "-" + raw.slice(6, 8))
}
function cents(raw: string) {
  const match = /^([+-]?)(\d{1,12})(?:\.(\d{1,2})0*)?$/.exec(raw)
  if (!match) throw invalid("Valor bancário inválido")
  return BigInt((match[1] === "-" ? "-" : "") + match[2] + (match[3] || "").padEnd(2, "0"))
}
export function parseOfx(raw: string) {
  const statements = [...raw.matchAll(/<STMTRS\s*>([\s\S]*?)<\/STMTRS\s*>/gi)]
  if (statements.length !== 1) throw invalid("Importe um extrato OFX de uma única conta")
  const statement = statements[0]![1]!
  if (field(statement, "CURDEF").toUpperCase() !== "BRL") throw invalid("O extrato deve estar em reais")
  const bankAccount = field(statement, "ACCTID"),
    bankId = field(statement, "BANKID"),
    end = bankDate(field(statement, "DTEND"))
  if (bankAccount.length > 100 || bankId.length > 80) throw invalid("Identificação da conta fora do limite")
  const balanceBlock = /<LEDGERBAL\s*>([\s\S]*?)<\/LEDGERBAL\s*>/i.exec(statement)?.[1]
  const balanceDate = balanceBlock ? bankDate(field(balanceBlock, "DTASOF")) : undefined
  const balance = balanceBlock ? cents(field(balanceBlock, "BALAMT")) : null
  const lines = [...statement.matchAll(/<STMTTRN\s*>([\s\S]*?)<\/STMTTRN\s*>/gi)].map((match) => {
    const block = match[1]!,
      fitId = field(block, "FITID"),
      bookedOn = bankDate(field(block, "DTPOSTED")),
      signedCents = cents(field(block, "TRNAMT"))
    const description =
      [field(block, "NAME", false), field(block, "MEMO", false)].filter(Boolean).join(" • ") || field(block, "TRNTYPE")
    if (
      fitId.length > 255 ||
      description.length > 1500 ||
      !signedCents ||
      bookedOn > end ||
      field(block, "CORRECTFITID", false)
    )
      throw invalid("Lançamento OFX inválido ou retificação que exige conferência")
    return { fitId, bookedOn, signedCents, description }
  })
  if ((statement.match(/<STMTTRN\s*>/gi) || []).length !== lines.length || lines.length > 5000)
    throw invalid("Quantidade ou estrutura de lançamentos OFX inválida")
  const startRaw = field(statement, "DTSTART", false)
  const start = startRaw
    ? bankDate(startRaw)
    : lines.reduce((first, l) => (l.bookedOn < first ? l.bookedOn : first), end)
  if (start > end || lines.some((l) => l.bookedOn < start))
    throw invalid("O intervalo do extrato diverge das datas dos movimentos")
  return { bankAccount, bankId, start, end, balance: balanceDate === end ? balance : null, lines }
}
