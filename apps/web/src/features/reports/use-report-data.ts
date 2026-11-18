"use client"

import { useResource } from "@/hooks/use-operation"
import { stockMetrics, type StockResult } from "./report-model"

export function useStockReport(offset: number) {
  const resource = useResource<StockResult>(`/api/erp/stock?limit=100&offset=${offset}`)
  return { ...resource, metrics: stockMetrics(resource.value) }
}
