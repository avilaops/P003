"use client"
import { orderColorParts, orderFinishOptions } from "./order-equipment-model"
import { catalogPaletteFor } from "@/features/catalog/catalog-color-photo-model"
import { CatalogPaletteReference } from "@/features/catalog/catalog-color-photos"

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { erpFetch } from "@/lib/api/client"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DataTable } from "@/components/workspace/data-table"
import { Minus, Plus, X } from "lucide-react"
import { RequestError } from "@/components/feedback/session-recovery"
import { useCommand, useResource } from "@/hooks/use-operation"
import { GuardedLink as Link, useNavigationGuard } from "@/components/shell/navigation-guard"
import { states } from "@/features/commercial-settings/commercial-parameters"
import { Lookup, ColorChoice, PlateHolderChoice, type Choice } from "./orders"
import { NegotiationResult } from "./negotiation-result"
import { money, percent, inputAmount, parseAmount, type PriceItem, type PriceTable, type SimulationInput, type NegotiationInput, type Simulation } from "./negotiation-types"
import { mixedOrderTable } from "./mixed-order-table"
import { saveSimulationTransfer, readSimulationTransfer, type SimulationTransfer } from "./simulation-transfer"
import { SalesPriceChannel,ItemPriceOrigins } from "./price-channel"
import { OrderPageHeading } from "./order-proposal-actions"
import type { Opportunity } from "./opportunities"
import { commercialTableReturn, type CommercialSelection } from "./commercial-navigation-model"
import { CommercialCheckout, type CheckoutHandle, type CheckoutProposalSnapshot } from "./commercial-checkout"
import { paymentToday, type CheckoutInput } from "./commercial-payment-model"
import { checkoutEntryIssue } from "./commercial-payment-mobile-model"
import { OrderWeightSummary } from "./order-weight-summary"
import { OrderEquipmentList } from "./order-equipment-list"
import { requiredOrderFinishParts } from "./order-equipment-model"
import { useOrderProductDetails, type ProductFinishes } from "./order-product-details"
import { OrderCustomerForm, type OrderCustomerHandle } from "./order-customer-form"
import { CommercialOrderLayout, OrderEquipmentSearch, OrderSection, OrderTotals } from "./commercial-order-layout"
import { OrderPendingReview, OrderQuickSummary, OrderSectionNavigation, focusOrderSection } from "./order-mobile-navigation"
import { orderedOrderIssues, type OrderIssue } from "./order-progress"
import { OrderDeliveryDestination, OrderDiscountFields, OrderFreightFields } from "./order-negotiation-fields"

type Selected = { line?: string; versionId?: string; productId: string; quantity: string; structureColor: string; swingArmColor: string; upholsteryColor: string; plateHolderColor: string; plateHolderType: string }
const selectClass = "h-9 min-h-9 min-w-0 rounded-lg border bg-background px-2"
const sectionHeadingClass = "scroll-mt-48 rounded-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring lg:scroll-mt-40"
const validOrderQuantity = (value: string) => /^\d{1,7}$/.test(value) && Number(value) >= 1 && Number(value) <= 1_000_000
function jumpTo(section: string) {
  const heading = document.getElementById(`simulator-${section}`)
  const disclosure = heading?.closest("details")
  if (disclosure) disclosure.open = true
  heading?.focus({ preventScroll: true })
  heading?.scrollIntoView({ block: "start" })
}

function pricingKey(input: { customerId?:string;channel?:string;versionId?: string; destinationState: string; taxpayer: boolean; discount: { kind: string; value: number }; freightCents: number; items: { productId: string; quantity: number; line?: string; versionId?: string }[] }) {
  return JSON.stringify([input.customerId,input.channel,input.versionId, input.destinationState, input.taxpayer, input.discount.kind, input.discount.value, input.freightCents, input.items.map(item => [item.productId, item.quantity, item.line, item.versionId])])
}
type SimulatorProps = { transferId?: string; initialLine: string; initialProduct: string; initialItems?: CommercialSelection[]; initialDestination?: string; initialTaxpayer?: boolean; initialOpportunity?: string; returnTo?: string; orderMode?: boolean }
export function CommercialSimulator(props: SimulatorProps) {
  return props.initialOpportunity ? <OpportunityContext {...props} id={props.initialOpportunity} /> : <SimulatorPage {...props} />
}
function SimulatorPage(props: SimulatorProps & { opportunity?: Opportunity; opportunityTenant?: string }) {
  return props.orderMode ? <MixedOrderPage {...props} /> : <SingleSimulatorPage {...props} />
}
function MixedOrderPage(props: SimulatorProps & { opportunity?: Opportunity; opportunityTenant?: string }) {
  const context = new URLSearchParams()
  if (props.initialDestination) context.set("destinationState", props.initialDestination)
  if (props.initialTaxpayer) context.set("taxpayer", "true")
  const suffix = context.size ? `?${context}` : ""
  const imported = useResource<PriceTable>(`/api/erp/commercial/tables/imported${suffix}`)
  const national = useResource<PriceTable>(`/api/erp/commercial/tables/national${suffix}`)
  const access = useResource<{ tenant: { id: string }; permissions: string[] }>("/api/erp/me")
  const tenantId = access.value?.tenant.id || ""
  const transferKey = tenantId + "/" + (props.transferId || "")
  const loaded = useMemo<{key: string; transfer: SimulationTransfer | null} | null>(() =>
    tenantId && props.transferId ? {key:transferKey, transfer:readSimulationTransfer(sessionStorage, props.transferId, tenantId)} : null,
  [tenantId, props.transferId, transferKey])
  const transfer = loaded?.key === transferKey ? loaded.transfer : null
  const foreign = [imported.value, national.value].some(table => table && table.tenantId !== tenantId)
  const table = useMemo(() => {
    const sources = [imported.value, national.value].filter((table): table is PriceTable => Boolean(table))
    if (!tenantId || !sources.length || sources.some(source => source.tenantId !== tenantId)) return null
    const warnings = [imported.error ? "Não foi possível consultar a tabela importada." : imported.value && !imported.value.data ? "Publique a tabela importada para incluir seus equipamentos." : "", national.error ? "Não foi possível consultar a tabela nacional." : national.value && !national.value.data ? "Publique a tabela nacional para incluir seus equipamentos." : ""].filter(Boolean)
    return mixedOrderTable(sources, tenantId, warnings)
  }, [imported.value, national.value, imported.error, national.error, tenantId])
  const loading = imported.loading || national.loading || access.loading || !!props.transferId && !!tenantId && loaded?.key !== transferKey
  const unavailable = access.error || (props.transferId && loaded?.key === transferKey && !transfer ? "A simulação venceu ou pertence a outra empresa. Reabra o simulador para transferi-la novamente." : "") || (foreign && tenantId ? "As tabelas não correspondem à empresa ativa." : "") || (props.opportunityTenant && props.opportunityTenant !== tenantId ? "A empresa da sessão mudou. Reabra a oportunidade." : "")
  return <main className="commercial-order-page space-y-4">
    {loading || unavailable || !table?.data ? <>
      <OrderPageHeading tenantId={tenantId} sale={null} pending={false} destinationState={props.initialDestination || ""} taxpayer={!!props.initialTaxpayer} />
      {loading ? <p role="status">Carregando tabelas publicadas…</p> : unavailable ? <p role="alert">{unavailable}</p> : <div role="status" className="space-y-3"><p>Nenhuma tabela publicada está disponível para este pedido.</p><Button variant="outline" onClick={() => { imported.reload(); national.reload(); access.reload() }}>Consultar tabelas novamente</Button></div>}
    </> : <>
      {props.opportunity && <p className="text-sm">Oportunidade: {props.opportunity.title}</p>}
      <Simulator key={transferKey} transfer={transfer} table={table} initialSourceLine={props.initialLine} initialProduct={props.initialProduct} initialItems={props.initialItems} initialDestination={props.initialDestination} initialTaxpayer={props.initialTaxpayer} opportunity={props.opportunity} onLineLockChange={ignoreLineLock} canCreate={table.canCreateOrder !== false && !!access.value?.permissions.includes("sales.orders.manage")} canManageCustomer={!!access.value?.permissions.includes("catalog.parties.manage")} orderMode lineControl={null} />
    </>}
  </main>
}
function ignoreLineLock() {}
function OpportunityContext({ id, ...props }: SimulatorProps & { id: string }) {
  const source = useResource<{ tenantId: string; data: Opportunity }>(`/api/erp/opportunities/${id}`)
  if (source.loading) return <main className="p-6"><p role="status">Carregando dados da oportunidade…</p></main>
  if (source.error || !source.value) return <main className="p-6"><p role="alert"><RequestError message={source.error || "Oportunidade indisponível"} status={source.status} /></p></main>
  return <SimulatorPage {...props} opportunity={source.value.data} opportunityTenant={source.value.tenantId} />
}
function SingleSimulatorPage({ initialLine, initialProduct, opportunity, opportunityTenant, returnTo, initialItems, initialDestination, initialTaxpayer, orderMode = false }: SimulatorProps & { opportunity?: Opportunity; opportunityTenant?: string }) {
  const [line, setLine] = useState(initialLine === "national" ? "national" : "imported")
  const [lineLocked, setLineLocked] = useState(false)
  const context = new URLSearchParams()
  if (initialDestination) context.set("destinationState", initialDestination)
  if (initialTaxpayer) context.set("taxpayer", "true")
  const table = useResource<PriceTable>(`/api/erp/commercial/tables/${line}${context.size ? `?${context}` : ""}`)
  const access = useResource<{ tenant: { id: string }; permissions: string[] }>("/api/erp/me")
  const canCreate = table.value?.canCreateOrder !== false && access.value?.tenant.id === table.value?.tenantId && !!access.value?.permissions.includes("sales.orders.manage")
  const canManageCustomer = access.value?.tenant.id === table.value?.tenantId && !!access.value?.permissions.includes("catalog.parties.manage")
  const lineControl = <label className="grid max-w-64 gap-1"><span>{orderMode ? "Tabela de preços" : "Linha comercial"}</span><select className={selectClass} disabled={lineLocked} value={line} onChange={e => { if (!document.querySelector("[data-simulation-dirty='true']") || window.confirm(orderMode ? "Trocar a tabela descarta os itens e os dados deste pedido. Continuar?" : "Descartar a simulação desta linha?")) setLine(e.target.value) }}><option value="imported">Importada</option><option value="national">Nacional</option></select></label>
  return <main className={orderMode ? "commercial-order-page space-y-4" : "mx-auto min-w-0 max-w-7xl space-y-3 px-4 pb-8 pt-4 [&_label]:text-xs"}>
    {orderMode ? <div className="order-page-heading"><Link href="/vendas/pedidos" className="text-primary underline">Voltar aos pedidos</Link><PageHeader title="Novo pedido" description="Monte a negociação e salve para confirmar depois." /><p className="text-xs text-muted-foreground">Em preenchimento · não salvo</p></div> : <PageHeader breadcrumbs={[{ label: "Vendas", href: "/vendas" }, { label: "Simulador comercial" }]} title="Simulador comercial" description="Confira preços, entrada e condições antes de criar um pedido." />}
    {opportunity && <section className="rounded-lg border p-4"><h2 className="font-semibold">{opportunity.title}</h2><p>{opportunity.customerName || opportunity.companyName} · {opportunity.contactName}</p><p className="whitespace-pre-wrap text-sm text-muted-foreground">{opportunity.notes}</p><Link className="text-primary underline" href={`/vendas/funil/${opportunity.id}`}>Abrir oportunidade de origem</Link></section>}
    {!orderMode && <><nav className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Navegação comercial"><Link className="text-primary underline" href={commercialTableReturn(returnTo, line)}>Tabela de preços</Link><Link className="text-primary underline" href="/vendas/pedidos">Pedidos</Link>{table.value?.canManage && <><Link className="text-primary underline" href={`/preferencias/comercial?linha=${line}`}>Parâmetros e metas</Link><Link className="text-primary underline" href="/preferencias/aprovacao-comercial">Regras de aprovação</Link></>}</nav>{lineControl}</>}
    {access.error && <p role="status" className="text-sm">Não foi possível conferir a permissão de criação. A simulação continua disponível. <Button variant="outline" onClick={access.reload}>Conferir acesso</Button></p>}
    {!access.loading && !access.error && !canCreate && <p className="text-sm text-muted-foreground">Seu acesso permite consultar e simular. Criar pedidos exige permissão de gestão de vendas.</p>}
    {table.loading ? <p role="status">Carregando versão publicada…</p> : table.error ? <div role="alert"><RequestError message={table.error} status={table.status} /><Button variant="outline" onClick={table.reload}>Tentar novamente</Button></div> : table.value && (opportunityTenant && opportunityTenant !== table.value.tenantId ? <p role="alert">A empresa da sessão mudou. Reabra a oportunidade.</p> : <Simulator key={`${line}:${table.value.tenantId}`} table={table.value} canCreate={canCreate} canManageCustomer={canManageCustomer} orderMode={orderMode} lineControl={lineControl} opportunity={opportunity} onLineLockChange={setLineLocked} initialItems={line === initialLine ? initialItems : undefined} initialDestination={initialDestination} initialTaxpayer={initialTaxpayer} initialProduct={line === initialLine ? initialProduct : ""} />)}
  </main>
}

function Simulator({ transfer, table: initialTable, initialSourceLine, initialProduct, initialItems, initialDestination, initialTaxpayer, opportunity, onLineLockChange, canCreate, canManageCustomer, orderMode, lineControl }: { transfer?: SimulationTransfer | null; table: PriceTable; initialProduct: string; initialItems?: CommercialSelection[]; initialDestination?: string; initialTaxpayer?: boolean; opportunity?: Opportunity; onLineLockChange: (locked: boolean) => void; canCreate: boolean; canManageCustomer: boolean; orderMode: boolean; lineControl: ReactNode; initialSourceLine?: string }) {
  const router = useRouter()
  const command = useCommand()
  const [updatedTable, setUpdatedTable] = useState<PriceTable | null>(null)
  const [reloading, setReloading] = useState(false)
  const table = updatedTable || initialTable
  const [items, setItems] = useState<Selected[]>(() => transfer ? transfer.input.items.map(item => ({...item, quantity:String(item.quantity), line:transfer.input.line,versionId:transfer.input.versionId,structureColor:item.structureColor||"",swingArmColor:item.swingArmColor||"",upholsteryColor:item.upholsteryColor||"",plateHolderColor:item.plateHolderColor||"",plateHolderType:item.plateHolderType||""})) : (initialItems?.length ? initialItems : initialProduct ? [{ productId: initialProduct, quantity: 1 }] : []).map(item => { const source = table.data?.items.find(price => price.productId === item.productId && (!orderMode || price.line === (initialSourceLine === "national" ? "national" : "imported"))); return { productId: item.productId, quantity: String(item.quantity), ...(orderMode ? { line: source?.line, versionId: source?.versionId } : {}), structureColor: "", swingArmColor: "", upholsteryColor: "", plateHolderColor: "", plateHolderType: "" } }))
  const productDetails = useOrderProductDetails(table.tenantId, items.map(item => item.productId), orderMode)
  const [destinationDraft, setDestination] = useState(transfer?.input.destinationState || initialDestination || table.data?.originState || "")
  const [taxpayer, setTaxpayer] = useState((transfer?.input.taxpayer ?? initialTaxpayer) ? "true" : "false")
  const [channel,setChannel]=useState(transfer?.input.channel || "")
  const [discount, setDiscount] = useState<{ kind: "percent" | "amount" | "total"; raw: string }>(transfer ? {kind:transfer.input.discount.kind,raw:inputAmount(transfer.input.discount.value)} : { kind: "percent", raw: "0" })
  const [freight, setFreight] = useState(transfer?.companyFreight ? inputAmount(transfer.input.freightCents) : "")
  const [ourFreight, setOurFreight] = useState(!!transfer?.companyFreight)
  const [downPayment, setDownPayment] = useState(transfer && transfer.input.downPaymentCents !== null ? inputAmount(transfer.input.downPaymentCents) : "")
  const [customer, setCustomer] = useState<Choice | null>(opportunity?.customerId ? { id: opportunity.customerId, legalName: opportunity.customerName || "Cliente da oportunidade" } : null)
  const [dueDate, setDueDate] = useState("")
  const [calculated, setResult] = useState<{ value: Simulation; input: NegotiationInput } | null>(null)
  const [pricedTotal, setPricedTotal] = useState<{ key: string; totalCents: number; minimumCents: number } | null>(null)
  const [acknowledgedQuote, setAcknowledgedQuote] = useState("")
  const [sourceResult,setSourceResult] = useState<{key:string;value:"same"|"changed"|"failed"}|null>(null)
  const [sourceRetry,setSourceRetry] = useState(0)
  const sourceKey = transfer ? transfer.digest+"/"+sourceRetry : ""
  const sourceCheck: "pending"|"same"|"changed"|"failed" = !transfer ? "same" : sourceResult?.key===sourceKey ? sourceResult.value : "pending"
  useEffect(()=>{
    if (!transfer) return
    const controller=new AbortController(), key=transfer.digest+"/"+sourceRetry
    erpFetch("/api/erp/commercial/simulate",{method:"POST",headers:{"Content-Type":"application/json","X-Tenant-Id":transfer.tenantId},body:JSON.stringify(transfer.input),signal:controller.signal}).then(async response=>{
      if(controller.signal.aborted)return
      if(response.status===409||response.status===412){setSourceResult({key,value:"changed"});return}
      if(!response.ok)throw Error()
      const checked=await response.json() as Simulation
      if(checked.tenantId!==transfer.tenantId||!/^[a-f0-9]{64}$/.test(checked.digest))throw Error()
      if(!controller.signal.aborted)setSourceResult({key,value:checked.digest===transfer.digest?"same":"changed"})
    }).catch(()=>{if(!controller.signal.aborted)setSourceResult({key,value:"failed"})})
    return ()=>controller.abort()
  },[transfer,sourceRetry])
  const checkout = useRef<CheckoutHandle>(null)
  const customerForm = useRef<OrderCustomerHandle>(null)
  const [proposalCustomerName, setProposalCustomerName] = useState("")
  const [proposalCheckout, setProposalCheckout] = useState<CheckoutProposalSnapshot>({ paymentTerms: "", deliveryTerms: "" })
  const pendingOrder = useRef<{ simulation: NegotiationInput; digest: string; dueDate: string; checkout: CheckoutInput } | null>(null)
  const converting = useRef(false)
  const [savingOrder, setSavingOrder] = useState(false)
  const [customerBusy, setCustomerBusy] = useState(false)
  const [customerUncertain, setCustomerUncertain] = useState(false)
  const [destinationManual, setDestinationManual] = useState(Boolean(transfer || initialDestination))
  const [taxpayerManual, setTaxpayerManual] = useState(Boolean(transfer || initialDestination))
  const [autoPendingKey, setAutoPendingKey] = useState("")
  const [quoteRetry, setQuoteRetry] = useState(0)
  const [quoteError, setQuoteError] = useState(false)
  const [quoteStale, setQuoteStale] = useState(Boolean(transfer && !initialTable.sources?.some(s=>s.line===transfer.input.line && s.data?.id===transfer.input.versionId)))
  const [dirty, setDirty] = useState(false)
  const [everCalculated, setEverCalculated] = useState(false)
  const [error, setError] = useState("")
  const [attempted, setAttempted] = useState(false)
  const [freightMode, setFreightMode] = useState(transfer?.companyFreight ? "company" : "customer")
  const [customerProgress, setCustomerProgress] = useState<{ issues: OrderIssue[]; addressState: string; customerId?:string }>({ issues: [{ field: "customer.taxId", section: "customer", message: "Selecione ou cadastre o cliente." }], addressState: "" })
  const [checkoutIssues, setCheckoutIssues] = useState<OrderIssue[]>([])
  const priceCustomer=orderMode?customerProgress.customerId:customer?.id
  const destination = orderMode && !destinationManual ? customerProgress.addressState || initialDestination || table.data?.originState || "" : destinationDraft
  const frozen = savingOrder || customerBusy || customerUncertain || reloading || command.busy || command.uncertain || command.stale
  const currentPriceKey = pricingKey({ customerId:priceCustomer,channel:channel||undefined,versionId: orderMode ? undefined : table.data?.id || "", destinationState: destination, taxpayer: taxpayer === "true", discount: { kind: discount.kind, value: parseAmount(discount.raw) ?? -1 }, freightCents: ourFreight ? parseAmount(freight) ?? -1 : 0, items: items.map(item => ({ productId: item.productId, quantity: Number(item.quantity), ...(orderMode ? { line: item.line, versionId: item.versionId } : {}) })) })
  const paymentTotal = pricedTotal?.key === currentPriceKey ? pricedTotal.totalCents : null
  const paymentEntry = paymentTotal === null ? null : downPayment.trim() ? parseAmount(downPayment) : pricedTotal!.minimumCents
  const sourcePrice = (item: Selected) => table.data?.items.find(source => source.productId === item.productId && (!orderMode || source.line === item.line && source.versionId === item.versionId))
  const unavailableItems = items.filter(item => !sourcePrice(item) || sourcePrice(item)?.available === false)
  useEffect(() => { onLineLockChange(frozen) }, [frozen, onLineLockChange])
  useNavigationGuard(dirty || command.uncertain ? "Sair sem concluir esta negociação?" : null)
  function change() { pendingOrder.current = null; if (!orderMode) setResult(null); setDirty(true); setError(""); setQuoteError(false); command.reset() }
  function simulationInput(): NegotiationInput {
    if (!table.data) throw Error("Publique uma tabela antes de simular.")
    if (unavailableItems.length) throw Error("Há equipamentos indisponíveis nesta tabela. Confira a seleção e remova esses itens explicitamente para continuar.")
    const value = parseAmount(discount.raw)
    const freightCents = ourFreight ? parseAmount(freight) : 0
    const entry = downPayment.trim() ? parseAmount(downPayment) : null
    if (value === null || freightCents === null || (downPayment.trim() && entry === null) || !items.length || items.some(i => !/^\d{1,7}$/.test(i.quantity) || Number(i.quantity) < 1 || Number(i.quantity) > 1000000)) throw Error("Confira quantidade, desconto, frete e entrada. Use até duas casas decimais para valores.")
    const base: Omit<SimulationInput, "line" | "versionId"> = { ...(priceCustomer?{customerId:priceCustomer}:{}),...(channel?{channel}:{}),destinationState: destination, taxpayer: taxpayer === "true", discount: { kind: discount.kind, value }, freightCents, downPaymentCents: entry, items: items.map(i => ({ productId: i.productId, quantity: Number(i.quantity), structureColor: i.structureColor || null, swingArmColor: i.swingArmColor || null, upholsteryColor: i.upholsteryColor || null, plateHolderColor: i.plateHolderColor || null, plateHolderType: i.plateHolderType || null })) }
    return orderMode ? { ...base, items: base.items.map((item, index) => ({ ...item, line: items[index].line!, versionId: items[index].versionId! })) } : { ...base, line: table.line, versionId: table.data.id }
  }
  const orderQuoteSignature = (() => { try { return JSON.stringify(simulationInput()) } catch { return "" } })()
  const result = calculated && JSON.stringify(calculated.input) === orderQuoteSignature ? calculated : null
  const changedTransfer = !!transfer && !!result && (sourceCheck==="changed" || result.value.sale.totalCents !== transfer.totalCents || JSON.stringify(result.value.sale.approvalReasons) !== JSON.stringify(transfer.approvalReasons)) && acknowledgedQuote !== result.value.digest
  const busy = !!orderQuoteSignature && autoPendingKey === orderQuoteSignature
  const entryIssue = checkoutEntryIssue(paymentTotal, downPayment)
  const invalidFreight = ourFreight && parseAmount(freight) === null
  const invalidDiscount = parseAmount(discount.raw) === null
  const discountField = discount.kind === "total" ? "discount.total" : "discount.percent"
  const invalidPricingField = entryIssue || invalidFreight || invalidDiscount || unavailableItems.length || items.some(item => !validOrderQuantity(item.quantity))
  const unfinishedEquipment = orderMode ? items.filter(item => requiredOrderFinishParts(item, productDetails.products[item.productId.toLowerCase()]).length > 0) : []
  const orderIssues = orderedOrderIssues([
    ...(!items.length ? [{ field: "equipment.search", section: "equipment" as const, message: "Adicione ao menos um equipamento." }] : []),
    ...items.filter(item => !validOrderQuantity(item.quantity)).map(item => ({ field: `equipment.quantity.${item.productId}`, section: "equipment" as const, message: `Confira a quantidade de ${table.data?.items.find(source => source.productId === item.productId)?.name || "equipamento"}.` })),
    ...(unavailableItems.length ? [{ field: "equipment.search", section: "equipment" as const, message: "Remova os equipamentos indisponíveis nesta tabela." }] : []),
    ...(unfinishedEquipment.length ? [{ field: `equipment.finishes.${unfinishedEquipment[0].productId}`, section: "equipment" as const, message: unfinishedEquipment.length === 1 ? `Escolha os acabamentos de ${sourcePrice(unfinishedEquipment[0])?.name || "equipamento"}.` : `Escolha os acabamentos de ${unfinishedEquipment.length} equipamentos.` }] : []),
    ...customerProgress.issues,
    ...(entryIssue ? [entryIssue] : []),
    ...checkoutIssues.filter(issue => issue.field !== "checkout.entry" || !!result && !entryIssue),
    ...(invalidFreight ? [{ field: "delivery.freight", section: "delivery" as const, message: "Informe o custo de frete por nossa conta." }] : []),
    ...(invalidDiscount ? [{ field: discountField, section: "discount" as const, message: discount.kind === "total" ? "Informe um valor negociado válido, com até duas casas decimais." : "Informe um desconto válido, com até duas casas decimais." }] : []),
    ...(items.length && !result && !invalidPricingField ? [{ field: discountField, section: "discount" as const, message: quoteStale ? "Atualize a tabela para conferir os valores." : busy ? "Aguarde o cálculo da negociação." : "Confira as condições para calcular o total." }] : []),
  ])
  function focusOrderIssue(issue: OrderIssue) {
    setAttempted(true)
    if (issue.field.startsWith("customer.")) { customerForm.current?.focus(issue.field.slice(9)); return }
    if (issue.field.startsWith("checkout.")) { checkout.current?.focus(issue.field.slice(9)); return }
    const target = issue.field === "equipment.search" ? document.getElementById("order-equipment-search") : document.querySelector<HTMLElement>(`[data-order-field="${issue.field}"]`)
    if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: "center" }); if (issue.field.startsWith("equipment.finishes.")) target.click() }
    else focusOrderSection(issue.section)
  }
  useEffect(() => {
    if (!orderQuoteSignature || command.busy || command.uncertain || command.stale || quoteStale || savingOrder || customerUncertain || reloading) return
    const input: NegotiationInput = JSON.parse(orderQuoteSignature)
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setAutoPendingKey(orderQuoteSignature); setError(""); setQuoteError(false)
      try {
        const response = await erpFetch((orderMode ? "/api/erp/commercial/mixed/simulate" : "/api/erp/commercial/simulate"), { method: "POST", headers: { "Content-Type": "application/json", "X-Tenant-Id": table.tenantId }, body: orderQuoteSignature, signal: controller.signal })
        const value: Simulation & { title?: string } = await response.json()
        if (!response.ok) { if (!controller.signal.aborted && [409, 412].includes(response.status)) setQuoteStale(true); throw Error(value.title || "Não foi possível calcular a negociação.") }
        if (value.tenantId !== table.tenantId || !/^[a-f0-9]{64}$/.test(value.digest) || !value.sale) throw Error("Resposta da simulação incompleta.")
        if (!controller.signal.aborted) { setPricedTotal({ key: pricingKey(input), totalCents: value.sale.totalCents, minimumCents: value.sale.minimumDownPaymentCents }); setResult({ value, input }); setEverCalculated(true) }
      } catch (reason) { if (!controller.signal.aborted) { setResult(null); setQuoteError(true); setError(reason instanceof Error ? reason.message : "Negociação indisponível.") } }
      finally { setAutoPendingKey(previous => previous === orderQuoteSignature ? "" : previous) }
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [orderMode, orderQuoteSignature, table.tenantId, table, quoteRetry, command.busy, command.uncertain, command.stale, quoteStale, savingOrder, customerUncertain, reloading])
  function continueOrder() {
    if (!result || !("versionId" in result.input) || !canCreate || quoteStale) return
    try {
      const key = crypto.randomUUID()
      saveSimulationTransfer(sessionStorage, key, {tenantId:table.tenantId, input:result.input, digest:result.value.digest,
        totalCents:result.value.sale.totalCents, approvalReasons:result.value.sale.approvalReasons, companyFreight:ourFreight})
      const query = new URLSearchParams({simulacao:key, linha:result.input.line, destinationState:result.input.destinationState, taxpayer:String(result.input.taxpayer)})
      if (opportunity) query.set("oportunidade", opportunity.id)
      setDirty(false)
      router.push("/vendas/pedidos/novo?"+query)
    } catch { setError("Não foi possível transferir a simulação nesta aba. Tente novamente.") }
  }
  async function convert() {
    if (!canCreate) return
    if (orderMode) {
      if (converting.current || command.busy || command.stale || reloading) return
      if (!command.uncertain && !customerUncertain) {
        setAttempted(true)
        if (changedTransfer || sourceCheck==="pending" || sourceCheck==="failed") return
        if (orderIssues.length) { setError("Confira as pendências indicadas antes de salvar."); focusOrderIssue(orderIssues[0]); return }
        if (!result || busy) { setError("Confira os valores calculados antes de salvar o pedido."); return }
        try {
          const details = customerForm.current?.read()
          const terms = checkout.current?.read()
          if (!details || !terms) throw Error("Confira os dados do cliente e as condições do pedido.")
          const orderDueDate = terms.installments[0]?.dueOn || dueDate || terms.entry.dueOn || paymentToday()
          pendingOrder.current = { simulation: result.input, digest: result.value.digest, dueDate: orderDueDate, checkout: { ...terms, stateRegistration: details.stateRegistration } }
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Confira o pedido."); return }
      }
      if (!pendingOrder.current) { setError("Não foi possível recuperar a confirmação. Preserve esta tela e confira o pedido antes de continuar."); return }
      converting.current = true; setSavingOrder(true); setError("")
      try {
        if (command.uncertain) {
          const value = await command.send<{ tenantId: string; id: string }>((orderMode ? "/api/erp/commercial/mixed/orders" : "/api/erp/commercial/orders"), table.tenantId, {}, "", "POST", reply => reply?.tenantId === table.tenantId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reply.id))
          if (value?.tenantId === table.tenantId && value.id) { setDirty(false); router.push(`/vendas/pedidos/${value.id}`) }
          return
        }
        const selected = await customerForm.current?.save()
        if (!selected) return
        const value = await command.send<{ tenantId: string; id: string }>((orderMode ? "/api/erp/commercial/mixed/orders" : "/api/erp/commercial/orders"), table.tenantId, { ...pendingOrder.current, customerId: selected.id, ...(opportunity ? { opportunityId: opportunity.id, opportunityRevision: opportunity.revision } : {}) }, "", "POST", reply => reply?.tenantId === table.tenantId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reply.id))
        if (value?.tenantId === table.tenantId && value.id) { setDirty(false); router.push(`/vendas/pedidos/${value.id}`) }
      } finally { converting.current = false; setSavingOrder(false) }
      return
    }
    if (!result || !customer || !dueDate) { setError("Selecione o cliente e informe o vencimento antes de criar o pedido."); return }
    let terms: CheckoutInput | undefined
    if (table.paymentMethods !== undefined && !command.uncertain) {
      try { terms = checkout.current?.read(); if (!terms) throw Error("Confira as condições do pedido.") }
      catch (reason) { setError(reason instanceof Error ? reason.message : "Confira as condições do pedido."); jumpTo("customer"); return }
    }
    const value = await command.send<{ tenantId: string; id: string }>((orderMode ? "/api/erp/commercial/mixed/orders" : "/api/erp/commercial/orders"), table.tenantId, { simulation: result.input, digest: result.value.digest, customerId: customer.id, dueDate, ...(terms ? { checkout: terms } : {}), ...(opportunity ? { opportunityId: opportunity.id, opportunityRevision: opportunity.revision } : {}) })
    if (value?.tenantId === table.tenantId && value.id) { setDirty(false); router.push(`/vendas/pedidos/${value.id}`) }
  }
  async function refreshTable() {
    if (reloading || command.busy || command.uncertain) return
    setReloading(true); setError("")
    try {
      if (orderMode) {
        const sources = await Promise.all(["imported", "national"].map(async line => {
          const response = await erpFetch(`/api/erp/commercial/tables/${line}`, { cache: "no-store" })
          const latest: PriceTable & { title?: string } = await response.json()
          if (!response.ok) throw Error(latest.title || "Não foi possível atualizar as tabelas.")
          if (latest.tenantId !== table.tenantId || latest.line !== line) throw Error("Confira a empresa das tabelas antes de continuar.")
          return latest
        }))
        const latest = mixedOrderTable(sources, table.tenantId, sources.filter(source => !source.data).map(source => `Publique a tabela ${source.line === "national" ? "nacional" : "importada"} para incluir seus equipamentos.`))
        setUpdatedTable(latest)
        setItems(current => current.map(item => {
          const source = latest.data?.items.find(product => product.productId === item.productId && product.line === item.line)
          return source ? { ...item, versionId: source.versionId } : item
        }))
        setResult(null); setPricedTotal(null); setQuoteStale(false); setQuoteError(false); command.reset()
        return
      }
      const response = await erpFetch(`/api/erp/commercial/tables/${table.line}`, { cache: "no-store" })
      const latest: PriceTable & { title?: string } = await response.json()
      if (!response.ok) throw Error(latest.title || "Não foi possível atualizar a tabela.")
      if (latest.tenantId !== table.tenantId || latest.line !== table.line || !latest.data) throw Error("A tabela não está disponível para esta negociação. Confira a empresa e a publicação.")
      setUpdatedTable(latest); setResult(null); setQuoteStale(false); setQuoteError(false); command.reset()
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível atualizar a tabela.") }
    finally { setReloading(false) }
  }
  if (!table.data) return <section className="form-section space-y-3">{orderMode && lineControl}<p>Nenhuma tabela publicada nesta linha.</p>{table.canManage ? <Link className="inline-flex min-h-11 items-center text-primary underline" href={`/preferencias/tabela-precos?linha=${table.line}`}>Publicar tabela de preços</Link> : <p className="text-sm text-muted-foreground">Peça à gestão para publicar a tabela desta linha.</p>}</section>
  if (orderMode) {
    const sale = result?.value.sale || null
    const quantityTotal = items.every(item => validOrderQuantity(item.quantity)) ? items.reduce((total, item) => total + Number(item.quantity), 0) : null
    const selectedTables = table.sources?.filter(source => source.data && (!items.length || items.some(item => item.line === source.line))) || [table]
    const ownLimit = Math.min(...selectedTables.map(source => source.data?.destinations?.find(rule => rule.state === destination && rule.taxpayer === (taxpayer === "true"))?.maxOwnDiscountBps ?? source.data?.freeDiscountBps ?? table.data!.freeDiscountBps))
    function markDirty() {
      if (!savingOrder && !customerUncertain && !command.uncertain) pendingOrder.current = null
      setDirty(true); setError("")
    }
    const focusSearch = () => {
      const search = document.getElementById("order-equipment-search")
      search?.focus({ preventScroll: true }); search?.scrollIntoView({ block: "center" })
    }
    const add = (productId: string, source?: PriceItem) => {
      if (frozen) return
      const existing = items.find(item => item.productId === productId)
      const selectedSource = source || table.data?.items.find(item => item.productId === productId)
      if (!selectedSource?.line || !selectedSource.versionId) return
      if (existing && (existing.line !== selectedSource.line || existing.versionId !== selectedSource.versionId)) { setError("Este equipamento já está no pedido por outra tabela. Remova-o antes de trocar a origem."); return }
      if (existing && (!validOrderQuantity(existing.quantity) || Number(existing.quantity) >= 1_000_000)) { setError("Confira a quantidade deste equipamento antes de acrescentar uma unidade."); return }
      if (!existing && items.length >= 100) { setError("O pedido aceita até 100 equipamentos diferentes."); return }
      setItems(current => existing ? current.map(item => item.productId === productId ? { ...item, quantity: String(Number(item.quantity) + 1) } : item) : [...current, { productId, line: selectedSource.line, versionId: selectedSource.versionId, quantity: "1", structureColor: "", swingArmColor: "", upholsteryColor: "", plateHolderColor: "", plateHolderType: "" }])
      change()
    }
    const saveBlocked = !canCreate ? "Seu acesso permite consultar; salvar exige permissão de gestão de vendas."
      : savingOrder || command.busy ? "Salvando o pedido. Aguarde a confirmação."
      : customerBusy ? "Conferindo o cadastro do cliente antes de salvar."
      : reloading ? "Atualizando a tabela. Aguarde o cálculo."
      : command.stale || quoteStale ? "Atualize a tabela e confira os valores antes de salvar."
      : busy && !command.uncertain && !customerUncertain ? "Calculando os valores da negociação. Aguarde." : ""
    const deliveryMethodNote = freightMode === "pickup" ? "Entrega: retirada pelo cliente." : freightMode === "company" ? "Entrega: frete por nossa conta, sem acréscimo ao total cobrado do cliente." : "Entrega: frete pago pelo cliente, contratado separadamente do pedido."
    return <div data-simulation-dirty={dirty} className="order-form-content">
      {transfer && <div role="status" className="rounded-lg border p-3 text-sm">Simulação transferida • Total original {money(transfer.totalCents)}{sourceCheck==="pending"&&<p>Conferindo a tabela e as regras da simulação…</p>}{sourceCheck==="failed"&&<p>Não foi possível conferir a simulação de origem. <Button variant="outline" onClick={()=>setSourceRetry(n=>n+1)}>Conferir novamente</Button></p>}{changedTransfer && result && <p>Condições atualizadas • Total atual {money(result.value.sale.totalCents)}. <Button variant="outline" onClick={()=>setAcknowledgedQuote(result.value.digest)}>Conferi os valores e a alçada</Button></p>}</div>}
      <SalesPriceChannel value={channel} disabled={frozen} onChange={v=>{setChannel(v);change()}}/>{sale&&<ItemPriceOrigins items={sale.items}/>}
      <OrderPageHeading tenantId={table.tenantId} sale={sale} pending={busy || reloading} destinationState={destination} taxpayer={taxpayer === "true"} dueDate={dueDate} customerName={proposalCustomerName} paymentTerms={proposalCheckout.paymentTerms} deliveryTerms={[deliveryMethodNote, proposalCheckout.deliveryTerms].filter(Boolean).join(" • ")} />
      <OrderSectionNavigation issues={orderIssues} />
      <CommercialCheckout
        ref={checkout} tenantId={table.tenantId} customerId={priceCustomer} methods={table.paymentMethods || []}
        totalCents={paymentTotal} entryCents={paymentEntry} entryRaw={downPayment}
        onEntryChange={raw => { setDownPayment(raw); change() }} dueDate={dueDate}
        onDueDateChange={date => { setDueDate(date); markDirty() }} onDirty={markDirty} disabled={frozen}
        onProgressChange={setCheckoutIssues} onProposalChange={setProposalCheckout} deliveryMethodNote={deliveryMethodNote}
        freightField={<OrderFreightFields mode={freightMode} value={freight} error={attempted ? orderIssues.find(issue => issue.field === "delivery.freight")?.message : undefined} onMode={mode => { setFreightMode(mode); setOurFreight(mode === "company"); change() }} onChange={value => { setFreight(value); change() }} />}
        renderOrder={({ payment, delivery }) => <CommercialOrderLayout
          equipment={<OrderSection id="order-equipment" title="Equipamentos" detail={quantityTotal === null ? "Confira as quantidades" : quantityTotal + " un."}>
            {table.sourceWarnings?.map(message => <p role="status" key={message} className="text-sm">{message} <Button type="button" variant="outline" disabled={frozen} onClick={refreshTable}>Atualizar tabelas</Button></p>)}
            <OrderEquipmentSearch items={table.data!.items} selected={items} tenantId={table.tenantId} disabled={frozen} onAdd={add} />
            {unavailableItems.length > 0 && <p role="alert" className="text-sm">Há equipamentos indisponíveis nesta versão. Remova os itens indicados para continuar.</p>}
            {items.length ? <OrderEquipmentList items={items} prices={table.data!.items} sale={sale} tenantId={table.tenantId} disabled={frozen} details={productDetails}
              onUpdate={(id, next) => { if (frozen) return; setItems(current => current.map(source => source.productId === id ? next : source)); change() }}
              onRemove={id => { if (frozen) return; setItems(current => current.filter(source => source.productId !== id)); change() }}
              onUpdateMany={updates => { if (frozen) return; const byId = new Map(updates.map(item => [item.productId, item])); setItems(current => current.map(item => byId.get(item.productId) || item)); change() }}
            /> : <div className="order-equipment-empty"><p>Nenhum equipamento ainda.</p><Button type="button" variant="outline" disabled={frozen} onClick={focusSearch}>Adicionar equipamento</Button></div>}
            {attempted && orderIssues.filter(issue => issue.section === "equipment").map(issue => <p key={issue.field} className="text-xs text-destructive">{issue.message}</p>)}
            <OrderWeightSummary tenantId={table.tenantId} loading={!!productDetails.loadingIds.length} unavailable={!!Object.keys(productDetails.errors).length} onRetry={() => productDetails.retry()} items={items.map(item => ({ ...item, equipmentWeight: productDetails.products[item.productId.toLowerCase()]?.weight ?? null, quantity: validOrderQuantity(item.quantity) ? String(Number(item.quantity)) : "" }))} />
          </OrderSection>}
          customer={<OrderCustomerForm initialCustomerId={transfer?.input.customerId || opportunity?.customerId || undefined} ref={customerForm} tenantId={table.tenantId} disabled={frozen}
            canManage={canCreate && canManageCustomer} onDirty={markDirty}
            onBusyChange={setCustomerBusy} onUncertainChange={setCustomerUncertain} onProgressChange={setCustomerProgress} onProposalNameChange={setProposalCustomerName}
            onDestinationChange={state => { if (!destinationManual && state !== destination) { setDestination(state); change() } }}
            onTaxpayerChange={value => { if (!taxpayerManual && String(value) !== taxpayer) { setTaxpayer(String(value)); change() } }} />}
          delivery={<><OrderDeliveryDestination destination={destination} addressState={customerProgress.addressState}
            originState={table.data!.originState} manual={destinationManual} disabled={frozen}
            onChange={state => { setDestinationManual(true); setDestination(state); change() }}
            onFollowAddress={() => { setDestinationManual(false); setDestination(customerProgress.addressState || table.data!.originState); change() }}
            taxpayer={taxpayer} taxpayerManual={taxpayerManual} onTaxpayerChange={value => { setTaxpayerManual(true); setTaxpayer(value); change() }} />{delivery}</>}
          discount={<OrderDiscountFields sale={sale} discount={discount} pending={busy} hasItems={!!items.length} disabled={frozen}
            percentError={attempted ? orderIssues.find(issue => issue.field === "discount.percent")?.message : undefined}
            totalError={attempted ? orderIssues.find(issue => issue.field === "discount.total")?.message : undefined}
            ownLimit={ownLimit} freeLimit={sale?.freeDiscountBps ?? table.data!.freeDiscountBps} authority={table.authority} onAdd={focusSearch}
            onPercent={raw => { setDiscount({ kind: "percent", raw }); change() }}
            onTotal={raw => { setDiscount(raw.trim() ? { kind: "total", raw } : { kind: "percent", raw: "0" }); change() }} />}
          payment={<OrderSection id="order-payment" title="Forma de pagamento" detail="Combinada com o cliente">{payment}</OrderSection>}
          totals={<OrderSection id="order-review" title="Revisão do pedido">
            <OrderTotals sale={sale} pending={busy} hasItems={!!items.length} />
            <p className="text-xs text-muted-foreground">{deliveryMethodNote}</p>
            <OrderPendingReview issues={orderIssues} onFocus={focusOrderIssue} attempted={attempted} />
          </OrderSection>}
          save={<>
            {(error || command.error) && <div role="alert" className="space-y-2 text-sm"><RequestError message={error || command.error} status={command.status || undefined} />{quoteError && !quoteStale && !frozen && !!items.length && <Button type="button" variant="outline" onClick={() => setQuoteRetry(value => value + 1)}>Calcular novamente</Button>}</div>}
            {(command.stale || quoteStale) && <Button type="button" variant="outline" disabled={reloading} onClick={refreshTable}>Atualizar tabela e calcular</Button>}
            {saveBlocked ? <p role="status" className="text-sm">{saveBlocked}</p> : orderIssues.length > 0 && !command.uncertain && !customerUncertain ? <p className="text-sm">Faltam dados para salvar. Toque em Salvar pedido para ir à primeira pendência.</p> : null}
            {(command.uncertain || customerUncertain) && <p role="status" className="text-sm">A confirmação está pendente. Confira o mesmo envio antes de editar ou sair.</p>}
            <Button type="button" disabled={!!saveBlocked || changedTransfer || sourceCheck==="pending" || sourceCheck==="failed"} onClick={convert}>{savingOrder || command.busy ? "Salvando…" : command.uncertain ? "Conferir criação do pedido" : customerUncertain ? "Conferir cadastro e salvar pedido" : "Salvar pedido"}</Button>
            <p className="text-xs text-muted-foreground">Salvar cria um pedido em rascunho com número. No detalhe, aceite a encomenda para gerar as parcelas e reserve o estoque quando estiver disponível. Recebimentos são registrados separadamente.</p>
          </>}
        />}
      />
      <OrderQuickSummary sale={sale} pending={busy} hasItems={!!items.length} issueCount={orderIssues.length} />
    </div>
  }
  return <div data-simulation-dirty={dirty} className="space-y-4 [--workspace-control-height:44px] sm:[--workspace-control-height:36px]">
    <div className="sticky top-[52px] z-20 space-y-1 border-y bg-background py-1 lg:top-16">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        {(error || command.error) ? <p role="alert" className="min-w-0 text-xs sm:text-sm"><RequestError message={error || command.error} status={command.status || undefined} /></p> : <p role="status" className="min-w-0 text-xs text-muted-foreground sm:text-sm">Tabela v{table.data.version} · {result ? "Calculada" : busy ? "Calculando…" : everCalculated ? "Atualizando condições" : "Simulação não salva"}</p>}
        <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={frozen || !items.length || quoteStale} onClick={()=>{try {simulationInput();const details=document.getElementById("simulator-customer")?.closest("details");if(details)details.open=true;setQuoteRetry(value=>value+1);jumpTo("result")} catch (reason) {setError(reason instanceof Error?reason.message:"Confira a seleção.");jumpTo("equipment")}}}>{busy?"Calculando…":"Simular"}</Button>{canCreate && <Button type="button" disabled={!result || frozen || quoteStale} onClick={continueOrder}>Continuar no novo pedido</Button>}</div>
      </div>
      <nav aria-label="Etapas da simulação" className={`grid ${canCreate?"grid-cols-4":"grid-cols-3"} gap-1 text-xs sm:text-sm`}>
        {[["equipment", "Equipamentos"], ["conditions", "Condições"], ["result", "Resultado"], ...(canCreate?[["customer","Cliente"]]:[])].map(([id, label]) => <a key={id} href={`#simulator-${id}`} className="flex min-h-11 min-w-0 items-center justify-center rounded-md px-1 font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring sm:min-h-9" onClick={event => { event.preventDefault(); jumpTo(id) }}>{label}</a>)}
      </nav>
    </div>
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] lg:gap-5">
      <div className="min-w-0 space-y-3"><fieldset disabled={frozen} className="form-section min-w-0 space-y-2 !p-3">
        <h2 id="simulator-equipment" tabIndex={-1} className={sectionHeadingClass}>Equipamentos</h2>
        {unavailableItems.length > 0 && <p role="alert" className="rounded-lg border p-2 text-xs">{unavailableItems.length} equipamento(s) da seleção não estão disponíveis nesta tabela. A seleção foi preservada. Remova os itens indisponíveis para continuar.</p>}
        <OrderEquipmentSearch items={table.data.items} selected={items} tenantId={table.tenantId} disabled={frozen} onAdd={productId => {
          const found = items.find(item=>item.productId === productId)
          if (found && (!validOrderQuantity(found.quantity) || Number(found.quantity) >= 1_000_000)) {setError("Confira a quantidade deste equipamento."); return}
          if (!found && items.length >= 100) {setError("A simulação aceita até 100 equipamentos."); return}
          setItems(current=>found ? current.map(item=>item.productId===productId?{...item,quantity:String(Number(item.quantity)+1)}:item) : [...current,{productId, quantity:"1",structureColor:"", swingArmColor:"", upholsteryColor:"",plateHolderColor:"",plateHolderType:""}])
          change()
        }}/>
        {items.length ? <DataTable aria-label="Equipamentos da simulação" className="table-fixed"><thead><tr className="border-b text-xs text-muted-foreground"><th scope="col" className="py-2 font-medium">Equipamento</th><th scope="col" className="w-20 px-1 py-2 font-medium">Qtd.</th><th scope="col" className="w-11 py-2"><span className="sr-only">Ações</span></th></tr></thead><tbody>{items.map((item, index) => <SelectedProduct key={item.productId} item={{ ...item, line: table.line }} name={table.data!.items.find(i => i.productId === item.productId)?.name || item.productId} sku={table.data!.items.find(i => i.productId === item.productId)?.sku || ""} tenant={table.tenantId} update={next => { setItems(items.map((i, n) => n === index ? next : i)); change() }} remove={() => { setItems(items.filter((_, n) => n !== index)); change() }} />)}</tbody></DataTable> : <p className="text-xs text-muted-foreground">Adicione equipamentos para iniciar.</p>}
        {!!items.length && <p className="text-xs text-muted-foreground">{items.length} equipamento{items.length !== 1 ? "s" : ""} · Cores e tipo de anilheiro em Acabamentos.</p>}
        <OrderWeightSummary tenantId={table.tenantId} items={items.map(item => ({ ...item, quantity: /^\d{1,7}$/.test(item.quantity) && Number(item.quantity) >= 1 && Number(item.quantity) <= 1_000_000 ? String(Number(item.quantity)) : "" }))} />
      </fieldset>
      <fieldset disabled={frozen} className="form-section min-w-0 space-y-2 !p-3">
        <h2 id="simulator-conditions" tabIndex={-1} className={sectionHeadingClass}>Condições comerciais</h2>
        <SalesPriceChannel value={channel} disabled={frozen} onChange={value=>{setChannel(value);change()}}/>

        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2 sm:grid-cols-2"><label className="grid min-w-0 gap-1 sm:gap-2">UF de destino<select className={selectClass} value={destination} onChange={e => { setDestination(e.target.value); change() }}>{states.map(uf => <option key={uf}>{uf}</option>)}</select></label><label className="grid min-w-0 gap-1 sm:gap-2">Inscrição estadual<select className={selectClass} value={taxpayer} onChange={e => { setTaxpayer(e.target.value); change() }}><option value="false">Não contribuinte</option><option value="true">Contribuinte</option></select></label></div>
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-2"><label className="grid min-w-0 gap-1 sm:gap-2">Preencher negociação por<select className={selectClass} value={discount.kind} onChange={e => { const kind = e.target.value as typeof discount.kind; const sale = result?.value.sale; setDiscount({ kind, raw: sale ? inputAmount(kind === "percent" ? sale.discountBps : kind === "amount" ? sale.discountCents : sale.totalCents) : kind === "total" ? "" : "0" }); change() }}><option value="percent">Desconto (%)</option><option value="amount">Desconto sem IPI (R$)</option><option value="total">Total com IPI (R$)</option></select></label>
        <label className="grid min-w-0 gap-1 sm:gap-2">{discount.kind === "percent" ? "Desconto (%)" : discount.kind === "amount" ? "Desconto em reais" : "Total que o cliente quer pagar"}<Input inputMode="decimal" value={discount.raw} onChange={e => { setDiscount({ ...discount, raw: e.target.value }); change() }} /></label></div>
        {discount.kind === "percent" && <input aria-label="Ajustar desconto percentual" type="range" min="0" max="99.99" step="0.01" className="w-full" value={(parseAmount(discount.raw) || 0) / 100} onChange={e => { setDiscount({ kind: "percent", raw: e.target.value }); change() }} />}
        <p className="text-sm">Livre até {percent(table.data.freeDiscountBps)}. Acima disso, exige aprovação.</p>
        {result && <p className="text-sm">Desconto calculado: {percent(result.value.sale.discountBps)} · {money(result.value.sale.discountCents)} sem IPI. Total: {money(result.value.sale.totalCents)}.</p>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={ourFreight} onChange={e => { setOurFreight(e.target.checked); change() }} />Frete por nossa conta</label>
        {ourFreight && <label className="grid min-w-0 gap-1 sm:gap-2">Frete pago pela empresa (R$)<Input inputMode="decimal" value={freight} onChange={e => { setFreight(e.target.value); change() }} /></label>}
        {(table.paymentMethods === undefined || !canCreate) && <><label className="grid min-w-0 gap-1 sm:gap-2"><span>Entrada negociada (R$)<span className="sr-only">, deixe vazia para usar a política</span></span><Input aria-describedby="simulator-entry-help" inputMode="decimal" value={downPayment} onChange={e => { setDownPayment(e.target.value); change() }} /></label><p id="simulator-entry-help" className="text-xs text-muted-foreground">Deixe a entrada vazia para usar a política comercial.</p></>}
      </fieldset>
      </div>
      <aside className="min-w-0 space-y-3 lg:sticky lg:top-48 lg:row-span-2 lg:max-h-[calc(100dvh-13rem)] lg:overflow-y-auto lg:overscroll-contain" aria-labelledby="simulator-result">
        <h2 id="simulator-result" tabIndex={-1} className={sectionHeadingClass}>Resultado</h2>
        {result ? <><ItemPriceOrigins items={result.value.sale.items}/><NegotiationResult sale={result.value.sale} director={result.value.director} context={result.input} /></> : <p className="rounded-lg border bg-background p-3 text-sm text-muted-foreground">{items.length ? "O cálculo acompanha os equipamentos e as condições." : "Adicione equipamentos para calcular preços e entrada."}</p>}
        {(command.stale || quoteStale) && <div className="space-y-2 rounded-lg border bg-background p-3 text-sm"><p>A tabela ou a política mudou. Atualize e confira os valores antes de criar o pedido.</p><Button variant="outline" className="h-auto min-h-10 whitespace-normal" disabled={reloading} onClick={refreshTable}>{reloading ? "Atualizando tabela…" : "Atualizar tabela e simular novamente"}</Button></div>}
      </aside>
      {canCreate && <details className="form-section min-w-0 space-y-3 !p-3 lg:col-start-1">
        <summary className="cursor-pointer"><h2 id="simulator-customer" tabIndex={-1} className={sectionHeadingClass}>Salvar diretamente com cliente e vencimento</h2></summary>
        <Lookup compact endpoint="parties" label="cliente" searchOnly selectedName={customer?.legalName} disabled={frozen} choose={value => { setCustomer(value); change() }} />
        {table.paymentMethods !== undefined ? <CommercialCheckout ref={checkout} tenantId={table.tenantId} customerId={customer?.id} methods={table.paymentMethods} totalCents={paymentTotal} entryCents={paymentEntry} entryRaw={downPayment} onEntryChange={raw => { setDownPayment(raw); change() }} dueDate={dueDate} onDueDateChange={date => { setDueDate(date); setDirty(true) }} onDirty={() => { setDirty(true); setError("") }} disabled={frozen} /> : <label className="grid min-w-0 gap-1 sm:gap-2">Vencimento da conta a receber<Input type="date" disabled={frozen} value={dueDate} onChange={e => { setDueDate(e.target.value); setDirty(true) }} /></label>}
        {result && <>
          {(!customer || !dueDate) && <p className="text-xs text-muted-foreground">Selecione o cliente e informe o vencimento para criar o pedido.</p>}
          <Button className="h-auto min-h-11 max-w-full whitespace-normal" disabled={!customer || !dueDate || busy || reloading || command.busy || command.stale} onClick={convert}>{command.uncertain ? "Conferir criação com o mesmo comando" : "Criar pedido com estas condições"}</Button>
          <p className="text-xs text-muted-foreground">{table.paymentMethods !== undefined ? "Depois de criar, aceite a encomenda para gerar as parcelas. Reserve os produtos quando houver estoque disponível." : "O pedido recebe um número. A confirmação seguinte reserva o estoque."}</p>
        </>}
      </details>}
    </div>
  </div>
}

type FinishResource = { value: { tenantId: string; data: Partial<Omit<ProductFinishes, "finishingPalette">> & { finishingPalette?: string | null } } | null; loading: boolean; error: string; status: number; reload: () => void }
type SelectedProductProps = { item: Selected; name: string; sku: string; tenant: string; update: (next: Selected) => void; remove: () => void; orderMode?: boolean; price?: PriceItem; priced?: Simulation["sale"]["items"][number]; disabled?: boolean; details?: FinishResource }

function SelectedProduct(props: SelectedProductProps) {
  return props.details ? <SelectedProductContent {...props} product={props.details} /> : <SelectedProductResource {...props} />
}

function SelectedProductResource(props: SelectedProductProps) {
  const product = useResource<{ tenantId: string; data: { structureColors?: string[]; swingArmColors?: string[]; finishingPalette?: string | null; upholsteryColors?: string[]; upholsteryConfigurable?: boolean; plateHolderColors?: string[]; plateHolderTypes?: string[] } }>(`/api/erp/products/${props.item.productId}`)
  return <SelectedProductContent {...props} product={product} />
}

function SelectedProductContent({ item, name, sku, tenant, update, remove, orderMode = false, price, priced, disabled = false, product }: SelectedProductProps & { product: FinishResource }) {
  const colors = product.value?.tenantId === tenant ? product.value.data : null
  const palette = catalogPaletteFor(item.line === "national" ? null : colors?.finishingPalette)
  const selectedFinishes = [item.structureColor, item.swingArmColor, item.upholsteryColor, item.plateHolderType].filter(Boolean).join(" · ")
  return <>
    <tr>
      <th scope="row" className="min-w-0 break-words py-3 pr-2 text-left align-top font-medium"><span className="block text-xs text-muted-foreground">{sku}</span>{name}</th>
      <td className="px-1 py-3 align-top"><div className={orderMode ? "order-quantity-control" : undefined}>{orderMode && <Button type="button" variant="outline" aria-label={`Diminuir quantidade de ${name}`} disabled={disabled || !/^\d+$/.test(item.quantity) || Number(item.quantity) <= 1} onClick={() => update({ ...item, quantity: String(Number(item.quantity) - 1) })}><Minus aria-hidden="true" /></Button>}<Input data-order-field={orderMode ? `equipment.quantity.${item.productId}` : undefined} aria-invalid={orderMode && !validOrderQuantity(item.quantity) || undefined} aria-label={`Quantidade de ${name}`} className="px-2 text-center tabular-nums" inputMode="numeric" maxLength={7} disabled={disabled} value={item.quantity} onChange={e => update({ ...item, quantity: e.target.value })} />{orderMode && <Button type="button" variant="outline" aria-label={`Aumentar quantidade de ${name}`} disabled={disabled || !/^\d+$/.test(item.quantity) || Number(item.quantity) >= 1_000_000} onClick={() => update({ ...item, quantity: String(Number(item.quantity) + 1) })}><Plus aria-hidden="true" /></Button>}</div></td>
      {orderMode && <><td className="align-top">{price ? money(price.priceWithoutIpiCents) : "Indisponível"}</td><td className="align-top">{priced ? money(priced.tableUnitCents * priced.quantity - priced.netCents) : "—"}</td><td className="align-top">{priced ? money(priced.totalCents) : "—"}</td></>}
      <td className="py-3 align-top"><Button variant="ghost" size="icon" type="button" disabled={disabled} aria-label={`Remover equipamento ${name}`} onClick={remove}><X aria-hidden="true" /></Button></td>
    </tr>
    <tr className="border-b last:border-0"><td colSpan={orderMode ? 6 : 3} className="min-w-0 pb-3">
      {product.error && <div className={orderMode ? "flex flex-wrap items-center gap-2 text-xs" : "space-y-2 rounded-lg border p-2 text-xs"}><p role="alert">{orderMode ? "Acabamentos indisponíveis" : <RequestError message={product.error} status={product.status} />}</p><Button type="button" variant="outline" disabled={product.loading} aria-label={`Recarregar acabamentos de ${name}`} onClick={product.reload}>{product.loading ? "Carregando acabamentos…" : orderMode ? "Tentar de novo" : "Recarregar acabamentos"}</Button></div>}
      {orderMode && product.loading && <p role="status" className="text-xs text-muted-foreground">Carregando acabamentos…</p>}
      {(!orderMode || !!colors && !product.error) && <details className="group min-w-0" onInvalidCapture={event => { event.currentTarget.open = true }}>
        <summary className="min-h-10 cursor-pointer rounded-md py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">Acabamentos<span className="sr-only"> de {name}</span><span className="ml-2 text-xs font-normal text-muted-foreground group-open:hidden">{selectedFinishes || (item.line === "national" ? "Tipo de anilheiro" : "Escolher cores")}</span></summary>
        <fieldset disabled={disabled} className="grid min-w-0 gap-4 pt-3 sm:grid-cols-2">
          {orderColorParts.map(color=>{
            const options=orderFinishOptions(item,colors?{structureColors:colors.structureColors,swingArmColors:colors.swingArmColors,upholsteryColors:colors.upholsteryColors,upholsteryConfigurable:colors.upholsteryConfigurable}:undefined,color)
            if(item.line === "national" || !options.length&&!item[color.field])return null
            return <FinishChoice key={color.field} title={color.title} part={color.part} palette={palette} label={color.label+" de "+name} options={options} value={item[color.field]} onChange={value=>update({...item,[color.field]:value})}/>
          })}
          <PlateHolderChoice label={`Tipo de anilheiro de ${name}`} value={item.plateHolderType} onChange={value=>update({...item,plateHolderType:value})}/>
          <div className="sm:col-span-2"><CatalogPaletteReference palette={palette} /></div>
        </fieldset>
      </details>}
    </td></tr>
  </>
}

function FinishChoice({ title, ...props }: Parameters<typeof ColorChoice>[0] & { title: string }) {
  return <div className="min-w-0 space-y-2 [&_label]:sr-only"><p className="text-sm font-medium">{title}</p><ColorChoice {...props} /></div>
}
