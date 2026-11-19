export const MAX_BYTES = 2 * 1024 * 1024
export const MAX_ROWS = 5_000

// Port of the Rust parser: BOM stripped, delimiter inferred from the first line,
// quoted fields, blank rows skipped. Failures carry a user-facing message.
export function parseCsv(content: string): string[][] {
  const text = content.startsWith("﻿") ? content.slice(1) : content
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Arquivo CSV acima do limite de 2 MiB")
  if (text.length === 0) throw new Error("O arquivo CSV está vazio")
  const first = text.split(/\r?\n/, 1)[0] ?? ""
  let delimiter = ","
  let best = -1
  for (const candidate of [",", ";", "\t"]) {
    const count = first.split(candidate).length - 1
    if (count >= best) { best = count; delimiter = candidate }
  }
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  const flush = () => { if (row.some(value => value.trim() !== "")) rows.push(row); row = [] }
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++ } else quoted = !quoted
    } else if (character === delimiter && !quoted) {
      row.push(field); field = ""
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index++
      row.push(field); field = ""
      flush()
    } else field += character
  }
  if (quoted) throw new Error("CSV inválido: aspas não fechadas")
  if (field !== "" || row.length > 0) { row.push(field); flush() }
  if (rows.length === 0 || rows.length > MAX_ROWS + 1) throw new Error("O CSV deve conter entre 1 e 5000 linhas de dados")
  return rows
}

// Spreadsheet formulas are neutralized before quoting.
export function csvCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}
