"use client"

import { useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { RequestError } from "@/components/feedback/session-recovery"
import { useCommand, useResource } from "@/hooks/use-operation"
import { GuardedLink as Link, useNavigationGuard } from "@/components/shell/navigation-guard"
import { RegistryLookup } from "@/features/records/registry-lookup"
import { Lookup, type Choice } from "./orders"
import { inputAmount, parseAmount } from "./negotiation-types"
import { listNavigationHref } from "@/lib/list-navigation"
import { PipelineActivities, type Activity } from "./pipeline-activities"
import { defaultStages, type StageOption, type SalesMember, type PipelineStage } from "./opportunity-pipeline-model"
export { SalesPipeline } from "./sales-pipeline"
export { pipelineStages } from "./opportunity-pipeline-model"

type Stage = PipelineStage
type History={at:string;stage:string;label?:string|null;reason?:string|null}
export type Opportunity = { id: string; revision: number; title: string; estimatedCents: number; stage: Stage; customerId: string | null; customerName: string | null; companyName: string; companyTaxId: string; contactName: string; phone: string; email: string; source: string; notes: string; ownerId?:string|null; lossReason?:string; orderId: string | null; proposalId: string | null }
type Snapshot = { tenantId: string; canEdit: boolean; data: Opportunity }
export function OpportunityEditor({ id }: { id?: string }) {
  const result = useResource<{ tenantId: string; canEdit: boolean; data: Opportunity | Opportunity[]; stages?:StageOption[]; members?:SalesMember[]; activities?:Activity[]; history?:History[]; canCreateProposal?:boolean }>(id ? `/api/erp/opportunities/${id}` : "/api/erp/opportunities?limit=1")
  return <main className="mx-auto max-w-4xl space-y-5 px-4 pb-24 pt-6 [--workspace-control-height:44px] sm:[--workspace-control-height:36px]"><PageHeader eyebrow="Vendas • Funil" title={id ? "Oportunidade comercial" : "Nova oportunidade"} description="Mantenha empresa, contato e contexto comercial até a criação do pedido." /><Link className="inline-flex min-h-9 items-center text-primary underline" href="/vendas/funil">Voltar ao funil</Link>{result.loading ? <p role="status">Carregando oportunidade e permissões…</p> : result.error ? <p role="alert"><RequestError message={result.error} status={result.status} /></p> : result.value && <OpportunityForm key={`${result.value.tenantId}:${result.etag}`} history={result.value.history??[]} stages={result.value.stages??defaultStages} members={result.value.members??[]} activities={result.value.activities??[]} canCreateProposal={Boolean(result.value.canCreateProposal)} tenant={result.value.tenantId} canEdit={result.value.canEdit} initial={id && !Array.isArray(result.value.data) ? result.value.data : undefined} etag={result.etag} onSaved={result.reload} />}</main>
}
function OpportunityForm({ initial, etag, tenant, canEdit, onSaved, stages, members, activities, canCreateProposal, history }: { history:History[]; stages:StageOption[]; members:SalesMember[]; activities:Activity[]; canCreateProposal:boolean; initial?: Opportunity; etag: string; tenant: string; canEdit: boolean; onSaved: () => void }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const command = useCommand()
  const [draft, setDraft] = useState(() => ({ title: initial?.title || "", estimated: initial ? inputAmount(initial.estimatedCents) : "0,00", stage: initial?.stage || "new", companyName: initial?.companyName || "", companyTaxId: initial?.companyTaxId || "", contactName: initial?.contactName || "", phone: initial?.phone || "", email: initial?.email || "", source: initial?.source || "", notes: initial?.notes || "", ownerId: initial?.ownerId||"", lossReason:initial?.lossReason||"" }))
  const [customer, setCustomer] = useState<Choice | null>(initial?.customerId ? { id: initial.customerId, legalName: initial.customerName || "Cliente selecionado" } : null)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState("")
  const disabled = !canEdit || command.busy || command.uncertain || command.stale
  useNavigationGuard(dirty || command.uncertain ? "Sair sem confirmar esta oportunidade?" : null)
  function change(patch: Partial<typeof draft>) { setDraft({ ...draft, ...patch }); setDirty(true) }
  async function save() {
    setError("")
    const estimatedCents = parseAmount(draft.estimated)
    if (estimatedCents === null) { setError("Informe um valor estimado válido."); return }
    const body = { title: draft.title, stage: draft.stage, companyName: draft.companyName, companyTaxId: draft.companyTaxId, contactName: draft.contactName, phone: draft.phone, email: draft.email, source: draft.source, notes: draft.notes, ownerId:draft.ownerId||null, lossReason:draft.stage==="lost"?draft.lossReason:"", estimatedCents, customerId: customer?.id || null }
    const saved = await command.send<Snapshot>(initial ? `/api/erp/opportunities/${initial.id}` : "/api/erp/opportunities", tenant, body, initial ? etag : "", initial ? "PUT" : "POST")
    if (saved?.tenantId === tenant) { setDirty(false); if (initial) onSaved(); else router.replace(listNavigationHref(`/vendas/funil/${saved.data.id}`, pathname, params.toString())) }
  }
  return <div className="space-y-5">
    {initial?.proposalId && <Link className="block text-primary underline" href={"/vendas/propostas/"+initial.proposalId}>Abrir proposta vinculada</Link>}
    {initial && !initial.proposalId && !initial.orderId && canEdit && canCreateProposal && !["won","lost"].includes(initial.stage) && <Link className="inline-flex min-h-9 items-center rounded-lg border px-4 text-primary" href={"/vendas/propostas/novo?oportunidade="+initial.id}>Criar proposta da oportunidade</Link>}
    {initial?.orderId && <Link className="text-primary underline" href={`/vendas/pedidos/${initial.orderId}`}>Abrir pedido vinculado</Link>}{initial && !initial.orderId && !initial.proposalId && canEdit && !["lost","won"].includes(initial.stage) && <Link className="inline-flex min-h-9 items-center rounded-lg border px-4 text-primary" href={`/vendas/simulador?oportunidade=${initial.id}`}>Avançar para simulação e pedido</Link>}
    <form className="rounded-lg border bg-card p-4 text-sm space-y-4" onSubmit={event => { event.preventDefault(); void save() }}><fieldset disabled={disabled} className="min-w-0 space-y-3">
      <label className="grid gap-1.5 text-xs font-medium">CNPJ da empresa (opcional)<Input className="h-9 text-sm" maxLength={18} value={draft.companyTaxId} onChange={e => change({ companyTaxId: e.target.value })} /></label>
      <RegistryLookup kind="cnpj" context="party" tenantId={tenant} readValue={() => draft.companyTaxId} disabled={disabled} onApply={fields => { if (draft.companyName || !fields.legalName) return 0; change({ companyName: fields.legalName }); return 1 }} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{([["title", "O que está sendo vendido", 200], ["estimated", "Valor estimado (R$)", 16], ["companyName", "Empresa, se ainda não é cliente", 200], ["contactName", "Pessoa de contato", 200], ["phone", "Telefone ou WhatsApp", 40], ["email", "E-mail", 254], ["source", "De onde veio", 200]] as const).map(([key, label, max]) => <label key={key} className="grid gap-1.5 text-xs font-medium">{label}<Input className="h-9 text-sm" required={key === "title" || key === "companyName" && !customer} type={key === "email" ? "email" : "text"} inputMode={key === "estimated" ? "decimal" : "text"} maxLength={max} value={draft[key]} onChange={e => change({ [key]: e.target.value })} /></label>)}</div>
      <Lookup endpoint="parties" label="cliente" searchOnly selectedName={customer?.legalName} disabled={disabled || Boolean(initial?.orderId || initial?.proposalId)} choose={value => { setCustomer(value); setDirty(true) }} />{!customer && <p className="text-xs text-muted-foreground">Cliente ainda não vinculado.</p>}{customer && !initial?.orderId && !initial?.proposalId && <Button variant="outline" type="button" onClick={() => { setCustomer(null); setDirty(true) }}>Usar empresa sem cadastro definitivo</Button>}
      <label className="grid gap-1.5 text-xs font-medium">Etapa<select className="h-9 rounded-lg border bg-background px-3 text-sm font-normal" value={draft.stage} onChange={e => change({ stage: e.target.value as Stage })}>{stages.filter(s=>s.active || s.code===draft.stage).map(s=><option key={s.code} value={s.code}>{s.label}</option>)}</select></label>
      <label className="grid gap-1.5 text-xs font-medium">Responsável<select className="h-9 rounded-lg border bg-background px-2" value={draft.ownerId} onChange={e=>change({ownerId:e.target.value})}><option value="">Sem responsável</option>{draft.ownerId && !members.some(m=>m.id===draft.ownerId) && <option value={draft.ownerId}>Responsável arquivado</option>}{members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      {draft.stage==="lost" && <label className="grid gap-1.5 text-xs font-medium">Motivo da perda<Input required maxLength={500} value={draft.lossReason} onChange={e=>change({lossReason:e.target.value})}/></label>}
      <label className="grid gap-1.5 text-xs font-medium">Observações<textarea className="min-h-20 rounded-lg border bg-background px-3 py-2 text-sm font-normal" maxLength={5000} value={draft.notes} onChange={e => change({ notes: e.target.value })} /></label>
    </fieldset>{(error || command.error) && <p role="alert"><RequestError message={error || command.error} status={command.status || undefined} /></p>}<Button type="submit" disabled={!canEdit || command.busy || command.stale || !dirty}>{command.uncertain ? "Conferir gravação com o mesmo comando" : initial ? "Salvar oportunidade" : "Criar oportunidade"}</Button>{command.stale && <p>Outra pessoa alterou a oportunidade. Sua edição foi preservada; confira o registro antes de continuar.</p>}</form>
    {initial && history.length>0 && <details className="rounded-lg border p-3"><summary className="cursor-pointer font-semibold">Histórico de etapas</summary><ol className="mt-2 space-y-1 text-sm">{history.map((h,i)=><li key={i}>{new Date(h.at).toLocaleString("pt-BR",{timeZone:"America/Sao_Paulo"})} • {h.label || stages.find(s=>s.code===h.stage)?.label || h.stage}{h.reason?" • "+h.reason:""}</li>)}</ol></details>}
    {initial && <PipelineActivities id={initial.id} tenant={tenant} canEdit={canEdit && !dirty} members={members} activities={activities} etag={etag} reload={onSaved}/>}
  </div>
}
