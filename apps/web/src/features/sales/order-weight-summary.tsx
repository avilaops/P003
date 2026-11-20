"use client"

import { useEffect, useState } from "react"
import { erpFetch } from "@/lib/api/client"
import { Button } from "@/components/ui/button"
import { commercialQuantity } from "./order-presentation"
import { orderEquipmentFootprint, orderEquipmentWeight } from "./order-weight-model"

type Item = { productId: string; quantity: string; equipmentWeight?: string | null; equipmentDimensions?: readonly number[] | null }
type Profile = { weight: string | null; dimensionsMm: number[] | null }

function dimensionsOf(value: unknown) {
  return Array.isArray(value) && value.every(size => typeof size === "number") ? value as number[] : null
}

export function OrderWeightSummary({ tenantId, items, loading = false, unavailable = false, onRetry }: { tenantId: string; items: Item[]; loading?: boolean; unavailable?: boolean; onRetry?: () => void }) {
  const [retry, setRetry] = useState(0)
  // The catalog is consulted only for items that arrive without a weight; those that bring one also bring their dimensions.
  const requests = [...new Set(items.filter(item => item.equipmentWeight === undefined).map(item => item.productId))].sort().join(",")
  const key = `${tenantId}:${requests}:${retry}`
  const [profiles, setProfiles] = useState<{ key: string; values: Record<string, Profile>; failed: boolean } | null>(null)
  useEffect(() => {
    if (!requests) return
    const controller = new AbortController()
    Promise.all(requests.split(",").map(async id => {
      try {
        const response = await erpFetch(`/api/erp/products/${id}/catalog`, { cache: "no-store", signal: controller.signal })
        if (response.status === 404) return { id, weight: null, dimensionsMm: null, failed: false }
        const value = await response.json()
        if (!response.ok || value.tenantId !== tenantId || typeof value.data?.weight !== "string") throw Error("Peso indisponível")
        return { id, weight: value.data.weight as string, dimensionsMm: dimensionsOf(value.data.dimensionsMm), failed: false }
      } catch { return { id, weight: null, dimensionsMm: null, failed: true } }
    })).then(values => {
      if (!controller.signal.aborted) setProfiles({ key, values: Object.fromEntries(values.map(({ id, weight, dimensionsMm }) => [id, { weight, dimensionsMm }])), failed: values.some(value => value.failed) })
    })
    return () => controller.abort()
  }, [requests, tenantId, key])
  if (!items.length) return null
  const pending = loading || Boolean(requests) && profiles?.key !== key
  const failed = unavailable || !pending && Boolean(requests) && profiles?.failed
  const profile = (item: Item) => item.equipmentWeight === undefined && profiles?.key === key ? profiles.values[item.productId] : undefined
  const summary = orderEquipmentWeight(items.map(item => ({ quantity: item.quantity, weight: item.equipmentWeight === undefined ? profile(item)?.weight ?? null : item.equipmentWeight })))
  const footprint = orderEquipmentFootprint(items.map(item => ({ quantity: item.quantity, dimensionsMm: item.equipmentDimensions === undefined ? profile(item)?.dimensionsMm ?? null : item.equipmentDimensions })))
  const measure = (value: string | null, unit: string) => pending ? "Consultando medidas…" : value === null ? "Incompleto" : `${commercialQuantity(value)} ${unit}`
  return <section aria-label="Peso do pedido" className="space-y-1 border-t pt-3 text-sm">
    <dl className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><dt className="font-medium">Peso bruto total</dt><dd className="font-semibold tabular-nums">{pending ? "Consultando pesos…" : summary.totalKg === null ? "Incompleto" : `${commercialQuantity(summary.totalKg)} kg`}</dd></dl>
    {!pending && summary.totalKg === null && <p className="text-xs text-muted-foreground">{failed ? "Não foi possível consultar todos os pesos." : summary.invalidQuantities ? "Confira as quantidades para calcular o peso total." : `Peso não cadastrado ou inválido em ${summary.missingWeights} equipamento(s).`}</p>}
    <dl className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><dt className="font-medium">Área ocupada</dt><dd className="font-semibold tabular-nums">{measure(footprint.areaM2, "m²")}</dd></dl>
    <dl className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><dt className="font-medium">Volume</dt><dd className="font-semibold tabular-nums">{measure(footprint.volumeM3, "m³")}</dd></dl>
    {!pending && !failed && footprint.areaM2 === null && footprint.missingDimensions > 0 && <p className="text-xs text-muted-foreground">{`Medidas não cadastradas ou inválidas em ${footprint.missingDimensions} equipamento(s).`}</p>}
    {failed && <Button type="button" variant="outline" size="sm" className="print:hidden" onClick={() => onRetry ? onRetry() : setRetry(value => value + 1)}>Consultar pesos novamente</Button>}
  </section>
}
