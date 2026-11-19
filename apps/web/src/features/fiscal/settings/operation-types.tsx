"use client"
import { PageTitle } from "@/components/workspace/page-title"

import { useEffect, useState } from "react"
import { DataTable } from "@/components/workspace/data-table"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { erpFetch } from "@/lib/api/client"

type Type = {
  id: string; revision: number | string; code: string; name: string; direction: "incoming" | "outgoing"; purpose: string; nfePurpose: number
  cfopInternal: string | null; cfopInterstate: string | null; cfopForeign: string | null; icmsCst: string | null; icmsCsosn: string | null; ipiCst: string | null
  pisCst: string | null; cofinsCst: string | null; ibsCbsCst: string | null; ibsCbsClass: string | null; movesStock: boolean; generatesFinance: boolean
  generatesCommission: boolean; requiresOrigin: boolean; financialCategoryId: string | null; isDefault: boolean; active: boolean; complete: boolean; missing: string[]
}
type Snapshot = { tenantId: string; canEdit: boolean; data: Type[] }
type Form = Omit<Type, "id" | "revision" | "complete" | "missing"> & { id?: string; revision?: number | string }
const purposes: Record<string, string> = { sale_own_production: "Venda de produção própria", resale: "Revenda", repair_shipment: "Remessa para conserto", return: "Devolução", bonus: "Bonificação", other: "Outra" }
const empty: Form = { code: "", name: "", direction: "outgoing", purpose: "sale_own_production", nfePurpose: 1, cfopInternal: null, cfopInterstate: null, cfopForeign: null, icmsCst: null, icmsCsosn: null,
  ipiCst: null, pisCst: null, cofinsCst: null, ibsCbsCst: null, ibsCbsClass: null, movesStock: true, generatesFinance: true, generatesCommission: true, requiresOrigin: false,
  financialCategoryId: null, isDefault: false, active: true }
const field = "h-8 text-sm"
const nullable = (value: string) => value.trim() === "" ? null : value.trim()

export function OperationTypes() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    erpFetch("/api/erp/fiscal/operation-types", { cache: "no-store", signal: controller.signal }).then(async response => {
      const value = await response.json() as Snapshot & { title?: string }
      if (!response.ok) throw new Error(value.title || "Não foi possível consultar os tipos de operação")
      if (!controller.signal.aborted) { setSnapshot(value); setError("") }
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
    return () => controller.abort()
  }, [reload])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!form || !snapshot || saving) return
    setSaving(true); setError(""); setNotice("")
    const { id, revision, ...body } = form
    try {
      const response = await erpFetch(id ? `/api/erp/fiscal/operation-types/${id}` : "/api/erp/fiscal/operation-types", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", "X-Tenant-Id": snapshot.tenantId, ...(id ? { "If-Match": `"${revision}"` } : { "Idempotency-Key": crypto.randomUUID() }) },
        body: JSON.stringify(body),
      })
      const value = await response.json() as { title?: string }
      if (!response.ok) throw new Error(value.title || "Não foi possível salvar o tipo de operação")
      setNotice("Tipo de operação salvo."); setForm(null); setReload(count => count + 1)
    } catch (reason) { setError((reason as Error).message) } finally { setSaving(false) }
  }
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm(current => current && { ...current, [key]: value })
  const text = (key: keyof Form, label: string, width = "w-24", max = 6) => (
    <label className="text-xs">{label}<Input className={`${field} ${width}`} maxLength={max} value={String(form?.[key] ?? "")} onChange={event => set(key, nullable(event.target.value) as never)} /></label>
  )
  const check = (key: "movesStock" | "generatesFinance" | "generatesCommission" | "requiresOrigin" | "isDefault" | "active", label: string) => (
    <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={!!form?.[key]} onChange={event => set(key, event.target.checked)} />{label}</label>
  )

  return (
    <main className="space-y-4 text-sm">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
        <div><p className="text-xs text-primary">Preferências / Fiscal</p><PageTitle className="text-xl font-semibold">Tipos de operação</PageTitle>
          <p className="text-muted-foreground">Definem CFOP, tributos e se a operação movimenta estoque, gera título ou comissão. Tipo incompleto bloqueia a transmissão da NF-e.</p></div>
        {snapshot?.canEdit && !form && <Button size="sm" onClick={() => setForm({ ...empty })}>Novo tipo</Button>}
      </header>
      {error && <p role="alert" className="rounded border border-destructive p-2 text-destructive">{error}</p>}
      {notice && <p role="status" className="rounded border p-2">{notice}</p>}
      {form && (
        <form onSubmit={save} className="space-y-3 rounded-lg border p-3" aria-label="Tipo de operação">
          <div className="flex flex-wrap items-end gap-2">
            {text("code", "Código", "w-36", 30)}{text("name", "Descrição", "w-64", 60)}
            <label className="text-xs">Sentido<select aria-label="Sentido" className="h-8 rounded border bg-background px-2 text-sm" value={form.direction} disabled={!!form.id} onChange={event => set("direction", event.target.value as Form["direction"])}><option value="outgoing">Saída</option><option value="incoming">Entrada</option></select></label>
            <label className="text-xs">Finalidade<select aria-label="Finalidade" className="h-8 rounded border bg-background px-2 text-sm" value={form.purpose} onChange={event => { set("purpose", event.target.value); if (event.target.value === "return") setForm(c => c && { ...c, purpose: "return", nfePurpose: 4, requiresOrigin: true }) }}>{Object.entries(purposes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            {text("cfopInternal", "CFOP no estado", "w-24", 4)}{text("cfopInterstate", "CFOP fora do estado", "w-24", 4)}{text("cfopForeign", "CFOP exterior", "w-24", 4)}
            {text("icmsCst", "CST ICMS", "w-16", 2)}{text("icmsCsosn", "CSOSN", "w-16", 3)}{text("ipiCst", "CST IPI", "w-16", 2)}{text("pisCst", "CST PIS", "w-16", 2)}{text("cofinsCst", "CST COFINS", "w-16", 2)}
            {text("ibsCbsCst", "CST IBS/CBS", "w-20", 3)}{text("ibsCbsClass", "Classif. IBS/CBS", "w-24", 6)}
          </div>
          <div className="flex flex-wrap gap-4">{check("movesStock", "Movimenta estoque")}{check("generatesFinance", "Gera financeiro")}{check("generatesCommission", "Gera comissão")}{check("requiresOrigin", "Exige nota de origem")}{check("isDefault", "Padrão da finalidade")}{check("active", "Ativo")}</div>
          <div className="flex gap-2"><Button size="sm" type="submit" disabled={saving}>{saving ? "Salvando…" : "Salvar"}</Button><Button size="sm" type="button" variant="outline" onClick={() => setForm(null)}>Cancelar</Button></div>
        </form>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <DataTable>
          <thead className="bg-muted/50 text-left text-xs"><tr><th className="p-2">Código</th><th className="p-2">Descrição</th><th className="p-2">Sentido</th><th className="p-2">CFOP</th><th className="p-2">Estoque</th><th className="p-2">Financeiro</th><th className="p-2">Situação</th><th className="p-2" /></tr></thead>
          <tbody>
            {snapshot?.data.map(type => (
              <tr key={type.id} className="border-t">
                <td className="p-2 font-medium">{type.code}{type.isDefault && <span className="ml-1 text-xs text-muted-foreground">(padrão)</span>}</td><td className="p-2">{type.name}</td>
                <td className="p-2">{type.direction === "outgoing" ? "Saída" : "Entrada"}</td><td className="p-2">{[type.cfopInternal, type.cfopInterstate, type.cfopForeign].filter(Boolean).join(" / ") || "—"}</td>
                <td className="p-2">{type.movesStock ? "Sim" : "Não"}</td><td className="p-2">{type.generatesFinance ? "Sim" : "Não"}</td>
                <td className="p-2">{!type.active ? "Inativo" : type.complete ? "Completo" : <span title={type.missing.join(", ")} className="text-destructive">Incompleto: {type.missing.join(", ")}</span>}</td>
                <td className="p-2 text-right">{snapshot.canEdit && <Button size="sm" variant="outline" onClick={() => setForm({ ...type })}>Editar</Button>}</td>
              </tr>
            ))}
            {snapshot && !snapshot.data.length && <tr><td className="p-3 text-muted-foreground" colSpan={8}>Nenhum tipo de operação cadastrado.</td></tr>}
          </tbody>
        </DataTable>
      </div>
    </main>
  )
}
