"use client"

import { useId, useRef, useState, type MouseEvent } from "react"
import { ChevronDown, ChevronUp, Minus, Palette, Plus, RotateCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DataTable } from "@/components/workspace/data-table"
import { catalogPaletteFor } from "@/features/catalog/catalog-color-photo-model"
import { CatalogColorSwatch } from "@/features/catalog/catalog-color-picker"
import { money, type PriceItem, type Sale } from "./negotiation-types"
import { orderColorParts, orderEquipmentAmounts, orderEquipmentPrice, orderEquipmentQuantity, requiredOrderFinishParts, type SelectedOrderItem } from "./order-equipment-model"
import { OrderFinishesPanel, type OrderFinishesItem } from "./order-finishes-panel"
import { commercialQuantity } from "./order-presentation"
import type { useOrderProductDetails } from "./order-product-details"
import { orderEquipmentWeight } from "./order-weight-model"
import "./order-equipment-list.css"

export type { SelectedOrderItem } from "./order-equipment-model"

type OrderEquipmentListProps = {
  items: SelectedOrderItem[]
  prices: PriceItem[]
  sale: Sale | null
  tenantId: string
  disabled: boolean
  details: ReturnType<typeof useOrderProductDetails>
  onUpdate: (productId: string, next: SelectedOrderItem) => void
  onRemove: (productId: string) => void
  onUpdateMany: (updates: SelectedOrderItem[]) => void
}

const searchKey = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLocaleLowerCase("pt-BR")

export function OrderEquipmentList(props: OrderEquipmentListProps) {
  return <EquipmentList key={props.tenantId} {...props} />
}

function EquipmentList({ items, prices, sale, disabled, details, onUpdate, onRemove, onUpdateMany }: OrderEquipmentListProps) {
  const [filter, setFilter] = useState("")
  const [collapsed, setCollapsed] = useState(false)
  const [activeProductId, setActiveProductId] = useState<string | null>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const listId = useId()
  const long = items.length >= 8
  const expanded = !long || !collapsed
  const query = long ? searchKey(filter) : ""
  const simulatedById = new Map(sale?.items.map(item => [item.productId, item]))
  const rows = items.map(item => {
    const id = item.productId.toLowerCase()
    const price = orderEquipmentPrice(item, prices)
    const product = details.products[id]
    return {
      item, product, issue: details.errors[id], sku: price?.sku || "",
      name: price?.name || product?.name || "Equipamento indisponível",
      unavailable: !price || price.available === false,
      amounts: orderEquipmentAmounts(item, price, simulatedById.get(item.productId)),
    }
  })
  const showSimulation = Boolean(sale && sale.items.length === rows.length && rows.every(row => row.amounts.simulatedLineCents !== null))
  const failedCount = rows.filter(row => row.issue).length
  const visibleRows = query ? rows.filter(row => searchKey(`${row.name} ${row.sku}`).includes(query)) : rows
  const tableSum = rows.reduce<number | null>((total, { amounts }) => total === null || amounts.tableLineCents === null ? null : total + amounts.tableLineCents, 0)
  const weight = !expanded ? orderEquipmentWeight(rows.map(({ item, product }) => ({
    quantity: String(orderEquipmentQuantity(item.quantity) ?? ""), weight: product?.weight,
  }))) : null

  function openFinishes(productId: string, event: MouseEvent<HTMLButtonElement>) {
    opener.current = event.currentTarget
    setActiveProductId(productId)
  }

  if (!items.length) return null
  return <div className="order-equipment-list" ref={area} tabIndex={-1} data-long-list={long || undefined}>
    {long && <div className="order-equipment-list-tools" data-expanded={expanded}>
      {expanded && <Input type="search" aria-label="Filtrar equipamentos do pedido" placeholder="Filtrar itens do pedido" autoComplete="off"
        maxLength={160} value={filter} onChange={event => setFilter(event.target.value)} />}
      <Button type="button" variant="outline" aria-expanded={expanded} aria-controls={listId} onClick={() => setCollapsed(expanded)}>
        {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        {expanded ? "Recolher lista" : `Exibir ${items.length} equipamentos`}
      </Button>
      {!expanded && <p className="order-equipment-list-summary">
        {details.loadingIds.length ? "Consultando peso…" : weight?.totalKg == null ? "Peso incompleto" : `Peso ${commercialQuantity(weight.totalKg)} kg`}
        {" • "}{tableSum === null || !Number.isSafeInteger(tableSum) ? "Total de tabela incompleto" : `Total de tabela ${money(tableSum)}`}
      </p>}
    </div>}
    {failedCount > 1 && <div className="order-equipment-list-error">
      <p role="status">Acabamentos indisponíveis em {failedCount} equipamentos.</p>
      <Button type="button" variant="outline" onClick={() => details.retry()}>Tentar de novo para todos</Button>
    </div>}
    <div id={listId} hidden={!expanded}>
      {!visibleRows.length ? <p className="order-equipment-list-empty" role="status">Nenhum equipamento do pedido corresponde ao filtro.</p> :
        <DataTable role="table" aria-label="Equipamentos do pedido" className="order-equipment-compact-table" data-simulated={showSimulation}>
          <colgroup>
            <col /><col className="order-equipment-quantity-column" />
            <col className="order-equipment-price-column" />
            {showSimulation && <col className="order-equipment-price-column" />}
            <col className="order-equipment-price-column" />
            <col className="order-equipment-actions-column" />
          </colgroup>
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader" scope="col">Equipamento</th>
              <th role="columnheader" scope="col" className="order-equipment-quantity-heading">Qtd.</th>
              <th role="columnheader" scope="col" className="order-equipment-price-heading">{showSimulation ? "Valor unit. s/ IPI" : "Valor unit. de tabela s/ IPI"}</th>
              {showSimulation && <th role="columnheader" scope="col" className="order-equipment-price-heading">Desconto</th>}
              <th role="columnheader" scope="col" className="order-equipment-price-heading">{showSimulation ? "Total c/ IPI" : "Total de tabela c/ IPI"}</th>
              <th role="columnheader" scope="col"><span className="sr-only">Ações</span></th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {visibleRows.map(row => <tr role="row" className="order-equipment-compact-row" key={row.item.productId}>
              <th role="rowheader" scope="row" className="order-equipment-identity-cell">
                <div className="order-equipment-identity">
                  <strong title={row.name}>{row.name}</strong>
                  {(row.sku || row.unavailable) && <small title={row.sku}>{[row.sku, row.unavailable && "Fora da tabela"].filter(Boolean).join(" • ")}</small>}
                </div>
                <FinishAction row={row} onOpen={event => openFinishes(row.item.productId, event)} retry={() => details.retry(row.item.productId)} />
              </th>
              <td role="cell" className="order-equipment-quantity-cell"><Quantity row={row} disabled={disabled} onChange={quantity => onUpdate(row.item.productId, { ...row.item, quantity })} /></td>
              <EquipmentAmount column="unit" label={showSimulation ? "Unit." : "Unit. tabela"} cents={row.amounts.tableUnitCents} />
              {showSimulation && <EquipmentAmount column="discount" label="Desconto" cents={row.amounts.discountCents} />}
              <EquipmentAmount column="total" label={showSimulation ? "Total" : "Total tabela"}
                cents={showSimulation ? row.amounts.simulatedLineCents : row.amounts.tableLineCents} />
              <td role="cell" className="order-equipment-remove-cell">
                <Button type="button" variant="ghost" size="icon" disabled={disabled} aria-label={`Remover equipamento ${row.name}`}
                  onClick={() => onRemove(row.item.productId)}><X aria-hidden="true" /></Button>
              </td>
            </tr>)}
          </tbody>
        </DataTable>}
    </div>
    <OrderFinishesPanel rows={rows} activeIndex={rows.findIndex(row => row.item.productId === activeProductId)} products={details.products}
      disabled={disabled} finalFocus={() => opener.current?.isConnected ? opener.current : area.current} onNavigate={setActiveProductId}
      onClose={() => setActiveProductId(null)} onUpdate={onUpdate} onUpdateMany={onUpdateMany} retry={details.retry} />
  </div>
}

function FinishAction({ row, onOpen, retry }: { row: OrderFinishesItem; onOpen: (event: MouseEvent<HTMLButtonElement>) => void; retry: () => void }) {
  const id = useId()
  const { item, name, issue, product } = row
  if (issue) return <div className="order-equipment-finishes">
    <Button type="button" variant="ghost" className="order-equipment-finishes-action" onClick={retry}
      data-order-field={`equipment.finishes.${item.productId}`}
      aria-label={`Recarregar acabamentos de ${name}`} aria-describedby={id} title={issue}>
      <RotateCw aria-hidden="true" /><span className="order-equipment-short-text">Acabamentos indisponíveis</span>
    </Button>
    <span className="sr-only" id={id}>{issue}</span>
  </div>
  if (!product) return <div className="order-equipment-finishes order-equipment-finish-loading" aria-busy="true">
    <span className="order-equipment-short-text">Carregando acabamentos…</span>
  </div>

  const colors = orderColorParts.filter(({ field }) => item[field])
  const chips: { title: string; name: string; part?: typeof orderColorParts[number]["part"] }[] = colors.map(({ field, title, part }) => ({ title, name: item[field], part }))
  if (item.plateHolderType && item.plateHolderType !== "Não se aplica") chips.push({ title: "Anilheiro", name: item.plateHolderType })
  const descriptions = chips.map(chip => `${chip.title} • ${chip.name}`).join(". ")
  const palette = catalogPaletteFor(product.finishingPalette)
  const pending = requiredOrderFinishParts(item, product).length > 0

  return <div className="order-equipment-finishes">
    <Button type="button" variant="ghost" className="order-equipment-finishes-action" aria-haspopup="dialog"
      data-order-field={`equipment.finishes.${item.productId}`} data-pending={pending || undefined}
      aria-label={`Acabamentos de ${name}`} aria-describedby={chips.length || pending ? id : undefined} title={descriptions || "Escolher acabamentos"} onClick={onOpen}>
      <Palette aria-hidden="true" />
      {chips.length ? <span className="order-equipment-chips" aria-hidden="true">
        {chips.slice(0, 2).map(chip => <span className="order-equipment-chip" key={chip.title}>
          {chip.part && <CatalogColorSwatch name={chip.name} palette={palette} part={chip.part} />}
          <span className="order-equipment-short-text">{chip.name}</span>
        </span>)}
        {chips.length > 2 && <span className="order-equipment-extra-chips">+{chips.length - 2}</span>}
        {chips.length > 1 && <span className="order-equipment-extra-chips-mobile">+{chips.length - 1}</span>}
      </span> : <span className="order-equipment-short-text">Escolher acabamentos</span>}
      {pending && <span className="order-equipment-finish-required" aria-hidden="true">Pendente</span>}
    </Button>
    {(chips.length > 0 || pending) && <span className="sr-only" id={id}>{descriptions}{pending && " • Escolha os acabamentos disponíveis antes de salvar"}</span>}
  </div>
}

function Quantity({ row, disabled, onChange }: { row: OrderFinishesItem; disabled: boolean; onChange: (quantity: string) => void }) {
  const { item, name } = row
  const quantity = /^\d+$/.test(item.quantity) ? Number(item.quantity) : null
  return <div className="order-equipment-compact-quantity">
    <Button type="button" variant="outline" size="icon" aria-label={`Diminuir quantidade de ${name}`}
      disabled={disabled || quantity === null || quantity <= 1} onClick={() => { if (quantity !== null) onChange(String(quantity - 1)) }}><Minus aria-hidden="true" /></Button>
    <Input data-order-field={`equipment.quantity.${item.productId}`} aria-invalid={orderEquipmentQuantity(item.quantity) === null || undefined} aria-label={`Quantidade de ${name}`}
      inputMode="numeric" maxLength={7} disabled={disabled} value={item.quantity} onChange={event => onChange(event.target.value)} />
    <Button type="button" variant="outline" size="icon" aria-label={`Aumentar quantidade de ${name}`}
      disabled={disabled || quantity === null || quantity >= 1_000_000} onClick={() => { if (quantity !== null) onChange(String(quantity + 1)) }}><Plus aria-hidden="true" /></Button>
  </div>
}

function EquipmentAmount({ column, label, cents }: { column: "unit" | "discount" | "total"; label: string; cents: number | null }) {
  return <td role="cell" className="order-equipment-amount" data-column={column}>
    <small aria-hidden="true">{label}</small><span>{cents === null ? "Indisponível" : money(cents)}</span>
  </td>
}
