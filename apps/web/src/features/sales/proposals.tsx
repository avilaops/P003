"use client"

import { SalesRecordList } from "./sales-record-list"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useId, useState, type ComponentProps } from "react"
import { ProductThumbnail } from "@/features/catalog/product-thumbnail"
import { PageHeader } from "@/components/page-header"
import { useNavigationGuard } from "@/components/shell/navigation-guard"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { RequestError } from "@/components/feedback/session-recovery"
import { erpFetch } from "@/lib/api/client"
import type { Schema } from "@/lib/api/types"
import { commercialMoney, commercialMoneyInput, normalizeCommercialMoney, proposalCatalogTotal } from "./order-presentation"
import { quantity, useCommand, useResource } from "@/hooks/use-operation"
import { ColorChoice, Lookup, PlateHolderChoice, type Choice } from "./orders"
import { ProposalDocument, type ProposalIssuer } from "./proposal-document"
import { ProposalEmail } from "./proposal-email"
import { catalogPaletteFor } from "@/features/catalog/catalog-color-photo-model"
import { CatalogPaletteReference } from "@/features/catalog/catalog-color-photos"
import {PaymentTermPicker,type AppliedTerm} from "./payment-term-picker"
import { ProposalCommercialFields } from "./proposal-commercial"
import type { ProposalCommercial, ProposalPricingState, ProposalTechnical } from "./proposal-commercial-model"
import "./proposals-print.css"

type Detail = Omit<Schema<"ProposalSnapshot">, "items"> & { commercial?: ProposalCommercial; items: (Schema<"ProposalSnapshot">["items"][number] & { technical?: ProposalTechnical })[] }
type Listing = Schema<"ProposalList">
type Selected = Choice & { quantity: string; structureColor: string; swingArmColor: string; upholsteryColor: string; plateHolderColor: string; plateHolderType: string }
const labels: Record<string, string> = { draft: "Rascunho", sent: "Enviada", accepted: "Aceita", rejected: "Rejeitada", cancelled: "Cancelada", expired: "Expirada", superseded: "Substituída" }
const linkClass = "font-medium text-primary underline underline-offset-4"
const textareaClass = "erp-commercial-text w-full rounded-lg border border-input bg-background p-3"
const money = commercialMoney
const proposalTrail = [{ label: "Vendas", href: "/vendas" }, { label: "Propostas", href: "/vendas/propostas" }]

function CommercialText({ label, ...props }: ComponentProps<"textarea"> & { label: string }) {
  const id = useId()
  return <div className="grid min-w-0 gap-1 sm:gap-2"><label htmlFor={id}>{label}</label><textarea id={id} rows={2} className={textareaClass} {...props} /></div>
}

export function Proposals({ id, create = false, edit = false }: { id?: string; create?: boolean; edit?: boolean }) {
  if (create || edit) return <ProposalEditor id={edit ? id : undefined} />
  if (id) return <ProposalDetail key={id} id={id} />
  return <ProposalList />
}

function ProposalList() {
  return <SalesRecordList kind="propostas" labels={labels} />
}

type ProposalOrigin={id:string;revision:number;title:string;customerId:string|null;customerName:string|null;stage:string;orderId:string|null;proposalId:string|null}
function ProposalEditor({ id }: { id?: string }) {
  const source=useSearchParams().get("oportunidade")
  if(!id && source) return <OriginProposalEditor source={source}/>
  return <ResolvedProposalEditor id={id}/>
}
function OriginProposalEditor({source}:{source:string}) {
  const r=useResource<{tenantId:string;data:ProposalOrigin;canEdit:boolean;canCreateProposal:boolean}>("/api/erp/opportunities/"+encodeURIComponent(source))
  if(r.loading) return <p role="status">Consultando a oportunidade…</p>
  if(r.error || !r.value) return <p role="alert">{r.error || "Oportunidade indisponível"} <Button onClick={r.reload}>Tentar novamente</Button></p>
  const o=r.value.data
  if(!r.value.canEdit || !r.value.canCreateProposal || o.orderId || o.proposalId || ["lost","won"].includes(o.stage)) return <p>Consulte o vínculo atual em <Link className={linkClass} href={"/vendas/funil/"+o.id}>Abrir oportunidade</Link>.</p>
  return <ResolvedProposalEditor source={o} sourceTenant={r.value.tenantId}/>
}
function ResolvedProposalEditor({id,source,sourceTenant}:{id?:string;source?:ProposalOrigin;sourceTenant?:string}) {
  const result = useResource<Listing | Detail>(id ? `/api/erp/proposals/${id}` : "/api/erp/proposals?limit=1")
  if (result.loading) return <p role="status">Carregando proposta e permissões…</p>
  if (result.error || !result.value) return <section className="form-section"><p role="alert"><RequestError message={result.error || "Proposta indisponível"} status={result.status} /></p><Button onClick={result.reload}>Tentar novamente</Button></section>
  const initial = "items" in result.value ? result.value : undefined
  if (!result.value.canEdit || (initial && initial.data.status !== "draft")) return <section className="form-section space-y-4"><p>Esta proposta não está disponível para edição. É necessário um rascunho e permissão de gestão.</p><Link className={linkClass} href={id ? `/vendas/propostas/${id}` : "/vendas/propostas"}>Voltar às propostas</Link></section>
  if(sourceTenant && result.value.tenantId!==sourceTenant) return <p role="alert">A oportunidade pertence a outra empresa.</p>
  return <ProposalForm source={source} key={`${id || "new"}:${result.etag}`} initial={initial} tenantId={result.value.tenantId} etag={result.etag} reload={result.reload} />
}

function ProposalForm({ initial, tenantId, etag, reload, source }: { source?:ProposalOrigin; initial?: Detail; tenantId: string; etag: string; reload: () => void }) {
  const router = useRouter()
  const command = useCommand()
  const [customer, setCustomer] = useState<Choice | null>(initial ? { id: initial.data.customerId, legalName: initial.data.customerName } : source?.customerId?{id:source.customerId,legalName:source.customerName||"Cliente da oportunidade"}:null)
  const [items, setItems] = useState<Selected[]>(() => initial?.items.map(item => ({ id: item.productId, name: item.name, sku: item.sku, unit: item.unit, basePrice: commercialMoneyInput(item.unitPrice), quantity: item.quantity, structureColor: item.structureColor || "", swingArmColor: item.swingArmColor || "", upholsteryColor: item.upholsteryColor || "", plateHolderColor: item.plateHolderColor || "", plateHolderType: item.plateHolderType || "" })) || [])
  const [validUntil, setValidUntil] = useState(initial?.data.validUntil || "")
  const [termPlan,setTermPlan]=useState<AppliedTerm|null>(null)
  const [paymentTerms, setPaymentTerms] = useState(initial?.data.paymentTerms || "")
  const [deliveryTerms, setDeliveryTerms] = useState(initial?.data.deliveryTerms || "")
  const [notes, setNotes] = useState(initial?.data.notes || "")
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState("")
  const [pricing, setPricing] = useState<ProposalPricingState>({ status: "loading" })
  const frozen = command.busy || command.uncertain || command.stale
  useNavigationGuard(dirty || command.uncertain ? "Sair sem confirmar as alterações desta proposta?" : null)
  useEffect(() => {
    if (!initial) return
    const controller = new AbortController()
    Promise.all(initial.items.map(async item => {
      const response = await erpFetch(`/api/erp/products/${item.productId}`, { cache: "no-store", signal: controller.signal })
      const product = await response.json()
      if (!response.ok || product.tenantId !== tenantId) throw new Error("Não foi possível atualizar as opções de acabamento. As escolhas registradas foram preservadas.")
      return { id: item.productId, structureColors: product.data.structureColors || [], swingArmColors: product.data.swingArmColors || [], finishingPalette: product.data.finishingPalette, upholsteryConfigurable: product.data.upholsteryConfigurable, upholsteryColors: product.data.upholsteryColors || [], plateHolderColors: product.data.plateHolderColors || [], plateHolderTypes: product.data.plateHolderTypes || [], hasPhoto: product.data.hasPhoto }
    })).then(products => { if (!controller.signal.aborted) setItems(previous => previous.map(item => ({ ...item, ...products.find(product => product.id === item.id) }))) })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Falha ao consultar produtos") })
    return () => controller.abort()
  }, [initial, tenantId])
  function changeItem(id: string, patch: Partial<Selected>) { setItems(previous => previous.map(item => item.id === id ? { ...item, ...patch } : item)); setDirty(true) }
  return <><PageHeader eyebrow="Vendas / Propostas" breadcrumbs={[...proposalTrail, ...(initial ? [{ label: `Proposta ${initial.data.number}`, href: `/vendas/propostas/${initial.data.id}` }, { label: "Editar" }] : [{ label: "Nova proposta" }])]} title={initial ? `Editar proposta ${initial.data.number} · versão ${initial.data.version}` : "Nova proposta"} description="Defina produtos e condições comerciais." />
    {source && <p>Oportunidade • <Link className={linkClass} href={"/vendas/funil/"+source.id}>{source.title}</Link></p>}
    <section className="proposal-editor form-section min-w-0 space-y-2 [--workspace-control-height:2.25rem]">
      <div className="grid items-start gap-2 lg:grid-cols-2"><Lookup endpoint="parties" label="cliente" searchOnly compact selectedName={customer?.legalName} disabled={frozen || Boolean(source?.customerId)} choose={value => { setCustomer(value); setDirty(true) }} /><Lookup endpoint="products" label="produto" searchOnly compact disabled={frozen || items.length >= 100} choose={value => {
        if (items.some(item => item.id === value.id)) { setError("Produto já incluído. Altere a quantidade do item existente."); return }
        const saved = initial?.items.find(item => item.productId === value.id)
        setItems(previous => [...previous, { ...value, ...(saved ? { name: saved.name, sku: saved.sku, basePrice: saved.unitPrice } : {}), basePrice: commercialMoneyInput(saved?.unitPrice || value.basePrice || ""), quantity: "1", structureColor: saved?.structureColor || "", swingArmColor: saved?.swingArmColor || "", upholsteryColor: saved?.upholsteryColor || "", plateHolderColor: saved?.plateHolderColor || "", plateHolderType: saved?.plateHolderType || "" }]); setDirty(true); setError("")
      }} /></div>
      <form className="space-y-2" onSubmit={async event => {
        event.preventDefault(); setError("")
        if (pricing.status === "loading" || pricing.status === "error") { setError("Confira a cotação comercial antes de salvar."); return }
        if (!customer || !items.length || items.some(item => !quantity(item.quantity) || !normalizeCommercialMoney(item.basePrice || ""))) { setError("Selecione cliente e itens com quantidades e preços válidos."); return }
        const value = await command.send<Detail>(initial ? `/api/erp/proposals/${initial.data.id}` : "/api/erp/proposals", tenantId, { ...(source?{opportunity:{id:source.id,revision:source.revision}}:{}), customerId: customer.id, validUntil, paymentTerms, deliveryTerms, notes, ...(termPlan?{checkout:{paymentTerm:{id:termPlan.term.id,revision:termPlan.term.revision,start:termPlan.term.start},entry:termPlan.entry,installments:termPlan.installments,manufacturingDays:null,stateRegistration:null,deliveryNotes:"",paymentNotes:"",notes:""}}:{}), ...(pricing.status === "ready" ? { commercial: { simulation: pricing.quote.simulation, digest: pricing.quote.digest } } : {}), items: items.map(item => ({ productId: item.id, quantity: quantity(item.quantity), unitPrice: pricing.status === "ready" || !initial ? null : normalizeCommercialMoney(item.basePrice || ""), structureColor: item.structureColor || null, swingArmColor: item.swingArmColor || null, upholsteryColor: item.upholsteryColor || null, plateHolderColor: null, plateHolderType: item.plateHolderType || null })) }, initial ? etag : "", initial ? "PUT" : "POST")
        if (value) { setDirty(false); router.replace(`/vendas/propostas/${value.data.id}`) }
      }}>
        <fieldset disabled={frozen} className="min-w-0 space-y-2" onChange={() => setDirty(true)}>
          <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">Produtos</h2><span className="text-xs text-muted-foreground">{items.length} item(ns)</span></div>
          {!items.length && <p className="text-sm text-muted-foreground">Busque um produto para incluí-lo na proposta.</p>}
          {items.map(item => <section className="min-w-0 space-y-2 border-b py-2" key={item.id} aria-label={`Item da proposta: ${item.name}`}>
            <div className="flex min-w-0 items-start gap-2 sm:gap-3">
              <ProductThumbnail id={item.id} name={item.name || item.sku || "Produto"} tenantId={tenantId} hasPhoto={item.hasPhoto} />
              <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-medium [overflow-wrap:anywhere]">{item.name}</h3><p className="break-words text-xs text-muted-foreground">{item.sku}</p></div>
              <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 px-2 text-xs" aria-label={`Remover ${item.name}`} onClick={() => { setItems(previous => previous.filter(value => value.id !== item.id)); setDirty(true) }}>Remover</Button>
            </div>
            <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-end gap-2 sm:gap-3">
              <label className="grid min-w-0 gap-1 text-xs">Unitário (R$)<Input className="h-9" aria-label={`Preço unitário de ${item.name}`} title="Preço unitário calculado para esta proposta." readOnly value={pricing.status === "ready" && pricing.quote.sale.items.find(line => line.productId === item.id)?.unitTotalCents !== undefined ? commercialMoneyInput((pricing.quote.sale.items.find(line => line.productId === item.id)!.unitTotalCents! / 100).toFixed(2)) : item.basePrice || ""} /></label>
              <label className="grid min-w-0 gap-1 text-xs">Quantidade<Input className="h-9" aria-label={`Quantidade de ${item.name}`} inputMode="decimal" required value={item.quantity} onChange={event => changeItem(item.id, { quantity: event.target.value })} /></label>
            </div>
            {Boolean(item.structureColors?.length || item.swingArmColors?.length || item.upholsteryColors?.length || item.structureColor || item.swingArmColor || item.upholsteryColor || item.plateHolderTypes?.length || item.plateHolderType) && <details className="min-w-0" onInvalidCapture={event => { event.currentTarget.open = true }}>
              <summary className="cursor-pointer py-1 text-sm font-medium">Acabamentos<span className="ml-2 break-words text-xs font-normal text-muted-foreground">{[item.structureColor, item.swingArmColor, item.upholsteryColor, item.plateHolderType || "Não se aplica"].filter(Boolean).join(" · ")}</span></summary>
              <div className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2">
                {Boolean(item.structureColors?.length || item.structureColor) && <ColorChoice part="structure" palette={catalogPaletteFor(item.finishingPalette)} label={`Estrutura de ${item.name}`} catalog={{ productId: item.id, tenantId, field: "structureColors" }} options={item.structureColors} value={item.structureColor} onChange={value => changeItem(item.id, { structureColor: value })} />}
                {Boolean(item.swingArmColors?.length || item.swingArmColor) && <ColorChoice part="swingArm" optional={Boolean(initial?.items.some(line => line.productId === item.id && !line.swingArmColor))} palette={catalogPaletteFor(item.finishingPalette)} label={`Braços de ${item.name}`} catalog={{ productId: item.id, tenantId, field: "swingArmColors" }} options={item.swingArmColors} value={item.swingArmColor} onChange={value => changeItem(item.id, { swingArmColor: value })} />}
                {Boolean(item.upholsteryColors?.length || item.upholsteryColor) && (item.upholsteryConfigurable !== false || item.upholsteryColor) && <ColorChoice part="upholstery" palette={catalogPaletteFor(item.finishingPalette)} label={`Estofado de ${item.name}`} catalog={{ productId: item.id, tenantId, field: "upholsteryColors" }} options={item.upholsteryConfigurable === false ? [] : item.upholsteryColors} value={item.upholsteryColor} onChange={value => changeItem(item.id, { upholsteryColor: value })} />}
                <PlateHolderChoice label={`Tipo de anilheiro de ${item.name}`} options={item.plateHolderTypes} value={item.plateHolderType} onChange={value => changeItem(item.id, { plateHolderType: value })} />
              </div>
              <CatalogPaletteReference palette={catalogPaletteFor(item.finishingPalette)} />
            </details>}
          </section>)}
          <PaymentTermPicker tenant={tenantId} customer={customer?.id} disabled={frozen} total={pricing.status==="ready"?pricing.quote.sale.totalCents:proposalCatalogTotal(items)} apply={p=>{setTermPlan(p);setPaymentTerms(p.term.name+" • Entrada "+money((p.entryCents/100).toFixed(2))+" • "+p.installments.map(i=>i.dueOn.split("-").reverse().join("/")+" "+money((i.amountCents/100).toFixed(2))).join(" • "));setDirty(true)}}/>
          <ProposalCommercialFields entryCents={termPlan?.entryCents} tenantId={tenantId} customerId={customer?.id} items={items} initial={initial?.commercial} disabled={frozen} onChange={setPricing} />
          <details className="min-w-0 border-y py-2" onInvalidCapture={event => { event.currentTarget.open = true }}>
            <summary className="cursor-pointer py-1 text-sm font-medium">Condições comerciais<span className="ml-2 hidden text-xs font-normal text-muted-foreground sm:inline">Validade, pagamento e entrega</span></summary>
            <div className="mt-2 grid min-w-0 grid-cols-2 items-end gap-2">
              <label className="col-span-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">Validade da proposta<Input type="date" className="block max-w-44 appearance-none [&::-webkit-date-and-time-value]:min-w-0 [&::-webkit-date-and-time-value]:text-start" required value={validUntil} onChange={event => setValidUntil(event.target.value)} /></label>
              <CommercialText label="Condições de pagamento" required maxLength={2000} value={paymentTerms} onChange={event => setPaymentTerms(event.target.value)} />
              <CommercialText label="Condições de entrega" required maxLength={2000} value={deliveryTerms} onChange={event => setDeliveryTerms(event.target.value)} />
              <div className="col-span-2 min-w-0"><CommercialText label="Observações" maxLength={10000} value={notes} onChange={event => setNotes(event.target.value)} /></div>
            </div>
          </details>
        </fieldset>
        {(error || command.error) && <p role="alert"><RequestError message={error || command.error} status={error ? undefined : command.status} /></p>}
        {command.stale && <Button type="button" variant="outline" onClick={() => { if (window.confirm("Recarregar e descartar as alterações locais?")) { command.reset(); reload() } }}>Recarregar proposta</Button>}
        {command.uncertain && <p role="status">Resultado pendente. Repita a confirmação para conferir o mesmo comando.</p>}
        <Button type="submit" className="h-9 px-3" disabled={command.busy || command.stale || !customer || !items.length || pricing.status === "loading" || pricing.status === "error"}>{command.busy ? "Confirmando…" : command.uncertain ? "Repetir confirmação" : "Salvar proposta"}</Button>
      </form>
    </section>
  </>
}

function ProposalDetail({ id }: { id: string }) {
  const requestedVersion = useSearchParams().get("versao") ?? ""
  const [version, setVersion] = useState(() => /^[1-9][0-9]{0,8}$/.test(requestedVersion) ? requestedVersion : "")
  const result = useResource<Detail>(`/api/erp/proposals/${id}${version ? `?version=${version}` : ""}`)
  const access = useResource<{ tenant: { id: string; legalName: string }; permissions: string[] }>("/api/erp/me")
  const issuer = useResource<{ tenantId: string; data: ProposalIssuer }>("/api/erp/company")
  const command = useCommand()
  const [action, setAction] = useState("")
  const [reason, setReason] = useState("")
  const [dueDate, setDueDate] = useState("")
  const [notice, setNotice] = useState("")
  const value = result.value
  const frozen = result.loading || command.busy || command.uncertain || command.stale
  const sameTenant = access.value?.tenant.id === value?.tenantId
  const canDecide = sameTenant && access.value?.permissions.includes("sales.proposals.decide")
  const canConvert = sameTenant && ["sales.orders.read", "sales.orders.manage"].every(permission => access.value?.permissions.includes(permission))
  async function confirm() {
    if (!value || !action) return
    const body = action === "convert" ? { dueDate } : action === "revise" ? {} : { reason: reason || null }
    const updated = await command.send<Detail>(`/api/erp/proposals/${id}/${action}`, value.tenantId, body, result.etag)
    if (updated) { setNotice("Operação confirmada no servidor."); setAction(""); setReason(""); setVersion(""); result.reload() }
  }
  return <><div className="print:hidden"><PageHeader eyebrow="Vendas / Propostas" breadcrumbs={[...proposalTrail, { label: value ? `Proposta ${value.data.number} · versão ${value.data.version}` : "Proposta" }]} title={value ? `Proposta ${value.data.number}` : "Proposta comercial"} description="Consulte o documento comercial e registre as decisões sobre cada versão." /></div>
    <div className="print:hidden"><Link className={linkClass} href="/vendas/propostas">Voltar às propostas</Link></div>
    <section className="mt-5 min-w-0 space-y-5">
      {notice && <p role="status" className="print:hidden">{notice}</p>}
      {result.loading && !value ? <p role="status">Carregando proposta…</p> : result.error ? <div role="alert"><RequestError message={result.error} status={result.status} /><Button onClick={result.reload}>Tentar novamente</Button></div> : value && <>
        <div className="flex flex-wrap justify-end gap-2 print:hidden">
          <ProposalEmail key={`${id}:${value.data.version}`} id={id} number={value.data.number} version={value.data.version} tenantId={value.tenantId} etag={result.etag} disabled={!value.data.isCurrent || frozen} onReload={() => { setVersion(""); setAction(""); result.reload() }} />
          <Button variant="outline" onClick={() => window.print()}>Imprimir / salvar PDF</Button>
        </div>
        <label className="grid min-w-0 gap-2 print:hidden">Histórico de versões<select className="min-h-10 w-full min-w-0 rounded-lg border bg-background px-3" value={version} disabled={frozen} onChange={event => { setVersion(event.target.value); setAction("") }}><option value="">Versão atual</option>{value.versions.map(item => <option key={item.version} value={String(item.version)}>Versão {item.version} · {labels[item.status]} · {money(item.amount)}</option>)}</select></label>
        <ProposalDocument snapshot={value} issuer={issuer.value?.tenantId === value.tenantId ? issuer.value.data : undefined} issuerName={sameTenant ? access.value?.tenant.legalName : undefined} />
        {value.data.decisionReason && <p className="whitespace-pre-wrap print:hidden">Motivo registrado: {value.data.decisionReason}</p>}
        {value.data.orderId && <Link className={`${linkClass} print:hidden`} href={`/vendas/pedidos/${value.data.orderId}`}>Consultar pedido gerado</Link>}
        {!value.data.isCurrent && <p className="print:hidden">Versão histórica. Consulte a versão atual para realizar operações.</p>}
        <div className="space-y-4 print:hidden">
          {command.error && <p role="alert"><RequestError message={command.error} status={command.status} /></p>}
          {command.stale && <Button variant="outline" onClick={() => { command.reset(); setAction(""); result.reload() }}>Recarregar proposta</Button>}
          {value.data.isCurrent && !value.data.orderId && !action && <div className="flex flex-wrap gap-3">
            {value.canEdit && value.data.status === "draft" && <><Link className={linkClass} href={`/vendas/propostas/${id}/editar`}>Editar rascunho</Link><Button disabled={frozen} onClick={() => setAction("send")}>Marcar como enviada</Button></>}
            {canDecide && value.data.status === "sent" && <><Button disabled={frozen || value.data.expired} onClick={() => setAction("accept")}>Registrar aceite</Button><Button disabled={frozen} variant="outline" onClick={() => setAction("reject")}>Registrar rejeição</Button></>}
            {value.canEdit && ["sent", "accepted", "rejected"].includes(value.data.status) && <Button disabled={frozen} variant="outline" onClick={() => setAction("revise")}>{value.data.expired ? "Renovar em nova versão" : "Criar nova versão"}</Button>}
            {value.canEdit && ["draft", "sent", "accepted"].includes(value.data.status) && <Button disabled={frozen} variant="outline" onClick={() => setAction("cancel")}>Cancelar proposta</Button>}
            {value.canEdit && canConvert && value.data.status === "accepted" && <Button disabled={frozen} onClick={() => setAction("convert")}>Gerar pedido em rascunho</Button>}
          </div>}
          {action && <form className="space-y-3 rounded-xl border p-4" onSubmit={event => { event.preventDefault(); void confirm() }}>
            <p>{action === "send" ? "Confirme que esta versão já foi enviada ao cliente. O conteúdo ficará bloqueado; este botão não envia mensagens." : action === "accept" ? "Registre o aceite recebido do cliente. Este registro interno não equivale a uma assinatura digital." : action === "revise" ? "Uma nova versão em rascunho será criada, preservando o conteúdo anterior." : action === "convert" ? "Será criado um pedido em rascunho com os preços acordados. A reserva e a cobrança seguem o fluxo do pedido." : "Informe o motivo desta decisão."}</p>
            {["reject", "cancel"].includes(action) && <CommercialText label="Motivo" required maxLength={2000} disabled={frozen} value={reason} onChange={event => setReason(event.target.value)} />}
            {action === "convert" && <label className="grid min-w-0 gap-2">Vencimento do pedido<Input type="date" className="block max-w-full appearance-none [&::-webkit-date-and-time-value]:min-w-0 [&::-webkit-date-and-time-value]:text-start" required disabled={frozen} value={dueDate} onChange={event => setDueDate(event.target.value)} /></label>}
            <div className="flex flex-wrap gap-3"><Button type="submit" disabled={command.busy || command.stale}>{command.uncertain ? "Repetir confirmação" : "Confirmar operação"}</Button><Button type="button" variant="outline" disabled={frozen} onClick={() => setAction("")}>Voltar</Button></div>
          </form>}
        </div>
      </>}
    </section>
  </>
}
