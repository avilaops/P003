import type { AuthorizedContext } from "../../../platform/access.js"
import { requirePermission } from "../../../platform/access.js"
import { Problem } from "../../../platform/problem.js"
import { aggregateFunctions, resolveFilters, type Total } from "./definition.js"
import type { Cell, ColumnType, ReportSource, Row } from "./source.js"

/** Limite de linhas lidas da fonte por execução (tela, exportação e agenda). */
export const maxSourceRows = 10_000
export type ReportLayout = { name: string; columns: string[]; groupBy: string[]; totals: Total[]; filters: Record<string, unknown> }
export type ResultColumn = { key: string; label: string; type: ColumnType }
export type ReportResult = {
  title: string; source: string; sourceLabel: string; generatedAt: string
  filters: { key: string; label: string; value: string }[]
  columns: ResultColumn[]; rows: Row[]; totals: Row | null; totalColumns: ResultColumn[]; rowCount: number; sourceRows: number
}

const totalKey = (total: Total) => `${total.fn}_${total.column}`
function aggregate(values: number[], fn: Total["fn"]): number | null {
  if (!values.length) return null
  if (fn === "sum") return values.reduce((a, b) => a + b, 0)
  if (fn === "avg") return Math.round(values.reduce((a, b) => a + b, 0) / values.length * 100) / 100
  return fn === "min" ? Math.min(...values) : Math.max(...values)
}
function totalsFor(rows: Row[], totals: Total[]) {
  const out: Row = {}
  for (const total of totals) out[totalKey(total)] = aggregate(rows.map(row => row[total.column]).filter((v): v is number => typeof v === "number"), total.fn)
  return out
}
function filterText(source: ReportSource, key: string, value: unknown) {
  const filter = source.filters[key]!
  if (filter.kind === "period") { const p = value as { from: string; to: string }; return `${p.from} a ${p.to}` }
  if (filter.kind === "choice") return filter.options[value as string] ?? String(value)
  return String(value)
}

/** Executa um layout validado: lê a fonte, agrupa e totaliza. */
export async function executeReport(ctx: AuthorizedContext, source: ReportSource, layout: ReportLayout): Promise<ReportResult> {
  for (const code of source.permissions) requirePermission(ctx, code)
  const { rows: [clock] } = await ctx.client.query<{ today: string; now: string }>(
    "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today, to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS now")
  const resolved = resolveFilters(source, layout.filters, clock!.today)
  const loaded = await source.load(ctx, resolved, maxSourceRows + 1)
  if (loaded.length > maxSourceRows) throw new Problem(422, "report_too_large", `O relatório passa de ${maxSourceRows.toLocaleString("pt-BR")} linhas. Reduza o período ou acrescente filtros`)
  const meta = (key: string): ResultColumn => ({ key, label: source.columns[key]!.label, type: source.columns[key]!.type })
  const totalColumns = layout.totals.map(total => ({ key: totalKey(total), label: `${aggregateFunctions[total.fn]} de ${source.columns[total.column]!.label}`, type: total.fn === "avg" && source.columns[total.column]!.type !== "money" ? "number" as const : source.columns[total.column]!.type }))
  const filters = Object.entries(resolved).filter(([, v]) => v !== undefined).map(([key, value]) => ({ key, label: source.filters[key]!.label, value: filterText(source, key, value) }))
  const base = { title: layout.name, source: source.id, sourceLabel: source.label, generatedAt: clock!.now, filters, sourceRows: loaded.length }
  const count: ResultColumn = { key: "count", label: "Quantidade", type: "number" }
  if (!layout.groupBy.length) {
    const rows = loaded.map(row => Object.fromEntries(layout.columns.map(key => [key, row[key] ?? null])) as Row)
    const totals = layout.totals.length ? { count: loaded.length, ...totalsFor(loaded, layout.totals) } : null
    return { ...base, columns: layout.columns.map(meta), rows, totals, rowCount: rows.length, totalColumns: totals ? [count, ...totalColumns] : [] }
  }
  const groups = new Map<string, Row[]>()
  for (const row of loaded) {
    const key = JSON.stringify(layout.groupBy.map(column => row[column] ?? null))
    ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(row)
  }
  const rows = [...groups.entries()].map(([key, members]) => {
    const values = JSON.parse(key) as Cell[]
    return { ...Object.fromEntries(layout.groupBy.map((column, i) => [column, values[i] ?? null])), count: members.length, ...totalsFor(members, layout.totals) } as Row
  }).sort((a, b) => layout.groupBy.map(c => String(a[c] ?? "").localeCompare(String(b[c] ?? ""), "pt-BR")).find(x => x !== 0) ?? 0)
  return { ...base, columns: [...layout.groupBy.map(meta), count, ...totalColumns], rows, totals: { count: loaded.length, ...totalsFor(loaded, layout.totals) }, totalColumns: [count, ...totalColumns], rowCount: rows.length }
}
