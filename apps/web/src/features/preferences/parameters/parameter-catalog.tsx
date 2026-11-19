"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/page-header"
import { SearchInput } from "@/components/search-input"
import { AccessLink } from "@/components/feedback/session-recovery"
import { useCommand, useResource } from "@/hooks/use-operation"

type Parameter = {
  code: string; module: string; label: string; description: string; type: "boolean" | "integer" | "decimal" | "text" | "choice"
  defaultValue: boolean | number | string; value: boolean | number | string; customized: boolean; choices: string[]
  minimum: number | null; maximum: number | null; unit: string | null; revision: number; updatedBy: string | null; updatedAt: string | null
}
type Listing = { tenantId: string; canEdit: boolean; data: Parameter[] }

export const parameterModules: Record<string, string> = {
  platform: "Plataforma", preferences: "Preferências", registrations: "Cadastros", sales: "Vendas", inventory: "Estoque",
  purchasing: "Compras", finance: "Finanças", fiscal: "Fiscal", period_close: "Fechamento", data: "Dados",
}
const choiceLabels: Record<string, string> = { off: "Desligada", weekly: "Semanal", monthly: "Mensal" }
const formatDate = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" })
const show = (parameter: Parameter, value: Parameter["value"]) =>
  typeof value === "boolean" ? (value ? "Ligado" : "Desligado") : parameter.type === "choice" ? choiceLabels[String(value)] ?? String(value) : `${value}${parameter.unit ? ` ${parameter.unit}` : ""}`

export function ParameterCatalog() {
  const [q, setQ] = useState("")
  const [module, setModule] = useState("")
  const params = new URLSearchParams(Object.entries({ q, module }).filter(([, value]) => value))
  const resource = useResource<Listing>(`/api/erp/parameters${params.size ? `?${params}` : ""}`)
  const rows = resource.value?.data ?? []

  return <div className="mx-auto max-w-6xl space-y-4 px-4 pb-28 pt-8 lg:px-6">
    <PageHeader breadcrumbs={[{ label: "Preferências", href: "/preferencias" }, { label: "Sistema", href: "/preferencias/sistema" }, { label: "Parâmetros" }]} title="Parâmetros da empresa" description="Catálogo único dos parâmetros do ERP: valor atual desta empresa, padrão, efeito, quem alterou e quando." />
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <label className="grid min-w-0 flex-1 gap-1 sm:max-w-sm">Pesquisar<SearchInput onSearch={setQ} maxLength={120} placeholder="Nome, módulo ou efeito" defaultValue={q} className="h-9 text-sm" /></label>
      <label className="grid gap-1">Módulo<select className="h-9 rounded-lg border bg-background px-2 text-sm" value={module} onChange={event => setModule(event.target.value)}>
        <option value="">Todos</option>{Object.entries(parameterModules).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
    </div>
    {resource.loading && <p role="status" className="text-sm">Carregando parâmetros…</p>}
    {!resource.loading && resource.error && <div role="alert" className="space-y-2 text-sm"><p>{resource.status === 403 ? "Acesso não autorizado. Solicite a permissão de consulta de parâmetros a um administrador." : resource.error}</p>{resource.status === 401 ? <AccessLink /> : resource.status !== 403 && <Button variant="outline" onClick={resource.reload}>Tentar novamente</Button>}</div>}
    {resource.value && !resource.loading && (rows.length === 0 ? <p role="status" className="py-6 text-center text-sm text-muted-foreground">Nenhum parâmetro encontrado.</p> :
      <ul className="divide-y divide-border rounded-lg border" aria-label="Parâmetros">
        {rows.map(row => <ParameterRow key={`${row.code}:${row.revision}`} row={row} tenantId={resource.value!.tenantId} canEdit={resource.value!.canEdit} onSaved={resource.reload} />)}
      </ul>)}
  </div>
}

function ParameterRow({ row, tenantId, canEdit, onSaved }: { row: Parameter; tenantId: string; canEdit: boolean; onSaved: () => void }) {
  const command = useCommand()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>(String(row.value))

  async function save(value: Parameter["value"] | null) {
    const saved = await command.send<{ tenantId: string }>(`/api/erp/parameters/${row.code}`, tenantId, { value }, `"${row.revision}"`, "PUT", reply => reply.tenantId === tenantId)
    if (saved) { setEditing(false); onSaved() }
  }
  const parsed = row.type === "integer" || row.type === "decimal" ? Number(draft.replace(",", ".")) : draft

  return <li className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_16rem] sm:gap-4" data-parameter={row.code}>
    <div className="min-w-0">
      <p className="font-medium">{row.label} <span className="text-xs font-normal text-muted-foreground">· {parameterModules[row.module] ?? row.module} · <code>{row.code}</code></span></p>
      <p className="text-xs text-muted-foreground">{row.description}</p>
      <p className="text-xs text-muted-foreground">Padrão: {show(row, row.defaultValue)}{row.updatedAt && <> · Alterado por {row.updatedBy} em {formatDate.format(new Date(row.updatedAt))}</>}</p>
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
      {!editing && <><span className="font-medium" data-testid="parameter-value">{show(row, row.value)}</span>{row.customized && <span className="rounded bg-muted px-1.5 text-xs">ajustado</span>}
        {canEdit && <Button size="sm" variant="outline" onClick={() => { setDraft(String(row.value)); setEditing(true) }}>Alterar</Button>}</>}
      {editing && <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); void save(parsed) }}>
        {row.type === "boolean" ? <select aria-label={row.label} className="h-8 rounded-lg border bg-background px-2 text-sm" value={draft} onChange={event => setDraft(event.target.value)}><option value="true">Ligado</option><option value="false">Desligado</option></select>
          : row.type === "choice" ? <select aria-label={row.label} className="h-8 rounded-lg border bg-background px-2 text-sm" value={draft} onChange={event => setDraft(event.target.value)}>{row.choices.map(choice => <option key={choice} value={choice}>{choiceLabels[choice] ?? choice}</option>)}</select>
          : <input aria-label={row.label} className="h-8 w-28 rounded-lg border bg-background px-2 text-sm" inputMode={row.type === "text" ? "text" : "decimal"} value={draft} onChange={event => setDraft(event.target.value)} />}
        <Button size="sm" type="submit" disabled={command.busy}>Salvar</Button>
        {row.customized && <Button size="sm" type="button" variant="outline" disabled={command.busy} onClick={() => void save(null)}>Padrão</Button>}
        <Button size="sm" type="button" variant="outline" onClick={() => setEditing(false)}>Cancelar</Button>
      </form>}
      {command.error && <p role="alert" className="basis-full text-xs">{command.error}{command.stale && " Recarregue a página para ver o valor atual."}</p>}
    </div>
  </li>
}
