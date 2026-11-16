"use client"

import Link from "next/link"
import { useEffect, useId, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { erpFetch } from "@/lib/api/client"

export type NfePickerProduct = { id: string; sku: string; name: string; unit: string; ncm: string | null; basePrice: string }
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })

export function NfeProductPicker({ tenant, disabled, onSelect }: { tenant: string; disabled: boolean; onSelect: (product: NfePickerProduct) => void }) {
  const listId = useId()
  const root = useRef<HTMLDivElement>(null)
  const request = useRef<AbortController | null>(null)
  const [query, setQuery] = useState("")
  const [products, setProducts] = useState<NfePickerProduct[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [active, setActive] = useState(-1)
  const expanded = open && Boolean(query.trim()) && !disabled
  useEffect(() => {
    if (!query.trim() || disabled) return
    const controller = new AbortController()
    request.current = controller
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const response = await erpFetch(`/api/erp/products?status=active&limit=20&q=${encodeURIComponent(query.trim())}`, { cache: "no-store", signal: controller.signal })
        const value = await response.json()
        if (!response.ok) throw new Error(value.title || "Não foi possível buscar os produtos")
        if (value.tenantId !== tenant || !Array.isArray(value.data)) throw new Error("Reabra o rascunho para conferir a empresa")
        if (!controller.signal.aborted) setProducts(value.data)
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Falha na busca de produtos")
      } finally { if (!controller.signal.aborted) setLoading(false) }
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, tenant, disabled])
  useEffect(() => {
    if (!expanded) return
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener("pointerdown", outside)
    return () => document.removeEventListener("pointerdown", outside)
  }, [expanded])
  useEffect(() => { if (expanded && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" }) }, [expanded, active, listId])
  function choose(product: NfePickerProduct) {
    request.current?.abort()
    onSelect(product)
    setOpen(false); setQuery(""); setProducts([]); setActive(-1); setLoading(false)
  }
  return <div ref={root} className="rounded-xl border p-4" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <div className="relative">
      <label className="grid min-w-0 gap-2 text-sm">Buscar produto por nome ou SKU<Input role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-controls={listId} aria-expanded={expanded} aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined} autoComplete="off" disabled={disabled} value={query} onFocus={() => setOpen(true)} onChange={event => { request.current?.abort(); setQuery(event.target.value); setProducts([]); setError(""); setLoading(Boolean(event.target.value.trim())); setActive(-1); setOpen(true) }} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); setOpen(false); return }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); setOpen(true)
          if (products.length) setActive(previous => event.key === "ArrowDown" ? Math.min(previous + 1, products.length - 1) : Math.max(previous - 1, 0))
        }
        if (event.key === "Enter") { event.preventDefault(); if (expanded && active >= 0 && products[active]) choose(products[active]); else setOpen(true) }
      }} /></label>
      {expanded && <div className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
        {loading ? <p role="status" className="p-3 text-sm">Buscando produtos…</p> : error ? <p role="alert" className="p-3 text-sm text-destructive">{error}</p> : !products.length ? <p role="status" className="p-3 text-sm">Nenhum produto encontrado.</p> : null}
        <ul id={listId} role="listbox" aria-label="Produtos encontrados" className="max-h-[min(18rem,40dvh)] overflow-y-auto overscroll-contain">
          {!loading && !error && products.map((product, index) => <li key={product.id} role="presentation"><button id={`${listId}-${index}`} role="option" aria-selected={active === index} type="button" tabIndex={-1} className={`flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-accent focus-visible:bg-accent ${active === index ? "bg-accent" : ""}`} onPointerDown={event => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => choose(product)}><span className="min-w-0 break-words">{product.name}<span className="text-xs text-muted-foreground"> • {product.sku}</span></span><span className="shrink-0 whitespace-nowrap font-semibold tabular-nums">{product.basePrice?.trim() && Number.isFinite(Number(product.basePrice)) ? currency.format(Number(product.basePrice)) : "Preço não informado"}</span></button></li>)}
        </ul>
      </div>}
    </div>
    <Link className="mt-3 inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4" href="/cadastros/produtos/novo" target="_blank" rel="noopener noreferrer">Cadastrar produto</Link>
  </div>
}
