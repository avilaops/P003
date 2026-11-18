"use client"
import { PageTitle } from "@/components/workspace/page-title"
import {OrderSerials} from "@/features/inventory/order-serials"

import { erpFetch } from "@/lib/api/client"

import type { Schema } from "@/lib/api/types"

import Link from "next/link"
import { decimalMicros, type OrderLots, type LotEnvironment } from "./order-lots-model"
import { withModelReadiness } from "./model-readiness"
import { useRouter } from "next/navigation"
import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type ReactElement } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TaxProfilePicker } from "./settings/tax-profile-picker"
import { OperationNaturePicker } from "./settings/operation-nature-picker"
import { NfeProductPicker, type NfePickerProduct } from "./nfe-product-picker"
import { certificateMessage } from "./outgoing-nfe-model"
import { NfeTaxItemsTable } from "./nfe-tax-items-table"
import { amountFields, reallocateAmounts, type AllocationRules } from "./nfe-amount-allocation"
import { NfeFooterTotals } from "./nfe-footer-totals"
import { NfeReview } from "./nfe-review"
import { NfeGlobalAmounts } from "./nfe-global-amounts"
import { NfeItemsTable } from "./nfe-items-table"
import { NfeTransportFields, NfeRetentionsFields, NfeInstallmentsFields, NfeAdditionalFields, NfeAmountsSummary } from "./nfe-extras-fields"
import { NfeIdentificationFields } from "./nfe-identification-fields"
import { NfeExportFields, NfeForeignRecipientFields } from "./nfe-export-fields"
import { NfeFinancialFields, hasHeaderFiscalReference } from "./nfe-financial-fields"
import { NfeRecipientPicker, NfeMunicipalityLookup } from "./nfe-recipient-picker"
import { applyMunicipalityCode } from "@/lib/municipality-code"
import { EmissionActions } from "./emission-actions"
import { applyRecipientFiscal, applyTaxProfile, blankDraft, blankIbptItem, blankItem, blankTaxDeclaration, blockerLabels, invoiceTotal, itemTotal, productsTotal, submission, type DraftInput, type DraftItem, type FiscalReadiness, type TaxDeclaration } from "./nfe-draft-model"
import { IbptDraftFields, IbptSavedSnapshot } from "./ibpt-draft-fields"

type Snapshot = Schema<"DraftSnapshot">
type Preparation = Schema<"OrderPreparation">
const editorSteps = ["Dados da nota", "Destinatário", "Produtos", "Tributação", "Pagamento", "Revisão e emissão"]
const stepDescriptions = ["Defina a operação, o modelo e o ambiente da nota.", "Selecione o cliente e confira o endereço de entrega fiscal.", "Inclua os produtos, as quantidades, os preços e o frete.", "Confira os códigos fiscais de cada item e os tributos da operação.", "Informe como o valor da nota será pago.", "Confira os dados, salve o rascunho e acompanhe a emissão."]
/** A complete recipient starts as a summary; an incomplete one keeps its fields open until the user closes them. */
const recipientComplete = (recipient: DraftInput["recipient"]) => !!recipient.taxId && !!recipient.legalName && !!recipient.street && !!recipient.postalCode && !!recipient.municipalityCode && !!recipient.state
const states = "AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" ")

export function NfeDraftEditor({ id, sourceOrderId, lotId, lotEnvironment="production", initialModel = 55 }: { id?: string; sourceOrderId?: string; lotId?:string; lotEnvironment?:LotEnvironment; initialModel?: 55 | 65 }) {
  const router = useRouter()
  const [issuerProfile, setIssuerProfile] = useState<Schema<"ProfileInput"> | null>(null)
  const [emissionHeader, setEmissionHeader] = useState<{ number: number; series: number } | null>(null)

  const [step, setStep] = useState(id ? editorSteps.length - 1 : 0)
  const [rawDraft, setDraft] = useState<DraftInput>(blankDraft)
  const [baseline, setBaseline] = useState("")
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [preparation, setPreparation] = useState<Preparation | null>(null)
  const [readiness, setReadiness] = useState<FiscalReadiness | null>(null)
  const [certificateStatus, setCertificateStatus] = useState<string>()
  const [tenant, setTenant] = useState("")
  const [etag, setEtag] = useState("")
  const [canEdit, setCanEdit] = useState(false)
  const [canIssue, setCanIssue] = useState(false)
  const [canCancel, setCanCancel] = useState(false)
  const [canCorrect, setCanCorrect] = useState(false)
  const [fiscalLocked, setFiscalLocked] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [pendingAmounts, setPendingAmounts] = useState(false)
  const [recipientExpanded, setRecipientExpanded] = useState(false)
  const [allocationRules, setAllocationRules] = useState<AllocationRules>({})
  const { draft, allocationError } = useMemo(() => {
    try { return { draft: { ...rawDraft, items: reallocateAmounts(rawDraft.items, allocationRules) }, allocationError: "" } }
    catch (reason) { return { draft: rawDraft, allocationError: reason instanceof Error ? reason.message : "Confira o rateio dos valores." } }
  }, [rawDraft, allocationRules])
  const [uncertain, setUncertain] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [canSearch, setCanSearch] = useState(false)
  const [canSearchParties, setCanSearchParties] = useState(false)
  const [reload, setReload] = useState(0)
  const command = useRef<{ key: string; body: string } | null>(null)
  const writing = useRef(false)
  const request = useRef<AbortController | null>(null)
  const dirty = pendingAmounts || baseline !== "" && baseline !== JSON.stringify(draft)

  useEffect(() => {
    const controller = new AbortController()
    const read = async () => {
      try {
        const paths = ["/api/erp/me", "/api/erp/fiscal/readiness", ...(id ? [`/api/erp/fiscal/nfe/${id}`] : sourceOrderId ? [`/api/erp/fiscal/order-preparations/${sourceOrderId}`] : [])]
        if (sourceOrderId && lotId) paths.push(`/api/erp/fiscal/order-lots/${sourceOrderId}?environment=${lotEnvironment}`)
        const responses = await Promise.all(paths.map(path => erpFetch(path, { cache: "no-store", signal: controller.signal })))
        const values = await Promise.all(responses.map(response => response.json()))
        for (const [index, response] of responses.entries()) if (!response.ok) throw new Error(values[index].title || "Não foi possível abrir o rascunho")
        if (controller.signal.aborted) return
        const [me, ready, origin] = values
        const current: Snapshot | undefined = id ? origin : undefined
        const proposed: Preparation | undefined = !id && sourceOrderId ? origin : undefined
        if (ready.tenantId !== me.tenant?.id || origin && origin.tenantId !== me.tenant.id) throw new Error("A empresa da sessão mudou. Reabra o rascunho")
        const input: DraftInput = current ? {...current.data.input} : proposed ? { ...blankDraft(), model: initialModel, sourceOrderId: proposed.orderId, recipient: proposed.recipient, items: proposed.items.map(item => ({ ...blankItem(), code: item.code, description: item.description, additionalInfo: item.additionalInfo || null, unit: item.unit, ncm: item.ncm || "", quantity: item.quantity, unitPrice: item.unitPrice, grossTotal: item.grossTotal })), productsTotal: proposed.productsTotal } : { ...blankDraft(), model: initialModel }
        if (!current) { input.environment = ready.environment; input.issuedAt = new Date().toISOString(); if (initialModel === 55) input.departureAt = input.issuedAt; input.presenceIndicator = initialModel === 65 ? 1 : 9 }
        if (lotId && id) {
          const allocation:OrderLots=values[3]
          const lot=allocation?.lots.find(l=>l.id===lotId && l.draftId===id)
          if (!lot || allocation.tenantId!==me.tenant.id || allocation.orderId!==sourceOrderId) throw new Error("O vínculo da nota com o lote mudou. Consulte o pedido.")
          input.sourceOrderId=allocation.orderId
        }
        if (lotId && !id) {
          const allocation: OrderLots = values[3]
          const lot = allocation?.lots.find(l=>l.id===lotId)
          if (!proposed || allocation?.tenantId!==me.tenant.id || allocation.orderId!==sourceOrderId || !lot || lot.status!=="reserved" || lot.environment!==lotEnvironment) throw new Error("O lote mudou. Volte ao pedido para consultar o saldo.")
          input.model=55
          input.environment=lot.environment
          input.items=lot.items.map(line=>{
            const original=input.items.find(i=>i.code===line.sku)
            if (!original) throw new Error("Produto do lote indisponível no pedido")
            const quantity=decimalMicros(line.quantity)
            return {...original,quantity,grossTotal:itemTotal(quantity,original.unitPrice)}
          })
          input.productsTotal=productsTotal(input.items)
        }
        const modelReady = await withModelReadiness(ready,input.model,input.environment,controller.signal)
        if (controller.signal.aborted) return
        setAllocationRules({}); setRecipientExpanded(!recipientComplete(input.recipient)); setPendingAmounts(false); setDraft(input); setBaseline(JSON.stringify(input)); setSnapshot(current || null)
        setEmissionHeader(null)
        setPreparation(proposed || null)
        setTenant(me.tenant.id); setReadiness(modelReady); setCanEdit(me.permissions.includes("fiscal.nfe.manage") && (!current || current.canEdit))
        setCanSearchParties(me.permissions.includes("catalog.parties.read"))
        setCanSearch(me.permissions.includes("catalog.products.read")); setEtag(id ? responses[2].headers.get("etag") || "" : "")
        setCanIssue(me.permissions.includes("fiscal.nfe.issue"))
        setCanCancel(me.permissions.includes("fiscal.nfe.cancel"))
        setCanCorrect(me.permissions.includes("fiscal.nfe.correction"))
        setBlocked(false); setError(""); command.current = null
      } catch (reason) { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "Falha ao abrir o rascunho"); setCanEdit(false); setCanIssue(false); setCanCancel(false); setCanCorrect(false) } }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void read()
    return () => controller.abort()
  }, [id, sourceOrderId, initialModel, lotId, lotEnvironment, reload])
  useEffect(() => {
    if (!tenant) return
    let active: AbortController | null = null
    async function checkReadiness() {
      active?.abort()
      const controller = new AbortController(); active = controller
      try {
        const [readyResponse, certificateResponse, profileResponse] = await Promise.all([
          erpFetch("/api/erp/fiscal/readiness", { signal: controller.signal }),
          erpFetch("/api/erp/fiscal/certificate", { signal: controller.signal }),
          erpFetch("/api/erp/fiscal/config", { signal: controller.signal }),
        ])
        const ready = await readyResponse.json()
        const certificate = certificateResponse.ok ? await certificateResponse.json() : null
        const profile = profileResponse.ok ? await profileResponse.json() : null
        if (!readyResponse.ok || ready.tenantId !== tenant || certificate && certificate.tenantId !== tenant) return
        const modelReady = await withModelReadiness(ready,draft.model,draft.environment,controller.signal)
        if (!controller.signal.aborted) { setReadiness(modelReady); setCertificateStatus(certificate?.status); if (profile?.tenantId === tenant) setIssuerProfile(profile.data) }
      } catch { /* Keep the last confirmed readiness; never infer a missing certificate from network failure. */ }
    }
    const focus = () => { if (document.visibilityState === "visible") void checkReadiness() }
    void checkReadiness()
    window.addEventListener("focus", focus)
    return () => { active?.abort(); window.removeEventListener("focus", focus) }
  }, [tenant, draft.model, draft.environment])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || uncertain || saving) event.preventDefault() }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty, uncertain, saving])
  useEffect(() => () => { request.current?.abort() }, [])

  function changeItem(index: number, patch: Partial<DraftItem>) {
    setAllocationRules(previous => {
      const next = { ...previous }
      for (const [key] of amountFields) if (patch[key] !== undefined && next[key]) next[key] = { ...next[key]!, locked: [...new Set([...next[key]!.locked, index])] }
      return next
    })
    setDraft(previous => ({ ...previous, items: previous.items.map((item, position) => position === index ? { ...item, ...patch } : item) }))
  }
  function changeTaxes(patch: Partial<TaxDeclaration>) {
    setDraft(previous => previous.taxDeclaration ? { ...previous, taxDeclaration: { ...previous.taxDeclaration, ...patch }, ...(typeof patch.finalConsumer === "boolean" ? { finalConsumer: patch.finalConsumer } : {}) } : previous)
  }
  function refresh() {
    if (uncertain && !id) { setError("Confirme a mesma solicitação antes de iniciar outro rascunho"); return }
    if ((dirty || uncertain) && !window.confirm("Recarregar substitui a edição pelos dados do servidor. Deseja continuar?")) return
    setLoading(true); setUncertain(false); setNotice(""); setReload(value => value + 1)
  }
  function addProduct(product: NfePickerProduct) {
    const item = { ...blankItem(), code: product.sku, description: product.name, unit: product.unit, ncm: product.ncm || "", unitPrice: product.basePrice }
    setDraft(previous => {
      const replaceBlank = previous.items.length === 1 && JSON.stringify(previous.items[0]) === JSON.stringify(blankItem())
      return { ...previous, items: replaceBlank ? [item] : [...previous.items, item], ...(previous.ibpt ? { ibpt: { ...previous.ibpt, items: replaceBlank ? [blankIbptItem()] : [...previous.ibpt.items, blankIbptItem()] } } : {}) }
    })
    setNotice("Dados do produto copiados. Confira o NCM e preencha a tributação conforme a instrução fiscal.")
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (allocationError) { setStep(2); setError(allocationError); return }
    if (pendingAmounts) { setStep(2); setError("Aplique ou descarte os totais digitados antes de salvar."); return }
    const invalid = Array.from(event.currentTarget.elements).find((element): element is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement => (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) && element.willValidate && !element.validity.valid)
    if (invalid) {
      const panel = invalid.closest<HTMLElement>("[data-editor-step]")
      if (panel) { setStep(Number(panel.dataset.editorStep)); if (panel.dataset.editorStep === "1") setRecipientExpanded(true) }
      let parent = invalid.parentElement
      while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement }
      requestAnimationFrame(() => { invalid.focus(); invalid.reportValidity() })
      setError("Confira o campo indicado antes de salvar o rascunho.")
      return
    }
    if (!canEdit || blocked || fiscalLocked || writing.current || uncertain && !!id || !uncertain && !dirty) return
    let body: string
    try { body = uncertain && command.current ? command.current.body : JSON.stringify(submission(lotId ? {...draft,sourceOrderId:null} : draft)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Confira os valores dos itens"); return }
    if (!id && !command.current) command.current = { key: lotId || crypto.randomUUID(), body }
    writing.current = true; setSaving(true); setError(""); setNotice("")
    const controller = new AbortController(); request.current = controller
    let resolved = false
    try {
      const response = await erpFetch(id ? `/api/erp/fiscal/nfe/${id}` : "/api/erp/fiscal/nfe", {
        method: id ? "PUT" : "POST", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        headers: { "Content-Type": "application/json", "X-Tenant-Id": tenant, ...(id ? { "If-Match": etag } : { "Idempotency-Key": command.current!.key }) }, body,
      })
      const value = await response.json()
      if (!response.ok) {
        if (response.status >= 500) { setUncertain(true); throw new Error("Não foi possível confirmar a gravação. Confira o servidor antes de repetir ou confirme a mesma solicitação.") }
        resolved = true; setUncertain(false); command.current = null
        if ([401, 403, 409, 412, 428].includes(response.status) && !(response.status === 409 && value.code === "ibpt_not_available")) setBlocked(true)
        throw new Error(value.title || "Não foi possível salvar o rascunho")
      }
      if (value.tenantId !== tenant || !value.data?.id || !response.headers.get("etag")) { setUncertain(true); throw new Error("Resposta sem confirmação do rascunho. Recarregue os dados do servidor") }
      const saved=lotId ? {...value.data.input,sourceOrderId} : value.data.input
      setSnapshot(value); setDraft(saved); setBaseline(JSON.stringify(saved)); setEtag(response.headers.get("etag")!)
      resolved = true; setUncertain(false); command.current = null; setNotice("Rascunho salvo no servidor. Nenhuma nota foi transmitida.")
      if (!id) router.replace(`/fiscal/notas-saida/${value.data.id}`+(lotId ? `?pedido=${sourceOrderId}&lote=${lotId}&ambiente=${lotEnvironment}` : ""))
    } catch (reason) {
      if (!controller.signal.aborted) {
        if (!resolved) setUncertain(true)
        setError(reason instanceof Error ? reason.message : "Não foi possível confirmar a gravação")
      }
    } finally { writing.current = false; setSaving(false) }
  }
  const editable = canEdit && !loading && !saving && !blocked && !uncertain && !fiscalLocked
  const profileReady = readiness?.profileConfigured && !readiness.blockers.includes("company_and_fiscal_profile_inconsistent")
  const emissionBlockers = readiness?.blockers.filter(blocker => draft.environment === "production" || blocker !== "production_emission_disabled") || []
  if (draft.environment === "production" && readiness?.productionEnabled === false && !emissionBlockers.includes("production_emission_disabled")) emissionBlockers.push("production_emission_disabled")
  const canTransmit = Boolean((draft.model !== 65 || readiness?.model === 65 && readiness.modelEnvironment === draft.environment) && readiness?.profileConfigured && readiness.certificateVerified && emissionBlockers.length === 0 && (readiness.canTransmit || draft.environment === "homologation" && readiness.blockers.includes("production_emission_disabled")))
  let total = "Confira quantidades e preços"
  try { total = `R$ ${productsTotal(draft.items).replace(".", ",")}` } catch { /* Invalid fields remain visible until corrected. */ }
  return <main className="mx-auto max-w-6xl space-y-6 px-4 pb-28 pt-8 lg:px-6">
    <Link className="text-sm text-primary underline" href="/fiscal/notas-saida" onClick={event => { if ((dirty || uncertain || saving) && !window.confirm("Sair sem confirmar esta edição?")) event.preventDefault() }}>Notas fiscais de saída</Link>
    <header><p className="text-sm text-primary">Fiscal / {draft.model === 65 ? "NFC-e" : "NF-e de saída"}</p><PageTitle className="mt-2 text-3xl font-semibold">{id ? `Preparação e emissão de ${draft.model === 65 ? "NFC-e" : "NF-e"}` : `Preparar ${draft.model === 65 ? "NFC-e" : "nota de saída"}`}</PageTitle><p className="mt-3 text-muted-foreground">{draft.environment === "production" ? `Produção · Modelo ${draft.model}` : `Homologação · Modelo ${draft.model} · Sem valor fiscal`}</p>{snapshot && <p className="mt-2 break-all text-xs text-muted-foreground">{snapshot.data.id} · Revisão {snapshot.data.revision} · Emitente: {snapshot.data.issuer.legalName}</p>}</header>

    {draft.sourceOrderId && <section className="rounded-xl border border-primary/30 p-4 text-sm"><p>Origem: <Link className="break-all text-primary underline" href={`/vendas/pedidos/${draft.sourceOrderId}`}>Pedido {draft.sourceOrderId}</Link>{preparation ? ` · Revisão consultada ${preparation.orderRevision}` : ""}</p>{preparation && <Link className="mt-2 inline-block text-primary underline" href={`/cadastros/clientes-fornecedores/${preparation.customerId}`}>Abrir cadastro do cliente</Link>}<p className="mt-2 text-muted-foreground">{lotId ? "Esta preparação corresponde às quantidades reservadas no lote." : "Esta preparação representa o pedido integral."} Código, unidade, quantidade e preço permanecem os registrados na venda. Confira o endereço e informe o código IBGE e a tributação. Salvar não marca o pedido como faturado.</p></section>}
    {draft.sourceOrderId && tenant && <OrderSerials key={draft.sourceOrderId} id={draft.sourceOrderId} tenant={tenant}/>}
    {loading && <p role="status">Carregando dados fiscais…</p>}
    {readiness && !profileReady && <p role="alert" className="rounded-xl border p-4 text-sm">Preencha ou corrija a <Link className="text-primary underline" href="/preferencias/fiscal" target="_blank" rel="noopener noreferrer">configuração fiscal do emitente</Link> antes de salvar. Depois, recarregue os dados.</p>}
    {error && <p role="alert" className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive">{error}{blocked && " Sua edição foi preservada. Confira os dados atuais antes de tentar novamente."}</p>}
    {notice && <p role="status" className="rounded-xl border border-primary/30 p-4 text-sm">{notice}</p>}
    {!loading && <>
      {!canEdit && !error && <p className="text-sm">Seu acesso permite somente consultar este rascunho.</p>}
      <nav aria-label="Etapas da nota fiscal" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {editorSteps.map((label, index) => <Button key={label} type="button" variant={step === index ? "default" : "outline"} className="h-auto min-h-11 justify-start whitespace-normal px-3 py-2 text-left" aria-current={step === index ? "step" : undefined} onClick={() => setStep(index)}>{index + 1}. {label}</Button>)}
      </nav>
      <p role="status" className="text-sm text-muted-foreground">Etapa {step + 1} de {editorSteps.length} · {editorSteps[step]}</p>
      <p className="text-sm text-muted-foreground">{stepDescriptions[step]}</p>
      <form noValidate onSubmit={event => { if (step < editorSteps.length - 1) { event.preventDefault(); setStep(value => value + 1) } else void save(event) }} className="space-y-4">
        <fieldset disabled={!editable} className="min-w-0 space-y-6 disabled:opacity-75">
          <div hidden={step !== 0} data-editor-step="0" className="space-y-4">
          <section className="form-section grid gap-4 sm:grid-cols-2" aria-label="Operação fiscal">
            <NfeIdentificationFields draft={draft} change={patch => setDraft(previous => ({ ...previous, ...patch }))} profile={emissionHeader ? { ...(issuerProfile || snapshot?.data.issuer?.profile || readiness), series: emissionHeader.series } : issuerProfile || snapshot?.data.issuer?.profile || readiness} number={emissionHeader?.number} onImport={() => { if ((!dirty && !uncertain) || window.confirm("Sair desta preparação e abrir a importação de XML autorizado?")) router.push("/fiscal/notas-saida/importar") }} />
            <div className="sm:col-span-2">{tenant && <OperationNaturePicker key={`nature-${tenant}`} tenant={tenant} value={draft.operationNature} onChange={operationNature=>setDraft(previous=>({...previous,operationNature}))} onApply={(nature,revision)=>setDraft(previous=>({...previous,operationNature:nature.name,taxRuleReference:`${nature.code} • revisão ${revision}`}))} />}</div>
            <Field label="Ambiente do rascunho"><select disabled={!!lotId} aria-label="Ambiente do rascunho" className="h-10 w-full rounded-lg border bg-background px-3 text-sm" value={draft.environment} onChange={event => setDraft({ ...draft, environment: event.target.value as DraftInput["environment"] })}><option value="homologation">Homologação</option><option value="production">Produção</option></select></Field>
            {draft.model === 55 && <Field label="Finalidade fiscal"><select aria-label="Finalidade fiscal" disabled={draft.printType === 6 || !!draft.exportation || !!draft.sourceOrderId || draft.sourceReturnKind==="sale_partial_return"} className="h-10 w-full rounded-lg border bg-background px-3 text-sm" value={draft.purpose ?? 1} onChange={event => { const purpose = Number(event.target.value); setDraft({ ...draft, purpose, creditType: purpose === 5 ? draft.creditType || null : null, debitType: purpose === 6 ? draft.debitType || null : null, items: draft.items.map(item => ({ ...item, referencedDfe: null })), ...([5, 6].includes(purpose) ? { presenceIndicator: 0, referencedAccessKeys: [] } : {}), ...(purpose !== 4 ? { returnDirection: undefined, sourceReturnId: undefined, sourceReturnKind: undefined, ...(purpose === 1 ? { referencedAccessKeys: [] } : {}) } : {}) }) }}><option value={1}>1 · Normal</option><option value={2}>2: NF-e complementar</option><option value={3}>3: NF-e de ajuste</option><option value={4}>4: Devolução de mercadoria</option><option value={5}>5: Nota de crédito</option><option value={6}>6: Nota de débito</option></select></Field>}
            <Field label="Referência da instrução fiscal"><Input required maxLength={200} value={draft.taxRuleReference} onChange={event => setDraft({ ...draft, taxRuleReference: event.target.value })} /></Field>
            {draft.model === 65 && <><Field label="Modalidade de emissão NFC-e"><select aria-label="Modalidade de emissão NFC-e" className="h-10 w-full rounded-lg border bg-background px-3 text-sm" value={draft.emissionType ?? "1"} onChange={event => setDraft({ ...draft, emissionType: event.target.value as DraftInput["emissionType"] })}><option value="1">1 · Normal</option><option value="3">3 · Contingência FS-IA</option><option value="4">4 · Contingência EPEC</option><option value="9">9 · Contingência offline</option></select></Field><Field label="Troco da NFC-e (R$)"><Input aria-label="Troco da NFC-e" inputMode="decimal" maxLength={17} value={draft.changeAmount || ""} onChange={event => setDraft({ ...draft, changeAmount: event.target.value || undefined })} /></Field></>}
          </section>
          <NfeExportFields draft={draft} change={patch => setDraft(previous => ({ ...previous, ...patch }))} />
          <NfeFinancialFields draft={draft} change={patch => setDraft(previous => ({ ...previous, ...patch }))} />
          {hasHeaderFiscalReference(draft) && <section className="form-section space-y-3"><h2 className="font-semibold">Documentos referenciados</h2><Field label="Chaves NF-e referenciadas"><Input required={draft.purpose === 2 || draft.purpose === 5} maxLength={draft.purpose === 5 ? 44 : 4454} value={(draft.referencedAccessKeys || []).join(",")} onChange={e => setDraft({ ...draft, referencedAccessKeys: e.target.value.split(",").map(key => key.trim()).filter(Boolean) })} /></Field><p className="text-xs text-muted-foreground">{draft.purpose === 5 ? "Informe a única chave de origem exigida para este subtipo de crédito." : "Informe as chaves de 44 dígitos separadas por vírgula. A nota complementar exige uma NF-e de origem. Na nota de ajuste, declare sem pagamento na etapa Pagamento."}</p></section>}
          {draft.purpose === 4 && <section className="form-section space-y-4" aria-label="Origem da devolução fiscal"><h2 className="text-lg font-semibold">Origem da devolução fiscal</h2><p className="text-sm text-muted-foreground">A origem comercial deve existir antes da emissão. O ERP não infere o tratamento tributário; informe a direção, a origem persistida e as chaves fiscais autorizadas.</p><div className="grid gap-4 sm:grid-cols-2"><Field label="Tipo da origem"><select aria-label="Tipo da origem" className="h-10 w-full rounded-lg border bg-background px-3 text-sm" value={draft.sourceReturnKind || ""} onChange={event => setDraft({ ...draft, sourceReturnKind: event.target.value as DraftInput["sourceReturnKind"] })}><option value="">Selecione</option>{draft.sourceReturnKind==="sale_partial_return" && <option value="sale_partial_return">Devolução parcial de venda</option>}<option value="sale_cancellation">Cancelamento de venda · entrada</option><option value="purchase_reversal">Reversão de compra · saída</option></select></Field><Field label="Direção da devolução"><select disabled={snapshot?.data.input.sourceReturnKind==="sale_partial_return"} aria-label="Direção da devolução" className="h-10 w-full rounded-lg border bg-background px-3 text-sm" value={draft.returnDirection || ""} onChange={event => setDraft({ ...draft, returnDirection: event.target.value as DraftInput["returnDirection"] })}><option value="">Selecione</option><option value="incoming">Entrada</option><option value="outgoing">Saída</option></select></Field><Field label="ID da origem comercial"><Input readOnly={snapshot?.data.input.sourceReturnKind==="sale_partial_return"} aria-label="ID da origem comercial" required maxLength={36} value={draft.sourceReturnId || ""} onChange={event => setDraft({ ...draft, sourceReturnId: event.target.value || undefined })} /></Field><Field label="Chaves NF-e referenciadas"><Input readOnly={snapshot?.data.input.sourceReturnKind==="sale_partial_return"} aria-label="Chaves NF-e referenciadas" required maxLength={44 * 99 + 98} value={(draft.referencedAccessKeys || []).join(",")} onChange={event => setDraft({ ...draft, referencedAccessKeys: event.target.value.split(",").map(value => value.trim()).filter(Boolean) })} /></Field></div><p className="text-xs text-muted-foreground">Informe uma ou mais chaves de 44 dígitos separadas por vírgula. A combinação origem/direção é validada no backend.</p></section>}
          </div>
          <div hidden={step !== 1} data-editor-step="1" className="space-y-4">
          <section className="form-section space-y-4" aria-label="Destinatário"><h2 className="text-lg font-semibold">Destinatário</h2><div className="grid gap-3 sm:grid-cols-2"><Field label="Vendedor"><Input maxLength={200} value={draft.salesperson || ""} onChange={e => setDraft({ ...draft, salesperson: e.target.value || null })} /></Field></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.finalConsumer ?? draft.taxDeclaration?.finalConsumer ?? true} disabled={draft.model === 65 || draft.printType === 6} onChange={e => setDraft({ ...draft, finalConsumer: e.target.checked, ...(draft.taxDeclaration ? { taxDeclaration: { ...draft.taxDeclaration, finalConsumer: e.target.checked } } : {}) })} />Consumidor final</label>{canSearchParties && !draft.sourceOrderId && draft.recipient.state !== "EX" && <NfeRecipientPicker tenant={tenant} onApply={(recipient, fiscal) => { setRecipientExpanded(!recipientComplete(recipient)); setDraft(previous => applyRecipientFiscal({ ...previous, recipient }, fiscal, issuerProfile?.crt || readiness?.crt || null)) }} />}{canSearchParties && draft.recipient.state !== "EX" && <NfeMunicipalityLookup tenant={tenant} recipient={draft.recipient} onResolveMunicipality={(expected, code) => setDraft(previous => { const recipient = applyMunicipalityCode(previous.recipient, expected, code); return recipient === previous.recipient ? previous : { ...previous, recipient } })} />}{draft.recipient.state === "EX" ? <NfeForeignRecipientFields draft={draft} change={patch => setDraft(previous => ({ ...previous, ...patch }))} /> : <><div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div className="text-sm"><strong>{draft.recipient.legalName || "Destinatário não selecionado"}</strong><p>{draft.recipient.taxId}</p><p className="text-xs text-muted-foreground">{[draft.recipient.street, draft.recipient.number, draft.recipient.cityName, draft.recipient.state].filter(Boolean).join(" • ")}</p></div><Button type="button" variant="outline" onClick={() => setRecipientExpanded(value => !value)}>{recipientExpanded ? "Concluir edição do destinatário" : "Editar dados desta nota"}</Button></div><div hidden={editable && !recipientExpanded && recipientComplete(draft.recipient)} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {([['taxId', 'CPF/CNPJ', 14], ['legalName', 'Nome ou razão social', 60], ['municipalityCode', 'Código IBGE do município', 7], ['postalCode', 'CEP', 8], ['street', 'Logradouro', 60], ['number', 'Número', 60], ['district', 'Bairro', 60], ['cityName', 'Município', 60], ['complement', 'Complemento', 60], ['phone', 'Telefone', 14], ['email', 'E-mail', 60]] as const).map(([key, label, maximum]) => <Field key={key} label={label}><Input required={!(["complement", "phone", "email", "cityName"] as string[]).includes(key)} type={key === "email" ? "email" : "text"} readOnly={!!draft.sourceOrderId && key === "taxId"} maxLength={maximum} value={draft.recipient[key] || ""} onChange={event => setDraft({ ...draft, recipient: { ...draft.recipient, [key]: event.target.value || (["complement", "phone", "email", "cityName"].includes(key) ? null : "") } })} /></Field>)}
            <Field label="UF do destinatário"><select required className="h-9 w-full rounded-lg border bg-background px-3 text-sm" value={draft.recipient.state} onChange={event => setDraft({ ...draft, recipient: { ...draft.recipient, state: event.target.value } })}><option value="">Selecione</option>{states.map(state => <option key={state}>{state}</option>)}</select></Field>
          </div></>}{draft.recipient.state !== "EX" && <p className="text-xs text-muted-foreground">Informe CPF/CNPJ, CEP e código IBGE somente com dígitos. O código IBGE deve corresponder à UF.</p>}</section>
          </div>
          <div hidden={step !== 2} data-editor-step="2" className="space-y-4">
          <section className="form-section space-y-4" aria-label="Itens do rascunho"><h2 className="text-lg font-semibold">Itens</h2>
            {canSearch && !draft.sourceOrderId && <NfeProductPicker key={`${tenant}:${reload}`} tenant={tenant} disabled={draft.items.length >= 990} onSelect={addProduct} />}
            <NfeGlobalAmounts onPendingChange={setPendingAmounts} draft={draft} change={(items, totals) => { setAllocationRules(previous => { const next = { ...previous }; for (const [key] of amountFields) if (totals[key] !== undefined) next[key] = { total: totals[key] || "0", locked: [] }; return next }); setDraft(previous => ({ ...previous, items })) }} />
            {allocationError && <p role="alert" className="text-sm text-destructive">{allocationError}</p>}
            <NfeItemsTable editable={editable} draft={draft} changeItem={changeItem} remove={index => { setAllocationRules(previous => Object.fromEntries(Object.entries(previous).map(([key, rule]) => [key, { ...rule, locked: rule.locked.filter(position => position !== index).map(position => position > index ? position - 1 : position) }]))); setDraft({ ...draft, items: draft.items.filter((_, position) => position !== index), ...(draft.ibpt ? { ibpt: { ...draft.ibpt, items: draft.ibpt.items.filter((_, position) => position !== index) } } : {}) }) }} />
            <Button type="button" variant="outline" disabled={!!draft.sourceOrderId || draft.items.length >= 990} onClick={() => setDraft({ ...draft, items: [...draft.items, blankItem()], ...(draft.ibpt ? { ibpt: { ...draft.ibpt, items: [...draft.ibpt.items, blankIbptItem()] } } : {}) })}>Adicionar item manualmente</Button>
          </section>
          <NfeAmountsSummary draft={draft} />
          <NfeTransportFields draft={draft} change={patch => setDraft(previous => ({ ...previous, ...patch }))} />
          </div>
          <div hidden={step !== 3} data-editor-step="3" className="space-y-3 [&_input]:h-8 [&_select]:text-xs [&_label]:text-xs [&_label]:gap-1 [&_.form-section]:p-3">
          {tenant && <TaxProfilePicker key={tenant} tenant={tenant} onApply={(profile,revision,scenario)=>setDraft(previous=>{ const applied = applyTaxProfile(previous,profile,revision,scenario); return { ...applied, finalConsumer: applied.taxDeclaration?.finalConsumer ?? null } })} />}
          <section className="form-section space-y-3" aria-label="Tributação dos itens"><h2 className="text-sm font-semibold">Tributação dos itens</h2><p className="text-sm text-muted-foreground">Confira NCM, CFOP, origem e CST de cada produto. Informe CST do ICMS ou CSOSN conforme o regime.</p>
            <NfeTaxItemsTable draft={draft} changeItem={changeItem} />
          </section>
          <section className="form-section space-y-3" aria-label="Declaração tributária CRT 3"><h2 className="text-sm font-semibold">Declaração tributária: regime normal (CRT 3)</h2>
            <p className="text-sm text-muted-foreground">Preencha conforme a referência da instrução fiscal. Disponível para emitente de São Paulo em operações internas e interestaduais, com a mesma classificação e alíquota em todos os itens. Venda interestadual a não contribuinte exige ICMS CST 00, consumidor final e alíquotas do destino. Frete cobrado e desconto incondicional compõem as bases por item. NCM, regime e recebimentos não determinam alíquotas automaticamente.</p>
            {draft.taxDeclaration ? <>
              <h3 className="text-xs font-semibold">Operação e destinatário</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {([["finalConsumer", "Operação para consumidor final"], ["ipiInIcmsBase", "Incluir IPI na base do ICMS para consumidor final"], ["icmsOutOfContributions", "Excluir ICMS da base de PIS e COFINS"]] as const).map(([key, label]) => <Field key={key} label={label}><select required disabled={draft.printType === 6 && key === "finalConsumer"} className="h-8 w-full min-w-0 rounded-lg border bg-background px-3" value={draft.taxDeclaration![key] === null ? "" : String(draft.taxDeclaration![key])} onChange={event => changeTaxes({ [key]: event.target.value === "" ? null : event.target.value === "true" })}><option value="">Declare conforme a instrução fiscal</option><option value="true">Sim</option><option value="false">Não</option></select></Field>)}
                <Field label="Classificação ICMS do destinatário"><select required className="h-8 w-full min-w-0 rounded-lg border bg-background px-3" value={draft.taxDeclaration.recipientTaxpayerIndicator || (draft.taxDeclaration.recipientTaxpayer === null ? "" : draft.taxDeclaration.recipientTaxpayer ? "1" : "9")} onChange={event => { const indicator = event.target.value as "1" | "2" | "9" | ""; changeTaxes({ recipientTaxpayerIndicator: indicator || undefined, recipientTaxpayer: indicator ? indicator !== "9" : null, ...(indicator === "2" || !indicator ? { recipientStateRegistration: null } : {}) }) }}><option value="">Declare conforme o cadastro fiscal</option><option value="1">Contribuinte do ICMS</option><option value="2">Contribuinte isento de IE</option><option value="9">Não contribuinte do ICMS</option></select></Field>
                <Field label="Inscrição estadual do destinatário"><Input maxLength={14} disabled={draft.taxDeclaration.recipientTaxpayerIndicator === "2"} required={draft.taxDeclaration.recipientTaxpayer === true && draft.taxDeclaration.recipientTaxpayerIndicator !== "2"} value={draft.taxDeclaration.recipientStateRegistration || ""} onChange={event => changeTaxes({ recipientStateRegistration: event.target.value || null })} /></Field>
              </div>
              <h3 className="text-xs font-semibold">Alíquotas e enquadramento</h3>
              <div className="grid gap-3 grid-cols-2 lg:grid-cols-6">
                {([["icmsRate", "Alíquota do ICMS (%)"], ["pisRate", "Alíquota do PIS (%)"], ["cofinsRate", "Alíquota da COFINS (%)"], ["ipiRate", "Alíquota do IPI (%)"]] as const).map(([key, label]) => <Field key={key} label={label}><Input inputMode="decimal" maxLength={7} value={draft.taxDeclaration![key] || ""} onChange={event => changeTaxes({ [key]: event.target.value || null })} /></Field>)}
                <Field label="CST do IPI (em branco para nota sem IPI)"><Input maxLength={2} value={draft.taxDeclaration.ipiCst || ""} onChange={event => changeTaxes({ ipiCst: event.target.value || null })} /></Field>
                <Field label="Código de enquadramento do IPI"><Input maxLength={3} value={draft.taxDeclaration.ipiFrameCode || ""} onChange={event => changeTaxes({ ipiFrameCode: event.target.value || null })} /></Field>
              </div>
              <p className="text-xs text-muted-foreground">Percentuais aceitam até 4 casas decimais. ICMS CST 00, PIS/COFINS CST 01 ou 02 e IPI tributado exigem alíquota explícita, inclusive 0%. CST sem tributação aceita somente alíquota zero ou em branco. ICMS disponível: 00, 40, 41 e 50; PIS/COFINS: 01, 02 e 04 a 09.</p>
              <section className="rounded-lg border p-3"><h3 className="text-sm font-semibold">ICMS e FCP do destino • DIFAL</h3><div className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Alíquota interna do ICMS no destino (%)"><Input inputMode="decimal" maxLength={7} value={draft.taxDeclaration.destinationIcmsRate || ""} onChange={event => changeTaxes({ destinationIcmsRate: event.target.value || null })} /></Field>
                <Field label="Alíquota do FCP no destino (%)"><Input inputMode="decimal" maxLength={7} value={draft.taxDeclaration.destinationFcpRate || ""} onChange={event => changeTaxes({ destinationFcpRate: event.target.value || null })} /></Field>
              </div>
              <p className="text-xs text-muted-foreground">No DIFAL, declare as duas alíquotas do destino, inclusive FCP zero. ICMS interestadual tributado aceita 4%, 7% ou 12%. Em operação sem DIFAL, deixe as alíquotas do destino em branco.</p>
              </div></section>
              <section className="rounded-lg border p-3"><h3 className="text-sm font-semibold">IBS e CBS declarados</h3><div className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {([["cst", "CST do IBS/CBS", 3], ["classCode", "Classificação tributária IBS/CBS", 6], ["ibsStateRate", "Alíquota do IBS estadual (%)", 7], ["ibsCityRate", "Alíquota do IBS municipal (%)", 7], ["cbsRate", "Alíquota da CBS (%)", 7]] as const).map(([key, label, maximum]) => <Field key={key} label={label}><Input required maxLength={maximum} inputMode={key.endsWith("Rate") ? "decimal" : "numeric"} value={draft.taxDeclaration!.ibsCbs[key]} onChange={event => changeTaxes({ ibsCbs: { ...draft.taxDeclaration!.ibsCbs, [key]: event.target.value } })} /></Field>)}
              </div><p className="text-xs text-muted-foreground">O recorte disponível é tributação integral CST 000 / classificação 000001. Declare os códigos e todas as alíquotas conforme a instrução fiscal; não há preenchimento automático.</p>
              </div></section>
              <Button type="button" variant="outline" onClick={() => { const { taxDeclaration: removed, ...input } = draft; void removed; setDraft(input) }}>Remover declaração tributária</Button>
            </> : <Button type="button" variant="outline" onClick={() => setDraft({ ...draft, taxDeclaration: { ...blankTaxDeclaration(), finalConsumer: draft.finalConsumer ?? null } })}>Adicionar declaração tributária CRT 3</Button>}
          </section>
          <NfeRetentionsFields draft={draft} change={patch => setDraft(previous => ({ ...previous, ...patch }))} />
          <IbptDraftFields selection={draft.ibpt} items={draft.items} onChange={ibpt => setDraft({ ...draft, ibpt })} />
          </div>
          <div hidden={step !== 4} data-editor-step="4" className="space-y-4">
          <NfeInstallmentsFields tenant={tenant} draft={draft} change={patch => setDraft(previous => ({ ...previous, ...patch }))} />
          <section className="form-section space-y-4" aria-label={`Pagamento declarado na ${draft.model === 65 ? "NFC-e" : "NF-e"}`}><h2 className="text-lg font-semibold">Pagamento declarado na {draft.model === 65 ? "NFC-e" : "NF-e"}</h2>
            <p className="text-sm text-muted-foreground">Informe conforme a operação fiscal. Estes dados não geram recebimentos ou cobranças no financeiro.</p>
            {(draft.payments || []).map((payment, index) => <div className="grid gap-3 rounded-xl border p-4 sm:grid-cols-2" key={index}>
              <Field label={`Forma de pagamento ${index + 1}`}><select className="min-h-10 rounded-lg border bg-background px-3" required value={payment.code} onChange={event => setDraft({ ...draft, payments: draft.payments!.map((value, position) => position === index ? { ...value, code: event.target.value } : value) })}><option value="">Selecione</option>{[["01", "Dinheiro"], ["03", "Cartão de crédito"], ["04", "Cartão de débito"], ["15", "Boleto"], ["16", "Depósito"], ["17", "PIX"], ["18", "Transferência"], ["90", "Sem pagamento"], ["99", "Outros"]].map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></Field>
              <Field label={`Valor do pagamento ${index + 1}`}><Input required inputMode="decimal" value={payment.amount} onChange={event => setDraft({ ...draft, payments: draft.payments!.map((value, position) => position === index ? { ...value, amount: event.target.value } : value) })} /></Field>
              <Field label={`Descrição do pagamento ${index + 1}`}><Input required={payment.code === "99"} maxLength={60} value={payment.description || ""} onChange={event => setDraft({ ...draft, payments: draft.payments!.map((value, position) => position === index ? { ...value, description: event.target.value || null } : value) })} /></Field>
              <Button variant="outline" type="button" onClick={() => setDraft({ ...draft, payments: draft.payments!.filter((_, position) => position !== index) })}>Remover pagamento {index + 1}</Button>
            </div>)}
            <Button variant="outline" type="button" disabled={(draft.payments?.length || 0) >= 100} onClick={() => setDraft({ ...draft, payments: [...(draft.payments || []), { code: "", amount: "0.00", description: null }] })}>Adicionar forma de pagamento</Button>
          </section>
          <NfeAdditionalFields draft={draft} change={patch => setDraft(previous => ({ ...previous, ...patch }))} />
          </div>
        </fieldset>
        <section hidden={step !== 5} data-editor-step="5" className="form-section space-y-4">
          <h2 className="text-lg font-semibold">Confira a nota antes de salvar ou emitir</h2>
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div><dt className="text-muted-foreground">Destinatário</dt><dd className="mt-1 font-medium">{draft.recipient.legalName || "Não informado"}</dd><dd>{draft.recipient.taxId || "CPF/CNPJ pendente"}</dd></div>
            <div><dt className="text-muted-foreground">Operação</dt><dd className="mt-1 font-medium">{draft.operationNature || "Não informada"}</dd><dd>{draft.environment === "production" ? "Produção" : "Homologação · sem valor fiscal"}</dd></div>
            <div><dt className="text-muted-foreground">Produtos e pagamentos</dt><dd className="mt-1">{draft.items.length} item(ns) · {draft.payments?.length || 0} forma(s) de pagamento</dd><dd>{draft.taxDeclaration ? "Declaração tributária informada" : "Sem declaração tributária CRT 3"}</dd></div>
          </dl>
          <NfeReview draft={draft} navigate={(targetStep, label) => { setStep(targetStep); if (targetStep === 1) setRecipientExpanded(true); requestAnimationFrame(() => { const panel = document.querySelector(`[data-editor-step="${targetStep}"]`); const field = Array.from(panel?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea") || []).find(element => element.getAttribute("aria-label") === label || Array.from(element.labels || []).some(node => node.textContent?.trim() === label)); field?.focus(); field?.scrollIntoView({ block: "center", behavior: "smooth" }) }) }} />
          <p className="font-medium">Total bruto dos produtos: {total}</p>
          <p className="font-medium">Total da NF-e: {(() => { try { return `R$ ${invoiceTotal(draft).replace(".", ",")}` } catch { return "Confira as alíquotas e os valores" } })()}</p>
          <p className="text-sm text-muted-foreground">O total considera produtos, frete, seguro, outras despesas, desconto e IPI declarado, calculados por item. Os pagamentos e as parcelas devem corresponder ao total da nota.</p>
          <p className="text-sm text-muted-foreground">Salvar guarda o rascunho. Transmitir à SEFAZ exige uma ação separada após a gravação.</p>
          <div className="flex flex-wrap gap-3">
            {pendingAmounts && <p role="status" className="text-sm">Volte à etapa Produtos para aplicar ou descartar os totais digitados antes de salvar.</p>}
            {canEdit && <Button type="submit" disabled={!!allocationError || pendingAmounts || loading || saving || blocked || fiscalLocked || !profileReady || !!id && (!etag || uncertain) || !uncertain && !dirty}>{saving ? "Confirmando gravação…" : uncertain && !id ? "Confirmar mesma solicitação" : "Salvar rascunho"}</Button>}
            {!id && <Button className="h-auto min-h-11 max-w-full whitespace-normal text-center" type="button" disabled>Transmitir {draft.model === 65 ? "NFC-e" : "NF-e"} à SEFAZ em {draft.environment === "production" ? "produção" : "homologação"}</Button>}
            <Button type="button" variant="outline" disabled={saving || loading} onClick={refresh}>Recarregar dados do servidor</Button>
          </div>
          {!id && <p className="text-sm text-muted-foreground">Salve o rascunho para habilitar a transmissão à SEFAZ.</p>}
          {!canIssue && <p role="alert" className="text-sm">Você não tem permissão para transmitir notas à SEFAZ (fiscal.nfe.issue).</p>}
          {uncertain && <p role="alert" className="text-sm">A gravação pode ter ocorrido. {id ? "Recarregue e confira a revisão antes de editar novamente." : "Confirme a mesma solicitação para consultar o resultado sem criar duplicatas."}</p>}
        </section>
      </form>
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background p-3 shadow-sm">
        <NfeFooterTotals draft={draft} />
        <div className="flex gap-2"><Button type="button" variant="outline" disabled={step === 0} onClick={() => setStep(value => value - 1)}>Anterior</Button>{step < editorSteps.length - 1 ? <Button type="button" onClick={() => { setStep(value => value + 1); window.scrollTo({ top: 0, behavior: "smooth" }) }}>Próxima etapa</Button> : <Button type="button" variant="outline" onClick={() => setStep(0)}>Revisar dados</Button>}</div>
      </div>
      <div hidden={step !== 5} className="space-y-4">
      {snapshot?.data.ibptSnapshot && <IbptSavedSnapshot snapshot={snapshot.data.ibptSnapshot} revision={snapshot.data.revision} dirty={dirty} />}
      {readiness && !canTransmit && <section className="form-section space-y-2"><h2 className="font-semibold">Pendências para emitir</h2>{emissionBlockers.length ? emissionBlockers.map(blocker => <p key={blocker} className="text-sm">{blocker === "a1_certificate_missing_expired_or_unavailable" ? certificateMessage(certificateStatus, readiness.certificateVerified) : blockerLabels[blocker] || "Confira a configuração fiscal para esta operação"}</p>) : <p className="text-sm">Não foi possível confirmar a liberação fiscal. Atualize a configuração antes de transmitir.</p>}</section>}
      {id && snapshot && <EmissionActions key={`${id}:${snapshot.data.revision}`} id={id} tenantId={tenant} draftRevision={snapshot.data.revision} environment={snapshot.data.input.environment} model={snapshot.data.input.model === 65 ? 65 : 55} emissionType={snapshot.data.input.emissionType} canIssue={canIssue} canTransmit={canTransmit} canCancel={canCancel} canCorrect={canCorrect} dirty={!!allocationError || loading || dirty || saving || uncertain} onLocked={setFiscalLocked} onDocument={setEmissionHeader} />}
      </div>
    </>}
  </main>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid min-w-0 gap-2 text-sm"><span>{label}</span>{isValidElement(children) ? cloneElement(children as ReactElement<{ "aria-label"?: string }>, { "aria-label": (children.props as { "aria-label"?: string })["aria-label"] || label }) : children}</label>
}

