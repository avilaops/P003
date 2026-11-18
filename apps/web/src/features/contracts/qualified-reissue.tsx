"use client"

import Link from "next/link"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCommand, useResource } from "@/hooks/use-operation"

type Props = { id: string; tenantId: string; etag: string; recipients: { role: string; name: string; email: string }[]; disabled?: boolean; portalCompleted: boolean }
type Eligibility = { tenantId: string; sourceId: string; revision: string; eligible: boolean; reason: string | null; qualifiedId: string | null; policy: string }
type Person = { cpf: string; represents: boolean; cnpj: string; reference: string }
const empty: Person = { cpf: "", represents: false, cnpj: "", reference: "" }

export function QualifiedReissue({ id, tenantId, etag, recipients, disabled, portalCompleted }: Props) {
  const url = `/api/erp/commercial-contracts/${id}/qualified-reissue`
  const result = useResource<Eligibility>(url)
  const command = useCommand()
  const [expanded, setExpanded] = useState(false)
  const [people, setPeople] = useState<Record<string, Person>>({})
  const [created, setCreated] = useState("")
  const [stage, setStage] = useState("")
  const state = result.value?.tenantId === tenantId && result.value?.sourceId === id ? result.value : null
  const validRevision = state && `"${state.revision}"` === etag
  const frozen = created || state?.qualifiedId
  const change = (role: string, patch: Partial<Person>) => setPeople(current => ({ ...current, [role]: { ...(current[role] || empty), ...patch } }))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (disabled || !state?.eligible || !validRevision) return
    const participants = recipients.map(({ role }) => {
      const person = people[role] || empty
      return { role, cpf: person.cpf, ...(person.represents ? { representedCnpj: person.cnpj.replace(/[./-]/g, "").toUpperCase(), representationReference: person.reference } : {}) }
    })
    type Reply = { tenantId: string; sourceId: string; qualifiedId: string }
    const response = await command.send<Reply>(url, tenantId, { participants }, etag, "POST",
      value => value.tenantId === tenantId && value.sourceId === id && /^[0-9a-f-]{36}$/.test(value.qualifiedId))
    if (response) { setPeople({}); setCreated(response.qualifiedId); setExpanded(false) }
  }
  if (frozen) return <p><Link className="font-medium underline" href={`/servicos/contratos/${frozen}`}>Abrir a via com assinatura ICP-Brasil</Link></p>
  if (result.loading) return <p role="status">Consultando a via com e-CPF…</p>
  if (!state || result.error) return <p role="status">{result.error || "A consulta da via com e-CPF está indisponível."}</p>
  if (state.policy === "icp_each_participant") return <div className="space-y-3">
    <p>Esta via exige o e-CPF de cada participante em todos os PDFs.</p>
    {!portalCompleted ? <p>Conclua os convites no portal e atualize o andamento para preparar a etapa ICP-Brasil.</p> : <>
      <Button variant="outline" disabled={disabled || command.busy} onClick={async () => {
        const response = await command.send<{phase:string;currentParticipant:number}>(`/api/erp/commercial-contracts/${id}/prepare-signatures`,
          tenantId,{},etag,"POST",s => ["completed","personal_signing"].includes(s.phase))
        if (response) setStage(response.phase === "completed" ? "Todos os participantes concluíram as assinaturas com e-CPF." : "PDFs disponíveis para o participante " + response.currentParticipant + ".")
      }}>{command.busy ? "Conferindo PDFs…" : "Preparar ou conferir assinaturas com e-CPF"}</Button>
      <p><a className="font-medium underline" href={`https://contrato.avilaops.com/icp/${tenantId}/${id}`}>Etapa ICP-Brasil no portal de contratos</a></p>
      {stage && <p role="status">{stage}</p>}{command.error && <p role="alert">{command.error}</p>}
    </>}
  </div>
  if (!state.eligible) return <p role="status">{state.reason}</p>
  if (!expanded) return <Button type="button" variant="outline" disabled={disabled || !validRevision} onClick={() => setExpanded(true)}>Preparar via com e-CPF</Button>
  return <form className="space-y-4 border-t pt-4" onSubmit={submit}>
    <h3 className="font-semibold">Participantes da nova via</h3>
    <p>Confira quem assinará com e-CPF. Os dados serão fixados antes de gerar a prévia da nova via no portal.</p>
    <fieldset className="space-y-4" disabled={disabled || command.busy || command.uncertain || command.stale}>
      {recipients.map(r => {
        const person = people[r.role] || empty
        return <fieldset key={r.role} className="space-y-3 rounded-xl border p-3">
          <legend className="px-1 font-medium">{r.role} • {r.name}</legend>
          <p>{r.email}</p>
          <label className="block space-y-1">CPF do titular<Input inputMode="numeric" required maxLength={14} autoComplete="off"
            value={person.cpf} onChange={event => change(r.role, { cpf: event.target.value })} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={person.represents} onChange={event => change(r.role, { represents: event.target.checked })} />Representa uma empresa</label>
          {person.represents && <>
            <label className="block space-y-1">CNPJ da empresa representada<Input required maxLength={18} value={person.cnpj} onChange={event => change(r.role, { cnpj: event.target.value })} /></label>
            <label className="block space-y-1">Referência da procuração ou dos poderes de representação<Input required maxLength={2000} value={person.reference} onChange={event => change(r.role, { reference: event.target.value })} /></label>
          </>}
        </fieldset>
      })}
    </fieldset>
    {command.error && <p role="alert">{command.error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={disabled || !validRevision || command.busy || command.stale}>{command.uncertain ? "Conferir a mesma solicitação" : "Fixar participantes e gerar nova via"}</Button>
      <Button type="button" variant="outline" disabled={command.busy || command.uncertain} onClick={() => { setPeople({}); setExpanded(false); command.reset() }}>Voltar</Button>
    </div>
  </form>
}
