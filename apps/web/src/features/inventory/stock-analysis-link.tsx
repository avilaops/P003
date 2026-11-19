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
  disabled?: boolean
  children: string
}

function useStockCatalog(tenant: string, warehouseId?: string | null) {
  const { value } = useResource<ReportCatalog>("/api/erp/stock/reports?catalog=true")
  if (value?.tenantId !== tenant) return null
  if (warehouseId && !value.warehouses?.some(warehouse => warehouse.id === warehouseId)) return null
  return value
}

export function WarehouseStockLinks({ tenant, warehouseId }: { tenant: string; warehouseId: string }) {
  const catalog = useStockCatalog(tenant, warehouseId)
  if (!catalog) return null
  return <>
    <GuardedLink className={textLink} href={stockUrl("/estoque/saldos", {tenant, warehouseId, inStock:"1"})}>Ver saldos do depósito</GuardedLink>
    {catalog.sources.stock_movement_activity && <GuardedLink className={textLink}
      href={stockUrl("/relatorios/estoque/analises", {dataset:"stock_movement_activity", warehouseId, tenant})}>Ver movimentos do depósito</GuardedLink>}
  </>
}

export function StockAnalysisLink({ dataset, tenant, warehouseId, productId, startDate, endDate, direction, disabled, children }: Props) {
  const catalog = useStockCatalog(tenant, warehouseId)
  if (!catalog?.sources?.[dataset]) return null
  if (disabled) return <span role="link" aria-disabled="true" className="inline-flex min-h-9 items-center font-medium text-muted-foreground">{children}</span>
  const href = stockUrl("/relatorios/estoque/analises", {
    dataset, productId: productId || null, warehouseId: warehouseId || null, tenant: warehouseId || productId ? tenant : null,
    startDate: startDate || null, endDate: endDate || null, movementDirection: direction || null,
  })
  return <GuardedLink className={textLink} href={href}>{children}</GuardedLink>
}
