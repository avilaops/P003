"use client"

import { useRef, useState } from "react"
import { ChevronLeft, ChevronRight, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { catalogPaletteFor } from "@/features/catalog/catalog-color-photo-model"
import { CatalogPaletteReference } from "@/features/catalog/catalog-color-photos"
import { ColorChoice, PlateHolderChoice } from "./orders"
import { compatibleOrderFinishUpdates, orderColorParts, orderFinishOptions, type SelectedOrderItem } from "./order-equipment-model"
import type { ProductFinishes } from "./order-product-details"

export type OrderFinishesItem = {
  item: SelectedOrderItem
  name: string
  sku: string
  product?: ProductFinishes
  issue?: string
}

type OrderFinishesPanelProps = {
  rows: OrderFinishesItem[]
  activeIndex: number
  products: Record<string, ProductFinishes>
  disabled: boolean
  finalFocus: () => HTMLElement | null
  onNavigate: (productId: string) => void
  onClose: () => void
  onUpdate: (productId: string, next: SelectedOrderItem) => void
  onUpdateMany: (updates: SelectedOrderItem[]) => void
  retry: (productId: string) => void
}

export function OrderFinishesPanel({ rows, activeIndex, products, disabled, finalFocus, onNavigate, onClose, onUpdate, onUpdateMany, retry }: OrderFinishesPanelProps) {
  const body = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [feedback, setFeedback] = useState<ReturnType<typeof compatibleOrderFinishUpdates> | null>(null)
  const row = rows[activeIndex]

  function navigate(offset: number) {
    const next = rows[activeIndex + offset]
    if (!next) return
    setFeedback(null)
    onNavigate(next.item.productId)
    body.current?.scrollTo({ top: 0 })
  }

  function applyColors() {
    if (!row?.product || disabled || row.item.line === "national") return
    const applied = compatibleOrderFinishUpdates(row.item, rows.map(({ item }) => item), products)
    if (applied.updates.length) onUpdateMany(applied.updates)
    setFeedback(applied)
  }

  const palette = catalogPaletteFor(row?.product?.finishingPalette)
  const choices = row?.product ? orderColorParts.map(color => ({
    color, options: orderFinishOptions(row.item, row.product, color), value: row.item[color.field],
  })).filter(({ options, value }) => options.length || value) : []
  const canApplyColors = rows.length > 1 && choices.some(({ value }) => value)

  return <Sheet open={Boolean(row)} onOpenChange={open => {
    if (!open) { setFeedback(null); onClose() }
  }}>
    <SheetContent className="order-finishes-sheet" showCloseButton={false} initialFocus={close} finalFocus={finalFocus}>
      {row && <>
        <header className="order-finishes-header">
          <div className="order-finishes-title">
            <SheetTitle>Acabamentos</SheetTitle>
            <SheetClose render={<Button ref={close} type="button" variant="ghost" size="icon" aria-label="Fechar acabamentos" />}><X aria-hidden="true" /></SheetClose>
          </div>
          <SheetDescription className="order-finishes-product" aria-live="polite">
            {row.name}{row.sku && ` • ${row.sku}`} • {activeIndex + 1} de {rows.length}
          </SheetDescription>
          {rows.length > 1 && <nav className="order-finishes-navigation" aria-label="Navegar pelos equipamentos">
            <Button type="button" variant="outline" aria-label="Item anterior" aria-disabled={activeIndex === 0} onClick={() => navigate(-1)}><ChevronLeft aria-hidden="true" />Anterior</Button>
            <Button type="button" variant="outline" aria-label="Próximo item" aria-disabled={activeIndex === rows.length - 1} onClick={() => navigate(1)}>Próximo<ChevronRight aria-hidden="true" /></Button>
          </nav>}
        </header>
        <div className="order-finishes-body" ref={body}>
          {row.product ? <>
            <fieldset key={row.item.productId} className="order-finishes-choices" disabled={disabled}>
              {choices.length === 0 && <p className="text-sm text-muted-foreground">Sem cores disponíveis.</p>}
              {choices.map(({ color, options, value }) => <div key={color.field} className="order-finishes-choice">
                <p aria-hidden="true">{color.title}</p>
                <ColorChoice
                  part={color.part} palette={palette} label={`${color.label} de ${row.name}`} options={options} value={value}
                  onChange={next => { if (!disabled) onUpdate(row.item.productId, { ...row.item, [color.field]: next }) }}
                />
              </div>)}
              <PlateHolderChoice label={`Tipo de anilheiro de ${row.name}`} value={row.item.plateHolderType}
                onChange={value => { if (!disabled) onUpdate(row.item.productId, { ...row.item, plateHolderType: value }) }} />
            </fieldset>
            {choices.length > 0 && <CatalogPaletteReference palette={palette} />}
            {canApplyColors && <Button type="button" variant="outline" className="order-finishes-apply" disabled={disabled} onClick={applyColors}>Aplicar estas cores a todos os itens compatíveis</Button>}
            <div className="order-finishes-feedback" role="status">
              {feedback && <p>{feedback.updates.length === 1 ? "Cores aplicadas a 1 equipamento." : feedback.updates.length > 1 ? `Cores aplicadas a ${feedback.updates.length} equipamentos.` : "Nenhum equipamento teve cores alteradas."}
                {feedback.skipped.length > 0 && ` ${feedback.skipped.length} ${feedback.skipped.length === 1 ? "equipamento tem" : "equipamentos têm"} partes sem a cor selecionada ou dados indisponíveis.`}</p>}
            </div>
            {feedback && feedback.skipped.length > 0 && <details className="order-finishes-skipped">
              <summary>Ver partes sem alteração</summary>
              <ul>{feedback.skipped.map(({ productId, parts }) => <li key={productId}>{rows.find(({ item }) => item.productId === productId)?.name} • {parts.join(", ")}</li>)}</ul>
            </details>}
          </> : row.issue ? <div className="order-finishes-error">
            <p role="alert">{row.issue}</p>
            <Button type="button" variant="outline" onClick={() => retry(row.item.productId)}>Recarregar acabamentos</Button>
          </div> : <p role="status">Carregando acabamentos…</p>}
        </div>
      </>}
    </SheetContent>
  </Sheet>
}
