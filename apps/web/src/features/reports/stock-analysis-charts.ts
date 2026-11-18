import type { StockAnalysisResult } from "./stock-export"

type Report = Pick<StockAnalysisResult, "dataset" | "columns" | "data">
type Row = Report["data"][number]
export type StockChartBar = { label: string; value: number | null; text: string }
type Group = { heading?: string; maximum: number; bars: StockChartBar[] }
type Chart = { title: string; note?: string; distribution?: boolean; groups: Group[] }

const numberFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 6 })

function number(value: Row[string] | undefined) {
  if (value == null || String(value).trim() === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function scaled(bars: StockChartBar[], heading?: string): Group {
  return { heading, bars, maximum: Math.max(0, ...bars.map(bar => bar.value ?? 0)) }
}

const million = BigInt(1000000)
function addMicros(sum: bigint | null, value: Row[string] | undefined) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(value))
  if (sum === null || !match) return null
  return sum + BigInt(match[1]) * million + BigInt((match[2] ?? "").padEnd(6, "0"))
}

function quantityBar(label: string, micros: bigint | null, unit: string): StockChartBar {
  if (micros === null) return { label, value: null, text: "A apurar" }
  const whole = numberFormat.format(micros / million)
  const fraction = String(micros % million).padStart(6, "0").replace(/0+$/, "")
  return { label, value: Number(micros) / 1000000, text: whole + (fraction ? "," + fraction : "") + " " + unit }
}

function movements(rows: Row[]): Chart | null {
  const units = new Map<string, { receipts: bigint | null; issues: bigint | null }>()
  for (const row of rows) {
    if (typeof row.unit !== "string" || !row.unit.trim()) return null
    const previous = units.get(row.unit) ?? { receipts: BigInt(0), issues: BigInt(0) }
    units.set(row.unit, { receipts: addMicros(previous.receipts, row.receipts), issues: addMicros(previous.issues, row.issues) })
  }
  const groups = Array.from(units, ([unit, sums]) => scaled([
    quantityBar("Entradas", sums.receipts, unit), quantityBar("Saídas", sums.issues, unit),
  ], unit))
  return { title: "Entradas e saídas por unidade", note: "Cada unidade tem sua própria escala.", groups }
}

function percentage(label: string, value: Row[string] | undefined, empty: string): StockChartBar {
  const percent = number(value)
  return { label, value: percent, text: percent === null ? empty : numberFormat.format(percent) + "%" }
}

function counted(label: string, count: number | null): StockChartBar {
  return { label, value: count, text: count === null ? "A apurar" : numberFormat.format(count) }
}

export function stockAnalysisChart(report: Report): Chart | null {
  if (!report.data.length) return null
  const columns = new Set(report.columns.map(column => column.key))
  const has = (...keys: string[]) => keys.every(key => columns.has(key))
  switch (report.dataset) {
    case "stock_movement_activity":
      return has("unit", "receipts", "issues") ? movements(report.data) : null
    case "stock_count_progress": {
      if (!has("reference", "progress")) return null
      const bars = report.data.map(row => percentage(String(row.reference ?? "Sem referência"), row.progress,
        number(row.lines) === 0 ? "Sem linhas para contar" : "A apurar"))
      return { title: "Progresso por inventário", note: "Percentual das linhas já contadas.", groups: [{ maximum: 100, bars }] }
    }
    case "stock_production_progress": {
      if (!has("stage", "orders")) return null
      const stages = new Map<string, number | null>()
      for (const row of report.data) {
        const stage = String(row.stage ?? "Sem etapa")
        const orders = number(row.orders), previous = stages.get(stage)
        stages.set(stage, orders === null || previous === null ? null : (previous ?? 0) + orders)
      }
      return { title: "Ordens por etapa", groups: [scaled(Array.from(stages, ([stage, orders]) => counted(stage, orders)))] }
    }
    case "stock_abc": {
      if (!has("class")) return null
      const classes = new Map([["A", 0], ["B", 0], ["C", 0], ["A apurar", 0]])
      for (const row of report.data) {
        const name = String(row.class ?? "A apurar")
        classes.set(name, (classes.get(name) ?? 0) + 1)
      }
      const bars = Array.from(classes, ([name, count]) => counted(name === "A apurar" ? name : "Classe " + name, count))
      return { title: "Produtos por classe ABC", note: "O percentual indica a parcela de produtos em cada classe.", distribution: true, groups: [scaled(bars)] }
    }
    case "stock_accuracy": {
      if (!has("accuracy")) return null
      const row = report.data[0]
      const lines = number(row.lines), matched = number(row.matched)
      const note = lines !== null && matched !== null ? numberFormat.format(matched) + " de " + numberFormat.format(lines) + " linhas contadas sem diferença." : undefined
      const bar = percentage("Linhas sem diferença", row.accuracy, lines === 0 ? "Sem linhas contadas" : "A apurar")
      return { title: "Acurácia das contagens", note, groups: [{ maximum: 100, bars: [bar] }] }
    }
    default:
      return null
  }
}
