"use client"

import { useId } from "react"
import { Popover } from "@base-ui/react/popover"
import { ChevronDown } from "lucide-react"
import { catalogColorPhoto, type CatalogPalette } from "./catalog-color-photo-model"
import { catalogFinishGroups, catalogPaletteSources, type CatalogFinishPart } from "./catalog-finish-palettes"
import { CatalogColorPicker, CatalogColorSwatch, colorGroupTitles } from "./catalog-color-picker"

type CatalogColorPhotosProps = {
  label: string; options?: readonly string[]; value?: string; onChange?: (value: string) => void
  disabled?: boolean; palette?: CatalogPalette; part: CatalogFinishPart; readOnly?: boolean; showSource?: boolean
}

export function CatalogPaletteReference({ palette }: { palette?: CatalogPalette }) {
  const sources = catalogPaletteSources(palette)
  return sources.length ? <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">{sources.map((source, index) => <span key={source.asset}>{index > 0 && <span aria-hidden="true">• </span>}<a className="underline underline-offset-2" href={source.asset} target="_blank" rel="noreferrer">Ver paleta original e combinações • {source.title}, {source.printedPage ? `pág. ${source.printedPage}` : `PDF pág. ${source.pdfPage}`}</a></span>)}</div> : null
}

/** Read-only catalog information stays compact; the complete original list lives in a portal. */
export function CatalogColorPhotos({ label, options, value = "", onChange, disabled, palette, part, readOnly = false, showSource = true }: CatalogColorPhotosProps) {
  const id = useId()
  const names = [...new Set(options ?? [])]
  if (!names.length) return null
  const groups = catalogFinishGroups(palette, part, names)
  const hasPhotos = names.some(name => catalogColorPhoto(name, palette, part))
  return <div className="min-w-0 space-y-2" role="group" aria-label={`${label}: ${hasPhotos ? "fotos do catálogo DHZ" : "opções de acabamento"}`}>
    {readOnly ? <Popover.Root><Popover.Trigger disabled={disabled} aria-label={`Ver opções de ${label}`} className="catalog-color-trigger"><CatalogColorSwatch name={names[0]} palette={palette} part={part} /><span className="catalog-color-name">{names.length} opções • ver cores</span><ChevronDown aria-hidden="true" className="size-4 shrink-0" /></Popover.Trigger><Popover.Portal><Popover.Positioner align="start" sideOffset={4} collisionPadding={12} className="catalog-color-positioner"><Popover.Popup aria-label={`Cores de ${label}`} className="catalog-color-popup"><div role="list" aria-label={`Opções de ${label}`} tabIndex={0} className="catalog-color-list">{(["standard", "special", "other"] as const).map(group => groups[group].length > 0 && <div key={group} role="presentation"><p className="catalog-color-group-label">{colorGroupTitles[group]}</p>{groups[group].map(name => <div role="listitem" key={name} className="catalog-color-readonly-row"><CatalogColorSwatch name={name} palette={palette} part={part} /><span className="catalog-color-name">{name}</span></div>)}</div>)}</div></Popover.Popup></Popover.Positioner></Popover.Portal></Popover.Root> : <CatalogColorPicker id={id} label={label} options={names} value={value} onChange={next => onChange?.(next)} disabled={disabled || !onChange} placeholder="Escolha uma cor" palette={palette} part={part} />}
    {showSource && hasPhotos && <CatalogPaletteReference palette={palette} />}
  </div>
}
