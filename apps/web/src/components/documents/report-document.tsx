"use client"

import { useState } from "react"
import { Printer } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useResource } from "@/hooks/use-operation"
import { RequestError } from "@/components/feedback/session-recovery"
import { CommercialDocument, DocumentSection, type DocumentIssuer } from "./commercial-document"
import "./report-document.css"

type ReportProps = {
  title: string
  tenantId?: string
  scope: string
  period?: string
  metrics: string[][]
  columns?: string[]
  rows?: string[][]
  note?: string
}

export function useReportPreview() {
  const [open, setOpen] = useState(false)
  return { open, toggle: () => setOpen(value => !value) }
}

export function ReportActions({ disabled, open, onToggle }: { disabled: boolean; open: boolean; onToggle: () => void }) {
  return <Button variant="outline" disabled={disabled} aria-expanded={open} onClick={onToggle}><Printer aria-hidden="true" />{open ? "Fechar visualização" : "Visualizar impressão/PDF"}</Button>
}

/** Loaded only while previewing • issuer must match the authenticated active company. */
export function ReportDocument({ title, tenantId, scope, period = "Posição atual • sem filtro de período", metrics, columns = [], rows = [], note }: ReportProps) {
  const me = useResource<{ tenant: { id: string } }>("/api/erp/me")
  const company = useResource<{ tenantId: string; data: DocumentIssuer }>("/api/erp/company")
  const loading = me.loading || company.loading
  const error = me.error || company.error
  const issuer = !loading && !error && Boolean(tenantId) && tenantId === me.value?.tenant?.id && company.value?.tenantId === tenantId && company.value?.data.legalName ? company.value.data : null
  return <section data-report-preview aria-label="Visualização do relatório" className="mt-6">
    <div className="report-document-controls flex flex-wrap items-center gap-3"><Button disabled={!issuer} variant="outline" onClick={() => window.print()}><Printer aria-hidden="true" />Imprimir / salvar PDF</Button><p className="text-sm text-muted-foreground">Use o destino Salvar como PDF na impressão do navegador.</p></div>
    {loading ? <p role="status">Carregando emitente da empresa ativa…</p> : !issuer ? <div role="alert"><RequestError message={error || "O emitente não corresponde à empresa ativa ou não possui razão social cadastrada."} status={me.error ? me.status : company.status} /><Button variant="outline" onClick={() => { me.reload(); company.reload() }}>Consultar emitente novamente</Button></div> : <CommercialDocument title={title} identity="Relatório operacional" issuer={issuer} data-report-document>
      <DocumentSection title="Referência da consulta"><p>Emitido em {new Date().toLocaleString("pt-BR")}</p><p>{period}</p><p>{scope}</p>{note && <p>{note}</p>}</DocumentSection>
      <DocumentSection title="Indicadores"><dl className="report-document-metrics">{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></DocumentSection>
      {!!columns.length && <DocumentSection title="Registros incluídos"><table className="commercial-document-table"><thead><tr>{columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}>{value}</td>)}</tr>)}</tbody></table>{!rows.length && <p>Nenhum registro nesta consulta.</p>}</DocumentSection>}
    </CommercialDocument>}
  </section>
}
