"use client"

import { useEffect, useState } from "react"
import { erpFetch } from "@/lib/api/client"

export type ProductFinishes = {
  id: string
  name: string
  structureColors: string[]
  swingArmColors: string[]
  finishingPalette: string
  upholsteryColors: string[]
  upholsteryConfigurable: boolean
  plateHolderColors: string[]
  plateHolderTypes: string[]
  weight: string | null
}

type DetailsState = {
  tenantId: string
  selection: string
  products: Record<string, ProductFinishes>
  errors: Record<string, string>
}
const guid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
const empty = (tenantId: string, selection = ""): DetailsState => ({ tenantId, selection, products: {}, errors: {} })

function isProductFinishes(value: unknown): value is ProductFinishes {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return typeof row.id === "string" && guid.test(row.id) && typeof row.name === "string"
    && typeof row.finishingPalette === "string" && typeof row.upholsteryConfigurable === "boolean"
    && (row.weight === null || typeof row.weight === "string")
    && ["structureColors", "swingArmColors", "upholsteryColors", "plateHolderColors", "plateHolderTypes"]
      .every(key => Array.isArray(row[key]) && (row[key] as unknown[]).every(color => typeof color === "string"))
}

export function useOrderProductDetails(tenantId: string, ids: string[], enabled = true) {
  const signature = [...new Set(ids.map(id => id.toLowerCase()))].sort().join(",")
  const [state, setState] = useState<DetailsState>(() => empty(tenantId, signature))
  let scoped = state
  if (state.tenantId !== tenantId || state.selection !== signature) {
    const scope = new Set(signature.split(","))
    const previous = state.tenantId === tenantId ? state : empty(tenantId)
    scoped = {
      tenantId, selection: signature,
      products: Object.fromEntries(Object.entries(previous.products).filter(([id]) => scope.has(id))),
      errors: Object.fromEntries(Object.entries(previous.errors).filter(([id]) => scope.has(id))),
    }
    // Reset only when the input scope changes, before children can see old data.
    setState(scoped)
  }
  const missingSignature = enabled ? signature.split(",").filter(id => id && !scoped.products[id] && !scoped.errors[id]).join(",") : ""

  useEffect(() => {
    if (!missingSignature) return
    const missing = missingSignature.split(",")

    const controller = new AbortController()
    const currentRequest = (snapshot: DetailsState) => snapshot.tenantId === tenantId && !controller.signal.aborted
      && missing.every(id => snapshot.selection.split(",").includes(id))
    const timer = setTimeout(async () => {
      try {
        if (missing.length > 100 || missing.some(id => !guid.test(id))) throw Error("Seleção de equipamentos inválida")
        const response = await erpFetch(`/api/erp/products/finishes?ids=${encodeURIComponent(missing.join(","))}`, {
          headers: { "X-Tenant-Id": tenantId }, cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        })
        const body: { tenantId?: unknown; data?: unknown; missingIds?: unknown; title?: unknown } = await response.json()
        if (!response.ok) throw Error(typeof body.title === "string" ? body.title : "Acabamentos indisponíveis")
        if (body.tenantId !== tenantId || !Array.isArray(body.data) || !body.data.every(isProductFinishes)
          || !Array.isArray(body.missingIds) || !body.missingIds.every(id => typeof id === "string" && guid.test(id))) throw Error("Resposta de acabamentos inválida ou de outra empresa")
        const rows = body.data as ProductFinishes[]
        const notFound = (body.missingIds as string[]).map(id => id.toLowerCase())
        const received = [...rows.map(row => row.id.toLowerCase()), ...notFound]
        if (received.length !== missing.length || new Set(received).size !== received.length || received.some(id => !missing.includes(id))) throw Error("Resposta de acabamentos incompleta")
        if (controller.signal.aborted) return
        setState(previousState => !currentRequest(previousState) ? previousState : {
          ...previousState,
          products: { ...previousState.products, ...Object.fromEntries(rows.map(row => [row.id.toLowerCase(), { ...row, id: row.id.toLowerCase() }])) },
          errors: { ...previousState.errors, ...Object.fromEntries(notFound.map(id => [id, "Acabamentos indisponíveis para este equipamento"])) },
        })
      } catch (reason) {
        if (controller.signal.aborted) return
        const message = reason instanceof Error ? reason.message : "Acabamentos indisponíveis"
        setState(previousState => !currentRequest(previousState) ? previousState : {
          ...previousState, errors: { ...previousState.errors, ...Object.fromEntries(missing.map(id => [id, message])) },
        })
      }
    }, 100)
    return () => { clearTimeout(timer); controller.abort() }
  }, [tenantId, missingSignature])

  function retry(id?: string) {
    const selected = id?.toLowerCase()
    setState(previous => {
      if (previous.tenantId !== tenantId) return empty(tenantId, signature)
      return { ...previous, errors: Object.fromEntries(Object.entries(previous.errors).filter(([key]) => selected ? key !== selected : false)) }
    })
  }

  const loadingIds = missingSignature ? missingSignature.split(",") : []
  return { products: scoped.products, errors: scoped.errors, loadingIds, retry }
}
