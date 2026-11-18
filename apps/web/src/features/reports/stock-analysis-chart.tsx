import { useId } from "react"
import { stockAnalysisChart, type StockChartBar } from "./stock-analysis-charts"
import type { StockAnalysisResult } from "./stock-export"
import "./stock-analysis-chart.css"

const percent = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 })

function ClassDistribution({ bars }: { bars: StockChartBar[] }) {
  const total = bars.reduce((sum, bar) => sum + (bar.value ?? 0), 0)
  return <div className="mt-4 space-y-3">
    <div aria-hidden="true" className="flex h-7 overflow-hidden rounded-md border">
      {bars.map((bar, index) => bar.value ? <span key={bar.label} data-pattern={index} className="stock-class-mark"
        style={{ width: percentWidth(bar.value, total) }} /> : null)}
    </div>
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {bars.map((bar, index) => <li className="min-w-0" key={bar.label}>
        <div className="flex items-center gap-2 text-sm"><span aria-hidden="true" data-pattern={index} className="stock-class-mark h-4 w-4 shrink-0 rounded-sm border" />{bar.label}</div>
        <p className="text-sm tabular-nums">{bar.text} {bar.value === 1 ? "produto" : "produtos"} • {percent.format(total ? (bar.value ?? 0) / total : 0)}</p>
      </li>)}
    </ul>
  </div>
}

function percentWidth(value: number, maximum: number) {
  return (maximum ? Math.min(100, value / maximum * 100) : 0) + "%"
}

export function StockAnalysisChart({ report }: { report: StockAnalysisResult }) {
  const titleId = useId()
  const chart = stockAnalysisChart(report)
  if (!chart) return null
  const partial = report.offset > 0 || report.data.length < report.total
  const scope = partial
    ? `Somente a página ${Math.floor(report.offset / report.limit) + 1} • registros ${report.offset + 1} a ${report.offset + report.data.length} de ${report.total}.`
    : `Todos os registros do filtro (${report.total}).`
  return <figure aria-labelledby={titleId} className="min-w-0 rounded-xl border bg-card p-4">
    <figcaption className="space-y-1">
      <h3 id={titleId} className="font-semibold">{chart.title}</h3>
      <p className="text-sm text-muted-foreground">{scope} {chart.note}</p>
    </figcaption>
    {chart.distribution ? <ClassDistribution bars={chart.groups[0].bars} /> : <div className="mt-4 grid max-h-96 gap-4 overflow-y-auto">
      {chart.groups.map((group, index) => <div className="min-w-0 space-y-1" key={group.heading ?? index}>
        {group.heading && <h4 className="break-words font-medium">{group.heading}</h4>}
        <ul className="grid gap-2">{group.bars.map((bar, index) => <li key={index} className="min-w-0">
          <div className="flex flex-wrap justify-between gap-x-3 text-sm">
            <span className="min-w-0 break-words">{bar.label}</span><strong className="font-medium tabular-nums">{bar.text}</strong>
          </div>
          {bar.value !== null && <div aria-hidden="true" className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full forced-color-adjust-none forced-colors:bg-[Highlight] ${bar.label === "Saídas" ? "bg-chart-2" : "bg-chart-1"}`}
              style={{ width: percentWidth(bar.value, group.maximum) }} />
          </div>}
        </li>)}</ul>
      </div>)}
    </div>}
  </figure>
}
