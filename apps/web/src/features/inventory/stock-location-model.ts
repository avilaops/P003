export type Warehouse = {id: string; code: string; name: string}
export type LocationSettings = {
  tenantId: string; canEdit: boolean; enabled: boolean; revision: number; openingId: string | null
  salesId: string | null; purchaseId: string | null; productionId: string | null
  warehouses: (Warehouse & {itemsInStock: number})[]
}
export type TransferRecord = {
  id: string; fromName: string; toName: string; createdAt: string; reason: string
  reversesId: string | null; reversedBy: string | null
}
export type TransferProduct = {productId: string; sku: string; name: string; unit: string; quantity: string}
export const selectClass = "block min-h-10 w-full rounded-lg border bg-background px-2"
