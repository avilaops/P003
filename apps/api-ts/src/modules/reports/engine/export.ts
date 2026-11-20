import PDFDocument from "pdfkit"
import type { ReportResult, ResultColumn } from "./run.js"
import type { Cell } from "./source.js"
import { zip } from "./zip.js"

export const exportFormats = {
  csv: { contentType: "text/csv; charset=utf-8", extension: "csv" },
  xlsx: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" },
  pdf: { contentType: "application/pdf", extension: "pdf" },
} as const
export type ExportFormat = keyof typeof exportFormats

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dateBr = (value: string) => `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`
/** Texto de exibição (CSV e PDF), no padrão brasileiro. */
export function displayCell(column: ResultColumn, value: Cell) {
  if (value === null || value === undefined) return ""
  if (column.type === "money" && typeof value === "number") return money(value)
  if (column.type === "number" && typeof value === "number") return value.toLocaleString("pt-BR", { maximumFractionDigits: 6 })
  if (column.type === "date" && typeof value === "string") return dateBr(value)
  if (column.type === "datetime" && typeof value === "string") {
    const local = new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })
    return local === "Invalid Date" ? value : local
  }
  return String(value)
}
// Neutraliza fórmulas em planilhas (CSV injection).
const safeText = (text: string) => /^[\s﻿]*[=+\-@]|^[\t\r\n]/u.test(text) ? "'" + text : text

export function fileName(result: ReportResult, format: ExportFormat) {
  const base = result.title.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 60) || "relatorio"
  return `${base}-${result.generatedAt.slice(0, 10)}.${exportFormats[format].extension}`
}

function tableRows(result: ReportResult) {
  const header = result.columns.map(c => c.label)
  const body = result.rows.map(row => result.columns.map(c => row[c.key] ?? null))
  return { header, body }
}

export function toCsv(result: ReportResult) {
  const quote = (text: string) => `"${text.replaceAll('"', '""')}"`
  const lines = [result.columns.map(c => quote(c.label)).join(";")]
  for (const row of result.rows) lines.push(result.columns.map(c => {
    const text = displayCell(c, row[c.key] ?? null)
    return quote(c.type === "text" ? safeText(text) : text)
  }).join(";"))
  if (result.totals && result.totalColumns.length) {
    lines.push("", quote("Totais"))
    for (const c of result.totalColumns) lines.push(`${quote(c.label)};${quote(displayCell(c, result.totals[c.key] ?? null))}`)
  }
  return Buffer.from("﻿" + lines.join("\r\n"), "utf8")
}

const xml = (text: string) => text.replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
function columnName(index: number) { let name = ""; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name }
function xlsxCell(column: ResultColumn, value: Cell, ref: string, header = false) {
  if (value === null || value === undefined) return ""
  if (!header && typeof value === "number") {
    const style = column.type === "money" ? 2 : 0
    return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${column.type === "money" ? value / 100 : value}</v></c>`
  }
  const text = header ? String(value) : displayCell(column, value)
  return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ""}><is><t xml:space="preserve">${xml(text)}</t></is></c>`
}

export function toXlsx(result: ReportResult) {
  const rows: string[] = []
  const push = (cells: string) => rows.push(`<row r="${rows.length + 1}">${cells}</row>`)
  push(result.columns.map((c, i) => xlsxCell(c, c.label, columnName(i) + "1", true)).join(""))
  for (const row of result.rows) { const r = rows.length + 1; push(result.columns.map((c, i) => xlsxCell(c, row[c.key] ?? null, columnName(i) + r)).join("")) }
  if (result.totals && result.totalColumns.length) {
    rows.push(`<row r="${rows.length + 1}"/>`)
    for (const c of result.totalColumns) {
      const r = rows.length + 1
      push(xlsxCell(c, c.label, "A" + r, true) + xlsxCell(c, result.totals[c.key] ?? null, "B" + r))
    }
  }
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`
  const title = xml(result.title.slice(0, 31).replace(/[\\/?*[\]:]/g, " ") || "Relatório")
  const file = (name: string, text: string) => ({ name, data: Buffer.from(text, "utf8") })
  return zip([
    file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${title}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    file("xl/styles.xml", styles),
    file("xl/worksheets/sheet1.xml", sheet),
  ])
}

export function toPdf(result: ReportResult, company: string) {
  const pdf = new PDFDocument({ size: "A4", layout: result.columns.length > 5 ? "landscape" : "portrait", margins: { top: 36, left: 36, right: 36, bottom: 36 }, info: { Title: result.title, Author: company } })
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => { pdf.on("data", c => chunks.push(c)); pdf.on("end", () => resolve(Buffer.concat(chunks))); pdf.on("error", reject) })
  const left = pdf.page.margins.left, width = pdf.page.width - left - pdf.page.margins.right
  pdf.fillColor("#173247").font("Helvetica-Bold").fontSize(14).text(result.title)
  pdf.font("Helvetica").fontSize(8.5).fillColor("#444").text(`${company} • ${result.sourceLabel} • gerado em ${displayCell({ key: "", label: "", type: "datetime" }, result.generatedAt)}`)
  if (result.filters.length) pdf.text(result.filters.map(f => `${f.label}: ${f.value}`).join(" • "))
  pdf.moveDown(0.6)
  const { header, body } = tableRows(result)
  const col = width / Math.max(header.length, 1)
  const line = (cells: string[], bold: boolean, columns: ResultColumn[]) => {
    if (pdf.y > pdf.page.height - pdf.page.margins.bottom - 24) pdf.addPage()
    const y = pdf.y
    pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8).fillColor("#111")
    let height = 0
    cells.forEach((text, i) => {
      const numeric = !bold && ["money", "number"].includes(columns[i]?.type ?? "")
      pdf.text(text, left + i * col + 2, y, { width: col - 4, align: numeric ? "right" : "left", lineBreak: true })
      height = Math.max(height, pdf.y - y)
    })
    pdf.y = y + height + 3
    pdf.moveTo(left, pdf.y - 1.5).lineTo(left + width, pdf.y - 1.5).lineWidth(0.3).strokeColor("#ccc").stroke()
  }
  line(header, true, result.columns)
  for (const row of body) line(row.map((v, i) => displayCell(result.columns[i]!, v)), false, result.columns)
  if (!body.length) pdf.font("Helvetica").fontSize(8.5).text("Nenhum registro no período e filtros escolhidos.", left, pdf.y)
  if (result.totals && result.totalColumns.length) {
    pdf.moveDown(0.6).font("Helvetica-Bold").fontSize(9).text("Totais", left, pdf.y)
    for (const c of result.totalColumns) pdf.font("Helvetica").fontSize(8.5).text(`${c.label}: ${displayCell(c, result.totals[c.key] ?? null)}`, left)
  }
  pdf.end()
  return done
}

export async function renderReport(result: ReportResult, format: ExportFormat, company: string) {
  const content = format === "csv" ? toCsv(result) : format === "xlsx" ? toXlsx(result) : await toPdf(result, company)
  return { content, contentType: exportFormats[format].contentType, fileName: fileName(result, format) }
}
