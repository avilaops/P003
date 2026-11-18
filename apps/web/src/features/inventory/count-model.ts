export type CountSession = {
  id: string
  status: "open" | "approved" | "cancelled"
  reference: string
  revision: number
  lineCount: number
  countedLines: number
  createdAt: string
  createdBy: string
  approvedBy: string | null
  blind: boolean
  lockMovements: boolean
  recountPercent: number | null
  warehouseName: string | null
  categoryName: string | null
  cancelReason: string | null
}
export type CountLine = {
  productId: string
  sku: string
  name: string
  unit: string
  expectedQuantity: string | null
  countedQuantity: string | null
  needsRecount: boolean
  recountedAt: string | null
  stockChanged: boolean
}
type Scope = { id: string; name: string; code: string }
export type CountList = { tenantId: string; canEdit: boolean; data: CountSession[]; total: number; warehouses: Scope[]; categories: Scope[] }
export type CountDetail = { tenantId: string; canEdit: boolean; canApprove: boolean; count: CountSession; lines: CountLine[] }
export const countLabels = { open: "Aberto", approved: "Aprovado", cancelled: "Cancelado" } as const
export const countEndpoint = "/api/erp/inventory-counts"
export const countPath = "/estoque/inventarios"
