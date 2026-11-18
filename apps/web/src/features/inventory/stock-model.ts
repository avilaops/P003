import type { Warehouse } from "./stock-location-model"
export type StockProduct = { productId: string; sku: string; name: string; unit: string; status: string }
export type Stock = StockProduct & { quantity: string; reserved: string; available: string }
type Page<T> = { tenantId: string; canEdit: boolean; data: T[]; total: number; offset: number; limit: number; warehouses?: Warehouse[] }
export type StockList = Page<Stock>
export type Movement = { id: string; productId: string; direction: "receipt" | "issue"; quantity: string; balanceAfter: string;
  warehouseId?: string | null; localBalanceAfter?: string | null; transferId?: string | null;
  reason: string; occurredAt: string; reversesId: string | null; sourceOrderId: string | null;
  sourcePurchaseReceiptId: string | null; sourcePosSaleId: string | null; productionOrderId: string | null;
  sourceWarrantyCaseId: string | null; sourceInventoryCountId: string | null; returnSourceId: string | null; canReverse: boolean }
export type History = Page<Movement> & { product: StockProduct; summary: { opening: string; receipts: string; issues: string; closing: string };
  openOrders?: {reserved:string;offset:number;total:number;data:{id:string;number:string;status:string;quantity:string}[]} }

export const historyPath = "/estoque/lancamentos"
export const manualPath = "/estoque/lancamentos/novo"
export const pageSize = 25
export const textLink = "inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
export function pageOffset(value: string | null) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 100000 ? n : 0
}
export function stockUrl(path: string, values: Record<string, string | number | null>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== "" && value !== 0) params.set(key, String(value))
  return params.size ? path + "?" + params : path
}
