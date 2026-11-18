"use client"

import { useState } from "react"
import { ReportActions, ReportDocument, useReportPreview } from "@/components/documents/report-document"
import { PageHeader } from "@/components/page-header"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LoadingState, ErrorState, EmptyState } from "@/components/workspace/resource-state"
import { Pagination } from "@/components/workspace/pagination"
import { allStockRows,downloadStockCsv } from "./stock-export"
import { GuardedLink } from "@/components/shell/navigation-guard"
import { useStockReport } from "./use-report-data"

export function StockReportLive() {
  const preview = useReportPreview()
  const [offset, setOffset] = useState(0)
  const { value: result, metrics, loading, error, status, reload } = useStockReport(offset)
  const [exporting,setExporting]=useState(false),[exportError,setExportError]=useState("")
  async function exportCsv(){
    if(!result?.tenantId||exporting)return
    setExporting(true);setExportError("")
    try{
      const report=await allStockRows(new URLSearchParams({dataset:"stock_position"}),result.tenantId)
      const keys=["sku","product","unit","quantity","reserved","available","status"]
      downloadStockCsv(report,keys.map(key=>report.columns.find(c=>c.key===key)!),"relatorio-estoque.csv")
    }catch(reason){setExportError(reason instanceof Error?reason.message:"Não foi possível exportar o estoque")}
    finally{setExporting(false)}
  }

  return <div data-report-workspace className="mx-auto max-w-[1500px] px-4 pb-24 pt-8 lg:px-6">
    <PageHeader eyebrow="Estoque" title="Relatório de estoque" description="Saldos e reservas do inventário da empresa ativa." back={{ href: "/relatorios", label: "Relatórios" }} actions={<div className="flex flex-wrap gap-2"><GuardedLink className="inline-flex min-h-11 items-center px-3 font-medium underline" href="/relatorios/estoque/analises">Análises de estoque</GuardedLink><ReportActions disabled={loading || Boolean(error) || !result?.data.length} open={preview.open} onToggle={preview.toggle} /><Button disabled={exporting || loading || Boolean(error) || !result?.data.length} variant="outline" onClick={exportCsv}><Download aria-hidden="true" />Exportar CSV</Button></div>} />
    {exportError&&<p role="alert">{exportError}</p>}
    {loading ? <LoadingState>Carregando saldos de estoque…</LoadingState> : error ? <ErrorState title="Não foi possível carregar o relatório" message={error} status={status} onRetry={reload} /> : !result?.data.length ? <EmptyState title="Nenhum saldo encontrado">Não há produtos nesta página de estoque para a empresa ativa.</EmptyState> : <>
      <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[["Produtos", String(metrics.products)], ["Saldo na página", metrics.quantity], ["Reservado na página", metrics.reserved], ["Sem disponibilidade", String(metrics.unavailable)]].map(([label, value]) => <div className="rounded-2xl border border-border bg-card p-5" key={label}><span className="text-sm text-muted-foreground">{label}</span><strong className="mt-2 block text-2xl">{value}</strong></div>)}</section>
      <section className="mt-5 overflow-hidden rounded-2xl border border-border bg-card"><div className="border-b border-border p-4"><h2 className="font-semibold">Saldos consultados</h2><p className="mt-1 text-sm text-muted-foreground">Página {Math.floor((result.offset || 0) / (result.limit || 100)) + 1} de {Math.max(1, Math.ceil(result.total / (result.limit || 100)))}</p></div><div className="divide-y divide-border">{result.data.map((item) => <article className="grid gap-2 p-4 sm:grid-cols-[120px_minmax(0,1fr)_180px] sm:items-center" key={item.productId}><strong className="text-sm text-primary">{item.sku}</strong><div><h3 className="text-sm font-medium">{item.name}</h3><p className="text-sm text-muted-foreground">Saldo {item.quantity} {item.unit} • reservado {item.reserved} • disponível {item.available}</p></div><span className="w-fit rounded-full bg-muted px-2.5 py-1 text-xs">{item.status}</span></article>)}</div><div className="border-t border-border px-4"><Pagination offset={offset} pageSize={100} total={result.total} loading={loading} onOffsetChange={setOffset} /></div></section>
    </>}
    {preview.open && !loading && !error && result && result.data.length > 0 && <ReportDocument tenantId={result.tenantId} title="Relatório de estoque" scope={`Página ${Math.floor((result.offset || 0) / (result.limit || 100)) + 1} • até 100 registros da página atual • ${result.total} produtos no cadastro. Saldos e reservas referem-se somente à página atual.`} metrics={[["Produtos no cadastro", String(metrics.products)], ["Saldo na página", metrics.quantity], ["Reservado na página", metrics.reserved], ["Sem disponibilidade na página", String(metrics.unavailable)]]} columns={["SKU", "Produto", "Unidade", "Saldo", "Reservado", "Disponível", "Situação"]} rows={result.data.map(item => [item.sku, item.name, item.unit, item.quantity, item.reserved, item.available, item.status])} />}
  </div>;
}
