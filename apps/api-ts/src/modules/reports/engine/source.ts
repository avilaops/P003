import type { AuthorizedContext } from "../../../platform/access.js"

/**
 * Contrato de uma fonte de dados do motor de relatórios (G3).
 *
 * A fonte é a ÚNICA parte que conhece SQL. O usuário só escolhe, por nome,
 * colunas, filtros, agrupamentos e totais que a fonte declarou. Regras:
 *  - `load` filtra por `ctx.tenantId` e usa somente parâmetros ($1, $2…);
 *  - `permissions` são todas exigidas (rota, definição salva e execução agendada);
 *  - `load` devolve no máximo `limit` linhas (o motor pede `limit + 1` para detectar excesso).
 * Veja docs/relatorios.md.
 */
export type ColumnType = "text" | "number" | "money" | "date" | "datetime"
/** `money` em centavos (inteiro); `date` como AAAA-MM-DD; `datetime` em ISO 8601 UTC. */
export type Cell = string | number | null
export type Row = Record<string, Cell>

export type SourceColumn = { label: string; type: ColumnType; groupable?: boolean; aggregatable?: boolean }

export type SourceFilter =
  | { kind: "period"; label: string; required?: boolean }
  | { kind: "choice"; label: string; options: Record<string, string> }
  | { kind: "text"; label: string }

/** Filtros já validados e resolvidos (período relativo vira datas absolutas). */
export type ResolvedFilters = Record<string, string | { from: string; to: string } | undefined>

export type ReportArea = "vendas" | "estoque" | "compras" | "financeiro" | "servicos" | "auditoria"

export type ReportSource = {
  id: string
  label: string
  area: ReportArea
  description: string
  permissions: readonly string[]
  columns: Record<string, SourceColumn>
  filters: Record<string, SourceFilter>
  defaultColumns: readonly string[]
  load(ctx: AuthorizedContext, filters: ResolvedFilters, limit: number): Promise<Row[]>
}

/** Ajuda a declarar com checagem de tipos sem perder os literais. */
export function defineSource(source: ReportSource) { return source }
