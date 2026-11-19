"use client"

import { useEffect, useState } from "react"
import { erpFetch } from "@/lib/api/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { money, percent, parseAmount, inputAmount, type PriceTable, type MixedSimulationInput } from "./negotiation-types"
import {SalesPriceChannel,ItemPriceOrigins} from "./price-channel"
import { proposalFiscalLabel, proposalSimulationInput, type ProposalCustomer, type ProposalEquipment, type ProposalCommercial, type ProposalQuote, type ProposalPricingState } from "./proposal-commercial-model"

type Props = { entryCents?:number; tenantId: string; customerId?: string; items: ProposalEquipment[]; initial?: ProposalCommercial; disabled: boolean; onChange: (state: ProposalPricingState) => void }
const states = "AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO".split(" ")
const selectClass = "h-9 min-w-0 rounded-lg border bg-background px-2"

export function ProposalCommercialFields({ tenantId, customerId, items, initial, disabled, onChange,entryCents }: Props) {
  const [channel,setChannel]=useState(initial?.input.channel??"")
  const [customer, setCustomer] = useState<ProposalCustomer | null>(null)
  const [mode, setMode] = useState<MixedSimulationInput["discount"]["kind"]>(initial?.input.discount.kind || "percent")
  const [discount, setDiscount] = useState(initial ? inputAmount(initial.input.discount.value) : "0")
  const [freight, setFreight] = useState(inputAmount(initial?.input.freightCents || 0))
  const [destination, setDestination] = useState(initial?.input.destinationState || "")
  const [state, setState] = useState<ProposalPricingState>({ status: "loading" })
  const [reload, setReload] = useState(0)
  const signature = JSON.stringify(items.map(({ id, quantity, structureColor, swingArmColor, plateHolderColor, plateHolderType, upholsteryColor }) => ({ id, quantity, structureColor, swingArmColor, plateHolderColor, plateHolderType, upholsteryColor })))
  useEffect(() => {
    if (!customerId || !items.length) { onChange({ status: "generic" }); return }
    const controller = new AbortController()
    onChange({ status: "loading" })
    async function read<T>(url: string): Promise<T> {
      const response = await erpFetch(url, { signal: controller.signal })
      const body = await response.json()
      if (!response.ok) throw Error(body.title || "Não foi possível consultar a cotação")
      if (body.tenantId !== tenantId) throw Error("A empresa mudou. Recarregue a proposta antes de negociar.")
      return body as T
    }
    const timer = setTimeout(() => {
      setState({ status: "loading" })
      void (async () => {
        const buyer = (await read<{ data: ProposalCustomer }>(`/api/erp/parties/${customerId}`)).data
        const uf = destination || buyer.addresses?.find(address => address.primary)?.state || buyer.addresses?.[0]?.state
        const condition = buyer.personType === "juridica" && buyer.fiscal?.taxpayerIndicator === "1" && Boolean(buyer.fiscal.stateRegistration)
        const query = new URLSearchParams({ taxpayer: String(condition), ...(uf ? { destinationState: uf } : {}) })
        const tables = await Promise.all(["national", "imported"].map(line => read<PriceTable>(`/api/erp/commercial/tables/${line}?${query}`)))
        const value = parseAmount(discount), freightCents = parseAmount(freight)
        if (value === null || freightCents === null || mode === "percent" && value >= 10000) throw Error("Confira o desconto e o frete. O desconto deve preservar um valor positivo.")
        const input = proposalSimulationInput(JSON.parse(signature), tables, {...buyer,id:customerId}, { ...(channel?{channel}:{}),destinationState: uf || tables.find(table => table.data)?.data?.originState || "SP", discount: { kind: mode, value }, freightCents, downPaymentCents: entryCents??initial?.input.downPaymentCents ?? null })
        let next: ProposalPricingState
        if (!input) next = { status: "generic" }
        else {
          const response = await erpFetch("/api/erp/commercial/mixed/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: controller.signal })
          const quoted = await response.json()
          if (!response.ok || quoted.tenantId !== tenantId) throw Error(quoted.title || "Não foi possível calcular esta cotação")
          next = { status: "ready", quote: { simulation: input, digest: quoted.digest, sale: quoted.sale, director: quoted.director } as ProposalQuote }
        }
        if (!controller.signal.aborted) { setCustomer(buyer); setState(next); onChange(next) }
      })().catch(reason => {
        if (!controller.signal.aborted) { const next: ProposalPricingState = { status: "error", message: reason instanceof Error ? reason.message : "Cotação indisponível" }; setState(next); onChange(next) }
      })
    }, 180)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [tenantId, customerId, signature, destination, mode, discount, freight, initial, channel,entryCents,reload, onChange, items.length])

  if (!customerId || !items.length) return null
  if (state.status === "generic") return null
  const quote = state.status === "ready" ? state.quote : null
  const destinations = [...new Set(customer?.addresses?.map(address => address.state).filter(Boolean))]
  return <section className="min-w-0 space-y-2 rounded-lg border p-3" aria-label="Cotação comercial do orçamento">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">Cotação comercial</h2>{customer && <p className="text-xs text-muted-foreground">{proposalFiscalLabel(customer)}</p>}</div>
    <SalesPriceChannel value={channel} disabled={disabled} onChange={setChannel}/>{quote&&<ItemPriceOrigins items={quote.sale.items}/>}
    <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
      <label className="grid min-w-0 gap-1 text-xs">UF de entrega<select className={selectClass} disabled={disabled} value={destination || customer?.addresses?.find(address => address.primary)?.state || customer?.addresses?.[0]?.state || "SP"} onChange={event => setDestination(event.target.value)}>{(destinations.length ? destinations : states).map(state => <option key={state}>{state}</option>)}</select></label>
      <label className="grid min-w-0 gap-1 text-xs">Forma de negociação<select className={selectClass} disabled={disabled} value={mode} onChange={event => { setMode(event.target.value as typeof mode); setDiscount("0") }}><option value="percent">Desconto percentual</option><option value="amount">Desconto em reais</option><option value="total">Total desejado</option></select></label>
      <label className="grid min-w-0 gap-1 text-xs">{mode === "percent" ? "Desconto (%)" : mode === "amount" ? "Desconto (R$)" : "Total desejado (R$)"}<Input className="h-9" inputMode="decimal" disabled={disabled} value={discount} onChange={event => setDiscount(event.target.value)} /></label>
      <label className="grid min-w-0 gap-1 text-xs">Frete por nossa conta (R$)<Input className="h-9" inputMode="decimal" disabled={disabled} value={freight} onChange={event => setFreight(event.target.value)} /></label>
    </div>
    {state.status === "loading" && <p role="status" className="text-xs">Calculando a cotação…</p>}
    {state.status === "error" && <div className="space-y-2"><p role="alert" className="text-sm">{state.message}</p><Button type="button" variant="outline" size="sm" onClick={() => setReload(value => value + 1)}>Tentar novamente</Button></div>}
    {quote && <><p className="text-sm font-semibold" role="status">Total calculado: {money(quote.sale.totalCents)}</p><p className="text-xs">Desconto sem aprovação: até {percent(Math.min(quote.sale.freeDiscountBps, quote.sale.maximumAtTargetDiscountBps ?? quote.sale.freeDiscountBps))}.</p>{quote.sale.approvalReasons.length > 0 && <p className="text-sm" role="status">Requer aprovação da gestão antes do envio ou conversão.</p>}{quote.director && <details className="text-xs"><summary className="cursor-pointer py-1">Composição financeira • Diretoria</summary><dl className="mt-2 grid grid-cols-2 gap-1"><dt>Custo dos equipamentos</dt><dd>{money(quote.director.equipmentCostCents)}</dd><dt>Tributos e despesas variáveis</dt><dd>{money(quote.director.taxesCents)}</dd><dt>DIFAL</dt><dd>{money(quote.director.difalCents)}</dd><dt>Lucro líquido calculado</dt><dd>{money(quote.director.netProfitCents)}</dd></dl></details>}</>}
  </section>
}
