"use client"

import { useState } from "react"
import Link from "next/link"
import { PageHeader } from "@/components/page-header"
import { RequestError } from "@/components/feedback/session-recovery"
import { DataTable } from "@/components/workspace/data-table"
import { useResource } from "@/hooks/use-operation"

// Registration gaps that only a person can fill: nothing here is estimated or deduced.
export const pendingFieldLabels = {
  catalogSheet: "Ficha técnica", manufacturer: "Fabricante", manufacturerModel: "Modelo do fabricante", description: "Descrição",
  liveArea: "Área de uso", weight: "Peso", dimensions: "Dimensões", photo: "Foto", ncm: "NCM",
} as const
export type PendingField = keyof typeof pendingFieldLabels
type PendingProduct = { id: string; sku: string; name: string; missing: PendingField[] }
type Snapshot = { tenantId: string; canEdit: boolean; activeProducts: number; data: PendingProduct[]; totals: Record<PendingField, number> }

export function pendingProducts(data: PendingProduct[], field: PendingField | "") {
  return field ? data.filter(product => product.missing.includes(field)) : data
}

export function CatalogPending() {
  const resource = useResource<Snapshot>("/api/erp/products/catalog-pending")
  const [field, setField] = useState<PendingField | "">("")
  const snapshot = resource.value
  const rows = snapshot ? pendingProducts(snapshot.data, field) : []
  return <main className="mx-auto max-w-5xl space-y-5 px-4 pb-24 pt-6">
    <PageHeader breadcrumbs={[{ label: "Cadastros" }, { label: "Produtos", href: "/cadastros/produtos" }, { label: "Pendências de cadastro" }]} title="Pendências de cadastro"
      description="Produtos ativos com campos vazios. O ERP não preenche esses dados sozinho: abra o produto e informe o que falta." />
    {resource.loading ? <p role="status">Carregando pendências…</p> : resource.error ? <p role="alert"><RequestError message={resource.error} status={resource.status} /></p> : snapshot && <>
      <p>{snapshot.data.length === 0 ? `Nenhuma pendência entre os ${snapshot.activeProducts} produtos ativos.` : `${snapshot.data.length} de ${snapshot.activeProducts} produtos ativos têm campos para preencher.`}</p>
      {snapshot.data.length > 0 && <label className="grid max-w-sm gap-1">Mostrar produtos sem
        <select className="min-h-10 rounded-lg border bg-background px-2" value={field} onChange={event => setField(event.target.value as PendingField | "")}>
          <option value="">Qualquer campo</option>
          {(Object.keys(pendingFieldLabels) as PendingField[]).filter(key => snapshot.totals[key] > 0).map(key => <option key={key} value={key}>{pendingFieldLabels[key]} ({snapshot.totals[key]})</option>)}
        </select>
      </label>}
      {rows.length > 0 && <div className="overflow-x-auto" role="region" aria-label="Produtos com pendências" tabIndex={0}><DataTable aria-label="Pendências de cadastro" className="w-full text-left text-sm">
        <thead><tr className="border-b"><th scope="col" className="py-2 pr-3">SKU</th><th scope="col" className="py-2 pr-3">Produto</th><th scope="col" className="py-2">Falta preencher</th></tr></thead>
        <tbody>{rows.map(product => <tr key={product.id} className="border-b align-top">
          <td className="py-2 pr-3 font-mono">{product.sku}</td>
          <td className="py-2 pr-3 [overflow-wrap:anywhere]"><Link className="text-primary underline" href={`/cadastros/produtos/${product.id}`}>{product.name}</Link></td>
          <td className="py-2">{product.missing.map(key => pendingFieldLabels[key]).join(", ")}</td>
        </tr>)}</tbody>
      </DataTable></div>}
    </>}
  </main>
}
