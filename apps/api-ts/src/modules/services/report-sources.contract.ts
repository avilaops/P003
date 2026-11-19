import type { AuthorizedContext } from "../../platform/access.js"

/**
 * Espelho estrutural do contrato `ReportSource` do motor de relatórios (#301/G3,
 * `modules/reports/engine/source.ts`), que ainda não foi mesclado. As fontes de
 * Serviços (`report-sources.ts`) são declaradas contra este tipo; quando o motor
 * entrar, basta trocar o import por `../reports/engine/source.js` e acrescentar
 * `serviceReportSources` à lista de `registry.ts`. Não há outra mudança.
 */
export type ColumnType = "text" | "number" | "money" | "date" | "datetime"
export type Cell = string | number | null
export type Row = Record<string, Cell>
export type SourceColumn = { label: string; type: ColumnType; groupable?: boolean; aggregatable?: boolean }
export type SourceFilter =
  | { kind: "period"; label: string; required?: boolean }
  | { kind: "choice"; label: string; options: Record<string, string> }
  | { kind: "text"; label: string }
export type ResolvedFilters = Record<string, string | { from: string; to: string } | undefined>
export type ReportSource = {
  id: string; label: string; area: "servicos"; description: string; permissions: readonly string[]
  columns: Record<string, SourceColumn>; filters: Record<string, SourceFilter>; defaultColumns: readonly string[]
  load(ctx: AuthorizedContext, filters: ResolvedFilters, limit: number): Promise<Row[]>
}
export const defineSource = (source: ReportSource) => source
