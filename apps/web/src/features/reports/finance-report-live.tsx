"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { ReportActions, ReportDocument, useReportPreview } from "@/components/documents/report-document"
import { EmptyState, ErrorState, LoadingState } from "@/components/workspace/resource-state"
import { FinancialDocumentEmail } from "@/features/finance/financial-document-email"
import { FinanceStatements } from "@/features/finance/finance-statements"
import {
  overdueShare,
  bucketLabels,
  dateLabel,
  fieldStyle,
  reais,
  sideLabels,
  titleUrl,
  type Portfolio,
  type PortfolioRow,
} from "@/features/finance/finance-insights-model"
import { useResource } from "@/hooks/use-operation"
import { erpFetch } from "@/lib/api/client"
import { downloadCsv } from "@/lib/csv-export"

const columns = ["Carteira", "Contraparte", "Vencimento", "Original", "Liquidado", "Saldo", "Situação"]
function metrics(data: Portfolio) {
  return [
    ["A receber", reais(data.totals.receivable)],
    ["A pagar", reais(data.totals.payable)],
    ["Recebíveis vencidos", reais(data.totals.overdueReceivable)],
    ["Pagamentos vencidos", reais(data.totals.overduePayable)],
  ]
}
function cells(row: PortfolioRow) {
  const status =
    row.status === "cancelled"
      ? "Cancelado"
      : row.status === "paid"
        ? "Liquidado"
        : row.settled === "0.00"
          ? "Em aberto"
          : "Parcial"
  return [
    sideLabels[row.side],
    row.party,
    dateLabel(row.dueDate),
    reais(row.amount),
    reais(row.settled),
    reais(row.outstanding),
    row.nextMovementOn ? status + " • movimento em " + dateLabel(row.nextMovementOn) : status,
  ]
}
export function FinanceReportLive() {
  return (
    <Suspense fallback={<LoadingState>Carregando relatório…</LoadingState>}>
      <PortfolioReport />
    </Suspense>
  )
}
function PortfolioReport() {
  const search = useSearchParams()
  const [tab, setTab] = useState("portfolio")
  const [side, setSide] = useState(search.get("side") ?? "")
  const [bucket, setBucket] = useState(search.get("bucket") ?? "")
  const [status, setStatus] = useState(search.get("status") ?? "")
  const [from, setFrom] = useState(search.get("from") ?? "")
  const [to, setTo] = useState(search.get("to") ?? "")
  const [q, setQ] = useState(search.get("q") ?? "")
  const [offset, setOffset] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState("")
  const [emailLocked, setEmailLocked] = useState(false)
  const filters = new URLSearchParams()
  for (const [key, value] of Object.entries({ side, bucket, status, from, to, q })) if (value) filters.set(key, value)
  const query = filters.toString()
  const url = "/api/erp/finance/portfolio"
  const result = useResource<Portfolio>(tab === "portfolio" ? url + "?" + query + "&limit=30&offset=" + offset : "")
  const data = result.value
  const preview = useReportPreview()
  const print = useResource<Portfolio>(preview.open && tab === "portfolio" ? url + "/export?" + query : "")
  const totals = data ? metrics(data) : []
  const period = [
    "Data de vencimento", from && "desde " + dateLabel(from), to && "até " + dateLabel(to),
    !from && !to && "todos os períodos",
  ].filter(Boolean).join(" • ")
  const scope = [
    side === "receivable" ? "A receber" : side === "payable" ? "A pagar" : "A receber e a pagar",
    q && "Contraparte contém “" + q + "”", bucket && bucketLabels[bucket],
    status === "open" ? "Em aberto" : status === "paid" ? "Liquidadas" : status === "cancelled" ? "Canceladas" : "",
  ].filter(Boolean).join(" • ")
  async function exportCsv() {
    setExporting(true)
    setExportError("")
    try {
      const response = await erpFetch(url + "/export?" + query)
      if (!response.ok) throw Error()
      const exported: Portfolio = await response.json()
      if (!data || exported.tenantId !== data.tenantId) throw Error()
      downloadCsv("carteira-financeira.csv", [
        columns,
        ...exported.rows.map((row) => cells(row).map((cell) => (/^[=+@\-\t\r]/.test(cell) ? "'" + cell : cell))),
      ])
    } catch {
      setExportError("Não foi possível exportar a carteira.")
    } finally {
      setExporting(false)
    }
  }
  return (
    <main data-report-workspace className="workspace-page-frame space-y-5">
      <PageHeader eyebrow="Financeiro" title="Relatórios financeiros" back={{ href: "/financeiro", label: "Financeiro" }} />
      <nav className="flex flex-wrap gap-2" aria-label="Relatório">
        {[
          ["portfolio", "Carteiras e atrasos"],
          ["cashflow", "Fluxo de caixa"],
          ["income", "DRE gerencial"],
        ].map(([id, name]) => (
          <Button key={id} disabled={emailLocked} variant={tab === id ? "default" : "outline"} aria-pressed={tab === id} onClick={() => setTab(id!)}>
            {name}
          </Button>
        ))}
      </nav>
      {tab !== "portfolio" ? (
        <FinanceStatements type={tab === "income" ? "income" : "cashflow"} />
      ) : (
        <>
          <fieldset disabled={emailLocked} aria-label="Filtros da carteira" className="flex flex-wrap items-end gap-3">
            {[
              [
                "Carteira",
                side,
                setSide,
                [
                  ["", "Ambas"],
                  ["receivable", "A receber"],
                  ["payable", "A pagar"],
                ],
              ],
              ["Faixa de vencimento", bucket, setBucket, [["", "Todas"], ...Object.entries(bucketLabels)]],
              [
                "Situação",
                status,
                setStatus,
                [
                  ["", "Todas"],
                  ["open", "Em aberto"],
                  ["paid", "Liquidadas"],
                  ["cancelled", "Canceladas"],
                ],
              ],
            ].map(([label, value, change, options]) => (
              <label key={String(label)} className="grid gap-1 text-sm">
                {String(label)}
                <select
                  className={fieldStyle}
                  value={String(value)}
                  onChange={(e) => {
                    ;(change as (s: string) => void)(e.target.value)
                    setOffset(0)
                  }}
                >
                  {(options as string[][]).map(([key, name]) => (
                    <option key={key} value={key}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="grid gap-1 text-sm">
              Contraparte
              <input
                className={fieldStyle}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setOffset(0)
                }}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Vencimento inicial
              <input
                className={fieldStyle}
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value)
                  setOffset(0)
                }}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Vencimento final
              <input
                className={fieldStyle}
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value)
                  setOffset(0)
                }}
              />
            </label>
          </fieldset>
          {result.loading ? (
            <LoadingState>Consultando a carteira…</LoadingState>
          ) : result.error ? (
            <ErrorState title="Falha na consulta" message={result.error} status={result.status} onRetry={result.reload} />
          ) : (
            data && (
              <>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {totals.map(([label, value]) => (
                    <div key={label} className="rounded-lg border p-4">
                      <p className="text-sm">{label}</p>
                      <strong className="text-xl">{value}</strong>
                    </div>
                  ))}
                </div>
                <section>
                  <h2 className="font-semibold">Saldo por faixa de vencimento</h2>
                  {data.allowed.includes("receivable")&&<p>Inadimplência sobre o saldo a receber do filtro • {overdueShare(data.totals.overdueReceivable,data.totals.receivable)}</p>}
                  <div className="flex flex-wrap gap-2">
                    {data.buckets.map((item) => (
                      <Button
                        key={item.bucket}
                        disabled={emailLocked}
                        variant="outline"
                        className="h-auto whitespace-normal text-left"
                        onClick={() => {
                          setBucket(item.bucket)
                          setOffset(0)
                        }}
                      >
                        {bucketLabels[item.bucket]} • {item.count} • receber {reais(item.receivable)} • pagar{" "}
                        {reais(item.payable)}
                      </Button>
                    ))}
                  </div>
                </section>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="mr-auto">
                    {data.companyName} • {data.total} títulos • posição em {dateLabel(data.asOf)} • {period}
                    {data.totals.futureMovementTitles > 0 && <> • Títulos com movimento futuro • {data.totals.futureMovementTitles}</>}
                  </p>
                  <Button disabled={exporting || !data.total} variant="outline" onClick={exportCsv}>
                    Exportar CSV
                  </Button>
                  <ReportActions disabled={!data.total} open={preview.open} onToggle={preview.toggle} />
                  <FinancialDocumentEmail key={data.tenantId + query} tenantId={data.tenantId} reportQuery={query} onLockChange={setEmailLocked} />
                </div>
                {exportError && <p role="alert">{exportError}</p>}
                {!data.rows.length ? (
                  <EmptyState title="Nenhum título encontrado">Confira os filtros da carteira.</EmptyState>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">Títulos do filtro</caption>
                      <thead>
                        <tr>
                          {columns.map((c) => (
                            <th key={c} className="p-2">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((row) => (
                          <tr key={row.side + row.id} className="border-t">
                            {cells(row).map((v, i) => (
                              <td className="p-2" key={i}>
                                {i === 1 ? (
                                  <Link className="text-primary underline" href={titleUrl(row)}>
                                    {v}
                                  </Link>
                                ) : (
                                  v
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="flex gap-2">
                  <Button variant="outline" disabled={emailLocked || !offset} onClick={() => setOffset(Math.max(0, offset - 30))}>
                    Anterior
                  </Button>
                  <Button variant="outline" disabled={emailLocked || offset + 30 >= data.total} onClick={() => setOffset(offset + 30)}>
                    Próxima
                  </Button>
                </div>
                {preview.open &&
                  (print.value?.tenantId === data.tenantId ? (
                    <ReportDocument
                      tenantId={data.tenantId}
                      title="Carteira financeira"
                      period={period}
                      scope={scope + " • " + print.value.total + " títulos • posição em " + dateLabel(print.value.asOf)}
                      metrics={metrics(print.value)}
                      columns={columns}
                      rows={print.value.rows.map(cells)}
                    />
                  ) : (
                    <p role="status">{print.error || "Preparando impressão…"}</p>
                  ))}
              </>
            )
          )}
        </>
      )}
    </main>
  )
}
