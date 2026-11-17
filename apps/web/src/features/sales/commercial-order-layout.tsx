"use client"

import { Combobox } from "@base-ui/react/combobox"
import { Plus, Search } from "lucide-react"
import { useMemo, useRef, useState, type ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { ProductThumbnail } from "@/features/catalog/product-thumbnail"
import { money, percent, type PriceItem, type Sale } from "./negotiation-types"
import "./commercial-order.css"

export function OrderSection({ title, detail, children, className = "", id }: { title: string; detail?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return <section id={id} className={`order-section ${className}`} aria-label={title}><div className="order-section-heading"><h2 tabIndex={-1}>{title}</h2>{detail && <div className="order-section-detail">{detail}</div>}</div><div className="order-section-body">{children}</div></section>
}

export function CommercialOrderLayout({ equipment, customer, delivery, payment, discount, totals, save }: { equipment: ReactNode; customer: ReactNode; delivery: ReactNode; payment: ReactNode; discount: ReactNode; totals: ReactNode; save: ReactNode }) {
  return <div className="commercial-order-layout">
    <div className="order-equipment-area">{equipment}</div>
    <div className="order-customer-area"><div id="order-customer">{customer}</div><section id="order-delivery" aria-label="Entrega e condições" className="order-delivery-area">{delivery}</section></div>
    <div className="order-discount-area">{discount}</div>
    <div className="order-payment-area">{payment}</div>
    <aside className="order-negotiation-area" aria-label="Revisão e totais">{totals}<section className="order-save-area" aria-label="Salvar pedido">{save}</section></aside>
  </div>
}

function normalizeEquipmentSearch(value: string) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR").trim()
}

export function OrderEquipmentSearch({ items, selected, tenantId, disabled, onAdd }: {
  items: PriceItem[]
  selected: Pick<PriceItem, "productId" | "line" | "versionId">[]
  tenantId: string
  disabled: boolean
  onAdd: (id: string, source?: PriceItem) => void
}) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const catalog = useMemo(() => items
    .filter(item => item.available !== false)
    .map(item => ({ item, search: normalizeEquipmentSearch(`${item.name} ${item.sku}`) })), [items])
  const matches = useMemo(() => {
    const words = normalizeEquipmentSearch(query).split(/\s+/).filter(Boolean)
    return catalog.filter(entry => words.every(word => entry.search.includes(word))).map(entry => entry.item)
  }, [catalog, query])
  const selectedByProduct = new Map(selected.map(item => [item.productId, item]))
  const atLimit = selected.length >= 100

  function blockedReason(item: PriceItem) {
    const existing = selectedByProduct.get(item.productId)
    if (existing && (existing.line !== item.line || existing.versionId !== item.versionId)) return "Já incluído por outra tabela"
    if (!existing && atLimit) return "Limite de 100 equipamentos"
  }

  function add(item: PriceItem) {
    if (disabled || blockedReason(item)) return
    onAdd(item.productId, item)
    setQuery("")
    list.current?.scrollTo({ top: 0 })
    input.current?.focus({ preventScroll: true })
  }

  return <div className="order-equipment-search">
    <Combobox.Root<PriceItem>
      filteredItems={matches}
      inputValue={query}
      onInputValueChange={setQuery}
      value={null}
      itemToStringLabel={item => item.name}
      disabled={disabled}
      open={open && !disabled}
      onOpenChange={setOpen}
      onValueChange={(item, event) => {
        // Cada escolha é uma ação de inclusão, sem registrar um valor no campo de busca.
        event.cancel()
        if (item) add(item)
      }}
      autoComplete="off"
    >
      <label htmlFor="order-equipment-search">Buscar equipamento</label>
      <div className="order-equipment-field">
        <Search aria-hidden="true" />
        <Combobox.Input
          render={<Input className="order-equipment-input" />}
          ref={input}
          id="order-equipment-search"
          type="search"
          maxLength={160}
          placeholder="Nome ou código"
          onFocus={() => setOpen(true)}
          onKeyDown={event => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return
            event.preventDefault()
            if (event.currentTarget.getAttribute("aria-activedescendant")) return
            event.preventBaseUIHandler()
            if (open && query.trim() && matches.length === 1) add(matches[0])
          }}
        />
      </div>
      <Combobox.Portal>
        <Combobox.Positioner className="order-equipment-positioner" align="start" sideOffset={6} collisionPadding={8}>
          <Combobox.Popup className="order-equipment-results">
            <div className="order-equipment-results-heading">
              <Combobox.Status>{matches.length ? `${matches.length} ${matches.length === 1 ? "equipamento" : "equipamentos"}` : "Nenhum equipamento encontrado."}</Combobox.Status>
              {matches.length > 0 && <span>Preço com IPI</span>}
            </div>
            <Combobox.List ref={list} className="order-equipment-list" aria-label="Equipamentos encontrados">
              {(item: PriceItem) => {
                const reason = blockedReason(item)
                const line = item.line === "national" ? "Nacional" : item.line === "imported" ? "Importada" : ""
                const hint = reason || (selectedByProduct.has(item.productId) ? "Acrescentar 1 un." : "")
                return <Combobox.Item
                  value={item}
                  key={`${item.productId}:${item.line}:${item.versionId}`}
                  className="order-equipment-option"
                  disabled={Boolean(reason)}
                >
                  <span className="order-equipment-thumbnail"><ProductThumbnail id={item.productId} name={item.name} tenantId={tenantId} decorative /></span>
                  <span className="order-equipment-option-copy">
                    <strong>{item.name}</strong>
                    <small>{[item.sku, line].filter(Boolean).join(" • ")}</small>
                    {hint && <small className="order-equipment-option-hint">{hint}</small>}
                  </span>
                  <span className="order-equipment-option-price">{money(item.priceWithIpiCents)}</span>
                  {!reason && <Plus className="order-equipment-option-add" aria-hidden="true" />}
                </Combobox.Item>
              }}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  </div>
}

export function OrderTotals({ sale, pending, hasItems }: { sale: Sale | null; pending: boolean; hasItems: boolean }) {
  const amount = (value: number | undefined) => value === undefined ? hasItems ? "—" : money(0) : money(value)
  if (!hasItems) return <section className="order-totals" aria-label="Totais do pedido"><p>Adicione equipamentos para calcular.</p></section>
  return <section className="order-section order-totals" aria-label="Totais do pedido" aria-busy={pending}>
    <dl>
      <div><dt>Total de tabela</dt><dd>{amount(sale?.tableTotalCents)}</dd></div>
      <div><dt>Desconto ({percent(sale?.discountBps || 0)})</dt><dd>− {amount(sale?.discountCents)}</dd></div>
      <div className="order-total-strong"><dt>Valor sem IPI</dt><dd>{amount(sale?.netSaleCents)}</dd></div>
      <div><dt>IPI{sale?.ipiBps != null ? ` (${percent(sale.ipiBps)})` : sale ? " por item" : ""}</dt><dd>{amount(sale?.ipiCents)}</dd></div>
      <div className="order-total-final"><dt>Total do pedido</dt><dd>{amount(sale?.totalCents)}</dd></div>
      <div><dt>Entrada{sale && sale.totalCents > 0 ? ` (${percent(Math.round(sale.downPaymentCents * 10000 / sale.totalCents))})` : " (0%)"}</dt><dd>{amount(sale?.downPaymentCents)}</dd></div>
      <div><dt>Saldo</dt><dd>{amount(sale ? sale.totalCents - sale.downPaymentCents : undefined)}</dd></div>
    </dl>
    {sale && <p>Frete por nossa conta: {money(sale.freightCents)}. Custo da empresa, sem acréscimo ao total do pedido.</p>}
    {pending && <p role="status">Calculando negociação…</p>}
    {!pending && hasItems && !sale && <p role="status">Confira os campos para calcular os valores.</p>}
  </section>
}
