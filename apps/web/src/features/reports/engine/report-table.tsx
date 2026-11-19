import { DataTable } from "@/components/workspace/data-table"
import { formatCell, type ReportResult } from "./engine-model"

export function ReportTable({ result, limit }: { result: ReportResult; limit?: number }) {
  const numeric = (type: string) => type === "money" || type === "number"
  return <div className="space-y-2">
    <p className="text-xs text-muted-foreground">{result.sourceLabel}{result.filters.map(f => ` • ${f.label}: ${f.value}`).join("")} • {result.rowCount.toLocaleString("pt-BR")} linha(s)</p>
    <div className="overflow-x-auto rounded-md border">
      <DataTable className="text-xs">
        <caption className="sr-only">{result.title}</caption>
        <thead><tr>{result.columns.map(c => <th scope="col" className={"px-2 py-1.5 " + (numeric(c.type) ? "text-right" : "")} key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>
          {result.rows.map((row, i) => <tr key={i} className="border-t">{result.columns.map(c => <td className={"px-2 py-1 " + (numeric(c.type) ? "text-right tabular-nums" : "")} key={c.key}>{formatCell(c.type, row[c.key] ?? null)}</td>)}</tr>)}
          {!result.rows.length && <tr><td className="px-2 py-3 text-muted-foreground" colSpan={result.columns.length}>Nenhum registro no período e filtros escolhidos.</td></tr>}
        </tbody>
      </DataTable>
    </div>
    {limit !== undefined && result.rowCount > result.rows.length && <p className="text-xs text-muted-foreground">Mostrando {result.rows.length} de {result.rowCount}. A exportação leva todas as linhas.</p>}
    {result.totals && result.totalColumns.length > 0 && <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">{result.totalColumns.map(c => <div key={c.key} className="flex gap-1"><dt className="text-muted-foreground">{c.label}:</dt><dd className="font-semibold tabular-nums">{formatCell(c.type, result.totals![c.key] ?? null)}</dd></div>)}</dl>}
  </div>
}
