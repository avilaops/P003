// Tipos e formatação do motor de relatórios (G3). Contrato: apps/api-ts/src/modules/reports/engine.
export type ColumnType = "text" | "number" | "money" | "date" | "datetime"
export type Cell = string | number | null
export type SourceFilter = { kind: "period"; label: string; required?: boolean } | { kind: "choice"; label: string; options: Record<string, string> } | { kind: "text"; label: string }
export type EngineSource = {
  id: string; label: string; area: string; description: string; permissions: string[]
  columns: Record<string, { label: string; type: ColumnType; groupable?: boolean; aggregatable?: boolean }>
  filters: Record<string, SourceFilter>; defaultColumns: string[]
}
export type Total = { column: string; fn: "sum" | "avg" | "min" | "max" }
export type Period = { preset: string; from?: string; to?: string }
export type Definition = { id: string; name: string; dataset: string; columns: string[]; groupBy: string[]; totals: Total[]; filters: Record<string, unknown>; visibility: "private" | "tenant"; revision: number }
export type ResultColumn = { key: string; label: string; type: ColumnType }
export type ReportResult = {
  title: string; sourceLabel: string; generatedAt: string; filters: { key: string; label: string; value: string }[]
  columns: ResultColumn[]; rows: Record<string, Cell>[]; totals: Record<string, Cell> | null; totalColumns: ResultColumn[]; rowCount: number
}
export type Schedule = { id: string; frequency: "daily" | "weekly" | "monthly"; weekday: number | null; monthDay: number | null; hour: number; format: "csv" | "xlsx" | "pdf"; recipients: string[]; active: boolean; nextRunAt: string; revision: number }
export type Run = { id: string; status: "sending" | "sent" | "failed" | "unknown"; format: string; rowCount: number | null; fileName: string | null; error: string | null; scheduledFor: string; recipients: string[] }

export const aggregateLabels: Record<Total["fn"], string> = { sum: "Soma", avg: "Média", min: "Mínimo", max: "Máximo" }
export const periodLabels: Record<string, string> = { today: "Hoje", yesterday: "Ontem", last_7_days: "Últimos 7 dias", last_30_days: "Últimos 30 dias", current_month: "Mês atual", previous_month: "Mês anterior", current_year: "Ano atual", custom: "Personalizado" }
export const weekdays = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"]
export const frequencyLabels = { daily: "Diário", weekly: "Semanal", monthly: "Mensal" }
export const runStatusLabels = { sending: "Enviando", sent: "Enviado", failed: "Falhou", unknown: "Sem confirmação" }
export const formatLabels = { csv: "CSV", xlsx: "Excel (XLSX)", pdf: "PDF" }
export const areaLabels: Record<string, string> = { vendas: "Vendas", estoque: "Estoque", compras: "Compras", financeiro: "Financeiro", servicos: "Serviços", auditoria: "Auditoria" }
export const field = "h-8 rounded-md border border-input bg-background px-2 text-sm"

export function formatCell(type: ColumnType, value: Cell) {
  if (value === null || value === undefined) return "—"
  if (type === "money" && typeof value === "number") return (value / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
  if (type === "number" && typeof value === "number") return value.toLocaleString("pt-BR", { maximumFractionDigits: 6 })
  if (type === "date" && typeof value === "string") return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`
  if (type === "datetime" && typeof value === "string") return new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })
  return String(value)
}
export function scheduleLabel(schedule: Schedule) {
  const hour = `${String(schedule.hour).padStart(2, "0")}h`
  if (schedule.frequency === "weekly") return `Toda ${weekdays[schedule.weekday ?? 0]!.toLowerCase()}, ${hour}`
  if (schedule.frequency === "monthly") return `Todo dia ${schedule.monthDay}, ${hour}`
  return `Todos os dias, ${hour}`
}
export function problem(body: unknown, fallback: string) {
  return typeof (body as { title?: unknown } | null)?.title === "string" ? (body as { title: string }).title : fallback
}
