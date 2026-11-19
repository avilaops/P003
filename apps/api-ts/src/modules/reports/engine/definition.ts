import { z } from "zod"
import { Problem } from "../../../platform/problem.js"
import type { ReportSource, ResolvedFilters } from "./source.js"

export const aggregateFunctions = { sum: "Soma", avg: "Média", min: "Mínimo", max: "Máximo" } as const
export type AggregateFunction = keyof typeof aggregateFunctions
export type Total = { column: string; fn: AggregateFunction }
export const periodPresets = ["today", "yesterday", "last_7_days", "last_30_days", "current_month", "previous_month", "current_year", "custom"] as const
export type PeriodValue = { preset: (typeof periodPresets)[number]; from?: string; to?: string }

const control = /[\u0000-\u001f\u007f-\u009f]/u
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().startsWith(value))
const periodSchema = z.strictObject({ preset: z.enum(periodPresets), from: date.optional(), to: date.optional() })
export const totalSchema = z.strictObject({ column: z.string().max(63), fn: z.enum(Object.keys(aggregateFunctions) as [AggregateFunction, ...AggregateFunction[]]) })

function invalid(title: string): never { throw new Problem(422, "invalid_input", title) }

/** Valida colunas, agrupamentos, totais e filtros contra o que a fonte declarou. */
export function validateLayout(source: ReportSource, input: { columns: string[]; groupBy: string[]; totals: Total[]; filters: Record<string, unknown> }) {
  const columns = [...new Set(input.columns)], groupBy = [...new Set(input.groupBy)]
  if (!columns.length || columns.some(column => !Object.hasOwn(source.columns, column))) invalid("Selecione somente colunas permitidas para a fonte")
  if (groupBy.length > 2 || groupBy.some(column => !source.columns[column]?.groupable)) invalid("Agrupe por até duas colunas agrupáveis da fonte")
  const seen = new Set<string>()
  for (const total of input.totals) {
    const key = total.fn + ":" + total.column
    if (!source.columns[total.column]?.aggregatable || seen.has(key)) invalid("Totais aceitam somente colunas numéricas da fonte, sem repetição")
    seen.add(key)
  }
  const filters: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input.filters)) {
    const filter = Object.hasOwn(source.filters, key) ? source.filters[key] : undefined
    if (!filter) invalid("Filtro não declarado pela fonte: " + key.slice(0, 40))
    if (filter.kind === "period") {
      const parsed = periodSchema.safeParse(value)
      if (!parsed.success || parsed.data.preset === "custom" && (!parsed.data.from || !parsed.data.to || parsed.data.from > parsed.data.to) ||
        parsed.data.preset !== "custom" && (parsed.data.from || parsed.data.to)) invalid("Período inválido")
      filters[key] = parsed.data
    } else if (filter.kind === "choice") {
      if (typeof value !== "string" || !Object.hasOwn(filter.options, value)) invalid("Opção de filtro inválida: " + filter.label)
      filters[key] = value
    } else {
      if (typeof value !== "string") invalid("Filtro de texto inválido: " + filter.label)
      const text = value.trim()
      if (!text) continue
      if (text.length > 120 || control.test(text)) invalid("Filtro de texto deve ter até 120 caracteres")
      filters[key] = text
    }
  }
  for (const [key, filter] of Object.entries(source.filters)) {
    if (filter.kind === "period" && filter.required && !filters[key]) filters[key] = { preset: "last_30_days" }
  }
  return { columns, groupBy, totals: input.totals, filters }
}

const addDays = (day: string, days: number) => new Date(Date.parse(day + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10)
/** Resolve períodos relativos contra a data de referência (dia de São Paulo). */
export function resolvePeriod(value: PeriodValue, today: string) {
  const [year, month] = today.split("-").map(Number) as [number, number]
  const monthStart = today.slice(0, 8) + "01"
  switch (value.preset) {
    case "today": return { from: today, to: today }
    case "yesterday": return { from: addDays(today, -1), to: addDays(today, -1) }
    case "last_7_days": return { from: addDays(today, -6), to: today }
    case "last_30_days": return { from: addDays(today, -29), to: today }
    case "current_month": return { from: monthStart, to: today }
    case "previous_month": {
      const start = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10)
      return { from: start, to: addDays(monthStart, -1) }
    }
    case "current_year": return { from: `${year}-01-01`, to: today }
    case "custom": return { from: value.from!, to: value.to! }
  }
}

export function resolveFilters(source: ReportSource, filters: Record<string, unknown>, today: string): ResolvedFilters {
  const resolved: ResolvedFilters = {}
  for (const [key, value] of Object.entries(filters)) {
    resolved[key] = source.filters[key]?.kind === "period" ? resolvePeriod(value as PeriodValue, today) : value as string
  }
  return resolved
}
