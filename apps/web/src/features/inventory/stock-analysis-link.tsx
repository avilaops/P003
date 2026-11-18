"use client"

import { GuardedLink } from "@/components/shell/navigation-guard"
import { useResource } from "@/hooks/use-operation"
import { stockUrl, textLink } from "./stock-model"

type ReportCatalog = {
  tenantId: string
  sources: Record<string, { label: string }>
  warehouses: { id: string }[]
}

type Props = {
  dataset: "stock_movement_activity" | "stock_count_progress" | "stock_production_progress"
  tenant: string
  warehouseId?: string | null
  productId?: string
  startDate?: string
  endDate?: string
  direction?: string
  children: string
}

export function StockAnalysisLink({ dataset, tenant, warehouseId, productId, startDate, endDate, direction, children }: Props) {
  const { value } = useResource<ReportCatalog>("/api/erp/stock/reports?catalog=true")
  if (value?.tenantId !== tenant || !value.sources?.[dataset]) return null
  if (warehouseId && !value.warehouses?.some(warehouse => warehouse.id === warehouseId)) return null
  const href = stockUrl("/relatorios/estoque/analises", {
    dataset, productId: productId || null, warehouseId: warehouseId || null, tenant: warehouseId || productId ? tenant : null,
    startDate: startDate || null, endDate: endDate || null, movementDirection: direction || null,
  })
  return <GuardedLink className={textLink} href={href}>{children}</GuardedLink>
}
