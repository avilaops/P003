import { createHash } from "node:crypto"
import { invalid } from "./ledger.js"
import { bankDate } from "./ofx.js"

// Efí • Extrato CNAB 240, lote 033, serviço 04, segmento E (posições FEBRABAN).
export function parseEfiStatement(content: string) {
  const rows = content.replace(/(?:\r?\n)+$/, "").split(/\r?\n/)
  if (rows.length < 4 || rows.some((r) => r.length !== 240 || !r.startsWith("364")))
    throw invalid("O retorno exige registros Efí de 240 posições")
  const header = rows[0]!,
    batch = rows[1]!,
    trailer = rows.at(-2)!,
    endFile = rows.at(-1)!
  const lot = batch.slice(3, 7)
  if (
    header.slice(3, 8) !== "00000" ||
    batch.slice(7, 11) !== "1E04" ||
    batch.slice(13, 16) !== "033" ||
    trailer.slice(3, 8) !== lot + "5" ||
    endFile.slice(3, 8) !== "99999" ||
    Number(endFile.slice(17, 23)) !== 1 ||
    Number(endFile.slice(23, 29)) !== rows.length ||
    Number(trailer.slice(170, 176)) !== rows.length - 2
  )
    throw invalid("Confira o lote, versão e contadores do extrato Efí")
  const digits = (v: string) => {
    if (!/^\d+$/.test(v)) throw invalid("Valor inválido no extrato Efí")
    return BigInt(v)
  }
  const readDate = (r: string) => {
    const v = r.slice(142, 150)
    return bankDate(v.slice(4) + v.slice(2, 4) + v.slice(0, 2))
  }
  const signed = (r: string) => {
    const signal = r[168]
    if (signal !== "C" && signal !== "D") throw invalid("Sinal inválido no extrato Efí")
    return digits(r.slice(150, 168)) * (signal === "D" ? -1n : 1n)
  }
  const acct = batch.slice(52, 72),
    bankAccount = batch.slice(58, 70).trim() + batch.slice(70, 71).trim(),
    end = readDate(trailer)
  if (trailer.slice(52, 72) !== acct) throw invalid("Contas diferentes no mesmo lote")
  const seen = new Map<string, number>()
  const lines = rows.slice(2, -2).map((r, i) => {
    if (r.slice(3, 8) !== lot + "3" || r[13] !== "E" || r.slice(52, 72) !== acct || Number(r.slice(8, 13)) !== i + 1)
      throw invalid("Detalhe fora da sequência do lote Efí")
    const bookedOn = readDate(r),
      signedCents = signed(r),
      memo = r.slice(176, 201).trim(),
      document = r.slice(201, 240).trim()
    if (!signedCents || bookedOn > end) throw invalid("Movimento Efí inválido")
    const fingerprint = createHash("sha256").update(r.slice(14)).digest("hex"),
      ordinal = (seen.get(fingerprint) ?? 0) + 1
    seen.set(fingerprint, ordinal)
    return {
      fitId: "EFI-" + fingerprint + "-" + ordinal,
      bookedOn,
      signedCents,
      description: [memo, document].filter(Boolean).join(" • ") || r.slice(172, 176),
    }
  })
  const balance = signed(trailer),
    opening = signed(batch)
  if (opening + lines.reduce((sum, l) => sum + l.signedCents, 0n) !== balance)
    throw invalid("Os movimentos do lote divergem do saldo final")
  const start = readDate(batch)
  if (start > end || lines.some((l) => l.bookedOn < start)) throw invalid("Intervalo do lote Efí inválido")
  return { bankId: "364", bankAccount, start, end, balance, lines }
}
