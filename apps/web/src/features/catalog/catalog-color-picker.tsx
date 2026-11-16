"use client"

import { useEffect, useRef, useState } from "react"
import { Select } from "@base-ui/react/select"
import { ChevronDown, Check } from "lucide-react"
import { catalogColorPhoto, type CatalogPalette } from "./catalog-color-photo-model"
import { catalogFinishGroups, type CatalogFinishPart } from "./catalog-finish-palettes"
import "./catalog-color-picker.css"

export function CatalogColorSwatch({ name, palette, part }: { name: string; palette?: CatalogPalette; part: CatalogFinishPart }) {
  const photo = catalogColorPhoto(name, palette, part)
  if (!photo) return null
  const scale = 46 / photo.width
  return <span className="catalog-color-swatch-frame" aria-hidden="true"><span data-catalog-color-photo className="catalog-color-swatch" style={{ width: 46, height: photo.height * scale, backgroundImage: `url("${photo.asset}")`, backgroundRepeat: "no-repeat", backgroundSize: `${photo.sourceWidth * scale}px ${photo.sourceHeight * scale}px`, backgroundPosition: `${-photo.x * scale}px ${-photo.y * scale}px` }} /></span>
}
export const colorGroupTitles = { standard: "Padrão", special: "Especiais do catálogo", other: "Outras opções cadastradas" }

/** Base UI owns listbox keyboard navigation, dismissal, focus and native required input. */
export function CatalogColorPicker({ id, label, options, value, onChange, disabled = false, required = false, placeholder, palette, part }: { id: string; label: string; options: readonly string[]; value: string; onChange: (value: string) => void; disabled?: boolean; required?: boolean; placeholder: string; palette?: CatalogPalette; part: CatalogFinishPart }) {
  const trigger = useRef<HTMLButtonElement>(null)
  // Keep the registered choice while editing • removing it mid-click shifts list indices.
  const [registeredValue] = useState(value)
  const [open, setOpen] = useState(false)
  const [fieldsetDisabled, setFieldsetDisabled] = useState(false)
  const groups = catalogFinishGroups(palette, part, [...new Set(options)])
  const historical = !!value && !options.includes(value)
  const historicalNames = [...new Set([registeredValue, value].filter(name => name && !options.includes(name)))]
  useEffect(() => {
    const ancestors: HTMLFieldSetElement[] = []
    for (let node = trigger.current?.parentElement; node; node = node.parentElement) if (node instanceof HTMLFieldSetElement) ancestors.push(node)
    const update = () => { const locked = ancestors.some(fieldset => fieldset.disabled); setFieldsetDisabled(locked); if (locked) setOpen(false) }
    update()
    const observer = new MutationObserver(update)
    ancestors.forEach(fieldset => observer.observe(fieldset, { attributes: true, attributeFilter: ["disabled"] }))
    return () => observer.disconnect()
  }, [])
  const unavailable = disabled || fieldsetDisabled
  return <div data-color-picker className="min-w-0">
    <Select.Root value={value} onValueChange={next => { if (!unavailable) onChange(next ?? "") }} required={required} disabled={unavailable} open={open && !unavailable} onOpenChange={setOpen} modal={false}>
      <Select.Trigger id={id} ref={trigger} aria-label={label} className="catalog-color-trigger"><CatalogColorSwatch name={value} palette={palette} part={part} /><span className="catalog-color-name">{value || placeholder}{historical && <span className="block text-xs text-muted-foreground">Seleção registrada</span>}</span><ChevronDown aria-hidden="true" className="size-4 shrink-0" /></Select.Trigger>
      <Select.Portal><Select.Positioner align="start" sideOffset={4} collisionPadding={12} alignItemWithTrigger={false} className="catalog-color-positioner"><Select.Popup className="catalog-color-popup" finalFocus={trigger}><Select.List aria-label={label} className="catalog-color-list">
        <Select.Item value="" label={placeholder} className="catalog-color-option"><Select.ItemText>{placeholder}</Select.ItemText><Select.ItemIndicator className="ml-auto"><Check className="size-4" /></Select.ItemIndicator></Select.Item>
        {historicalNames.map(name => <Select.Item key={name} value={name} label={name} className="catalog-color-option"><Select.ItemText>{name} • seleção registrada</Select.ItemText><Select.ItemIndicator className="ml-auto"><Check className="size-4" /></Select.ItemIndicator></Select.Item>)}
        {(["standard", "special", "other"] as const).map(group => groups[group].length > 0 && <Select.Group key={group}><Select.GroupLabel className="catalog-color-group-label">{colorGroupTitles[group]}</Select.GroupLabel>{groups[group].map(name => <Select.Item key={name} value={name} label={name} className="catalog-color-option"><CatalogColorSwatch name={name} palette={palette} part={part} /><Select.ItemText className="catalog-color-name">{name}</Select.ItemText><Select.ItemIndicator className="ml-auto"><Check className="size-4" /></Select.ItemIndicator></Select.Item>)}</Select.Group>)}
      </Select.List></Select.Popup></Select.Positioner></Select.Portal>
    </Select.Root>
  </div>
}
