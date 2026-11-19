"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { EmptyState, ErrorState, LoadingState } from "@/components/workspace/resource-state"
import { useCommand, useResource } from "@/hooks/use-operation"
import { erpFetch } from "@/lib/api/client"
import { aggregateLabels, areaLabels, field, periodLabels, problem, type Definition, type EngineSource, type Period, type ReportResult, type Total } from "./engine-model"
import { ReportTable } from "./report-table"

type Catalog = { tenantId: string; data: Definition[]; engineSources: EngineSource[]; canEdit: boolean }
type Draft = { name: string; dataset: string; columns: string[]; groupBy: string[]; totals: Total[]; filters: Record<string, unknown>; visibility: "private" | "tenant" }

function draftFor(source: EngineSource): Draft {
  const filters: Record<string, unknown> = {}
  for (const [key, filter] of Object.entries(source.filters)) if (filter.kind === "period") filters[key] = { preset: "last_30_days" }
  return { name: "", dataset: source.id, columns: [...source.defaultColumns], groupBy: [], totals: [], filters, visibility: "private" }
}
/** Envia só filtros preenchidos; o período personalizado leva as duas datas. */
function cleanFilters(source: EngineSource, filters: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(filters).filter(([key, value]) => source.filters[key] && value !== "" && value !== undefined))
}

export function ReportBuilder() {
  return <Suspense fallback={<LoadingState>Carregando relatórios…</LoadingState>}><Builder /></Suspense>
}

function Builder() {
  const params = useSearchParams()
  const catalog = useResource<Catalog>("/api/erp/system/custom-reports")
  const sources = catalog.value?.engineSources ?? []
  const initial = sources.find(s => s.id === params.get("fonte")) ?? sources[0]
  const [draft, setDraft] = useState<Draft | null>(null)
  const [preview, setPreview] = useState<ReportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const save = useCommand()
  const current = draft ?? (initial ? draftFor(initial) : null)
  const source = sources.find(s => s.id === current?.dataset)
  const saved = (catalog.value?.data ?? []).filter(d => sources.some(s => s.id === d.dataset))

  if (catalog.loading && !catalog.value) return <LoadingState>Carregando relatórios…</LoadingState>
  if (catalog.error) return <ErrorState title="Relatórios indisponíveis" message={catalog.error} status={catalog.status} onRetry={catalog.reload} />

  const update = (patch: Partial<Draft>) => { setDraft({ ...current!, ...patch }); setPreview(null); setNotice("") }
  const toggle = (list: string[], value: string) => list.includes(value) ? list.filter(v => v !== value) : [...list, value]
  const body = () => ({ ...current!, name: current!.name.trim() || source!.label, filters: cleanFilters(source!, current!.filters) })

  const previewBody = () => { const { name, dataset, columns, groupBy, totals, filters } = body(); return { name, dataset, columns, groupBy, totals, filters } }
  async function runPreview() {
    if (busy || !source) return
    setBusy(true); setError("")
    try {
      const response = await erpFetch("/api/erp/reports/preview", { method: "POST", headers: { "Content-Type": "application/json", "X-Tenant-Id": catalog.value!.tenantId, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(previewBody()) })
      const value = await response.json()
      if (!response.ok) throw new Error(problem(value, "Não foi possível gerar a prévia"))
      setPreview(value.data)
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Prévia indisponível") } finally { setBusy(false) }
  }
  async function persist() {
    if (!current?.name.trim()) { setError("Dê um nome ao relatório para salvar"); return }
    const reply = await save.send<{ data: Definition }>("/api/erp/system/custom-reports", catalog.value!.tenantId, body())
    if (reply) { setNotice(`Relatório "${reply.data.name}" salvo.`); catalog.reload() }
  }

  return <div className="workspace-page-frame space-y-4">
    <PageHeader eyebrow="Relatórios" title="Relatórios configuráveis" description="Escolha a fonte, as colunas, os agrupamentos, os totais e os filtros. Salve para exportar e agendar o envio por e-mail." />
    {!sources.length && <EmptyState title="Nenhuma fonte disponível">Seu perfil não tem permissão para as fontes do motor de relatórios.</EmptyState>}
    {current && source && <section aria-labelledby="builder" className="grid gap-3 rounded-lg border p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <h2 id="builder" className="text-sm font-semibold lg:col-span-2">Montar relatório</h2>
      <label className="grid gap-1 text-xs font-medium">Fonte
        <select className={field} value={current.dataset} onChange={e => { const next = sources.find(s => s.id === e.target.value)!; setDraft(draftFor(next)); setPreview(null) }}>
          {sources.map(s => <option key={s.id} value={s.id}>{areaLabels[s.area] ?? s.area} • {s.label}</option>)}
        </select>
        <span className="font-normal text-muted-foreground">{source.description}</span>
      </label>
      <label className="grid gap-1 text-xs font-medium">Nome<input className={field} value={current.name} maxLength={120} onChange={e => update({ name: e.target.value })} placeholder={source.label} /></label>
      <fieldset className="grid gap-1 lg:col-span-2"><legend className="text-xs font-medium">Colunas</legend>
        <div className="flex flex-wrap gap-1.5">{Object.entries(source.columns).map(([key, column]) => <label key={key} className="flex h-7 items-center gap-1.5 rounded border px-2 text-xs"><input type="checkbox" checked={current.columns.includes(key)} onChange={() => update({ columns: toggle(current.columns, key) })} />{column.label}</label>)}</div>
      </fieldset>
      <fieldset className="grid gap-1"><legend className="text-xs font-medium">Agrupar por (até 2)</legend>
        <div className="flex flex-wrap gap-1.5">{Object.entries(source.columns).filter(([, c]) => c.groupable).map(([key, column]) => <label key={key} className="flex h-7 items-center gap-1.5 rounded border px-2 text-xs"><input type="checkbox" checked={current.groupBy.includes(key)} disabled={!current.groupBy.includes(key) && current.groupBy.length >= 2} onChange={() => update({ groupBy: toggle(current.groupBy, key) })} />{column.label}</label>)}</div>
      </fieldset>
      <fieldset className="grid gap-1"><legend className="text-xs font-medium">Totais</legend>
        <div className="flex flex-wrap gap-1.5">{Object.entries(source.columns).filter(([, c]) => c.aggregatable).flatMap(([key, column]) => (Object.keys(aggregateLabels) as Total["fn"][]).map(fn => {
          const on = current.totals.some(t => t.column === key && t.fn === fn)
          return <label key={key + fn} className="flex h-7 items-center gap-1.5 rounded border px-2 text-xs"><input type="checkbox" checked={on} onChange={() => update({ totals: on ? current.totals.filter(t => !(t.column === key && t.fn === fn)) : [...current.totals, { column: key, fn }] })} />{aggregateLabels[fn]} de {column.label}</label>
        }))}</div>
      </fieldset>
      <fieldset className="grid gap-2 sm:grid-cols-2 lg:col-span-2"><legend className="mb-1 text-xs font-medium">Filtros</legend>
        {Object.entries(source.filters).map(([key, filter]) => {
          const value = current.filters[key]
          const set = (next: unknown) => update({ filters: { ...current.filters, [key]: next } })
          if (filter.kind === "period") {
            const period = (value as Period | undefined) ?? { preset: "last_30_days" }
            return <div key={key} className="grid gap-1 text-xs"><span className="font-medium">{filter.label}</span><div className="flex flex-wrap gap-1.5">
              <select aria-label={filter.label} className={field} value={period.preset} onChange={e => set(e.target.value === "custom" ? { preset: "custom", from: "", to: "" } : { preset: e.target.value })}>{Object.entries(periodLabels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              {period.preset === "custom" && <><input aria-label="Início" type="date" className={field} value={period.from ?? ""} onChange={e => set({ ...period, from: e.target.value })} /><input aria-label="Fim" type="date" className={field} value={period.to ?? ""} onChange={e => set({ ...period, to: e.target.value })} /></>}
            </div><span className="text-muted-foreground">Períodos relativos acompanham a data de cada envio agendado.</span></div>
          }
          if (filter.kind === "choice") return <label key={key} className="grid gap-1 text-xs font-medium">{filter.label}<select className={field} value={String(value ?? "")} onChange={e => set(e.target.value)}><option value="">Todas</option>{Object.entries(filter.options).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          return <label key={key} className="grid gap-1 text-xs font-medium">{filter.label}<input className={field} maxLength={120} value={String(value ?? "")} onChange={e => set(e.target.value)} /></label>
        })}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2 lg:col-span-2">
        <Button size="sm" variant="outline" disabled={busy || !current.columns.length} onClick={runPreview}>{busy ? "Gerando…" : "Gerar prévia"}</Button>
        {catalog.value?.canEdit && <>
          <select aria-label="Visibilidade" className={field} value={current.visibility} onChange={e => update({ visibility: e.target.value as Draft["visibility"] })}><option value="private">Somente para mim</option><option value="tenant">Toda a empresa</option></select>
          <Button size="sm" disabled={save.busy || !current.columns.length} onClick={persist}>{save.busy ? "Salvando…" : "Salvar relatório"}</Button>
        </>}
        {(error || save.error) && <p role="alert" className="text-xs text-destructive">{error || save.error}</p>}
        {notice && <p role="status" className="text-xs">{notice}</p>}
      </div>
    </section>}
    {preview && <section aria-label="Prévia" className="space-y-2"><h2 className="text-sm font-semibold">Prévia: {preview.title}</h2><ReportTable result={preview} limit={500} /></section>}
    <section aria-labelledby="saved" className="space-y-2">
      <h2 id="saved" className="text-sm font-semibold">Relatórios salvos</h2>
      {!saved.length ? <p className="text-xs text-muted-foreground">Nenhum relatório salvo nas fontes que você pode consultar.</p> :
        <ul className="divide-y rounded-lg border">{saved.map(d => <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
          <span><strong className="font-medium">{d.name}</strong> <span className="text-xs text-muted-foreground">• {sources.find(s => s.id === d.dataset)?.label} • {d.visibility === "tenant" ? "empresa" : "privado"}</span></span>
          <Link className="text-xs font-medium text-primary underline" href={`/relatorios/configuraveis/${d.id}`}>Abrir, exportar e agendar</Link>
        </li>)}</ul>}
    </section>
  </div>
}
