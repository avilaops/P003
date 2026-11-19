import type { ReportSource } from "./source.js"
import { auditLogSource } from "./sources/audit-log.js"
import { salesOrdersSource } from "./sources/sales-orders.js"

/**
 * Registro único das fontes do motor. Para declarar uma fonte nova, crie o
 * arquivo em `sources/` e acrescente-o aqui (veja docs/relatorios.md).
 */
const sources: readonly ReportSource[] = [salesOrdersSource, auditLogSource]

export const reportSources: ReadonlyMap<string, ReportSource> = new Map(sources.map(source => [source.id, source]))

export function engineSource(id: string) { return reportSources.get(id) }

export function canUseSource(source: ReportSource, permissions: readonly string[]) {
  return source.permissions.every(code => permissions.includes(code))
}

/** Catálogo público (sem `load`) das fontes que a pessoa pode usar. */
export function visibleEngineCatalog(permissions: readonly string[]) {
  return [...reportSources.values()].filter(source => canUseSource(source, permissions)).map(({ load: _load, ...source }) => source)
}
