import type { PriceItem, Sale } from "./negotiation-types"
import type { ProductFinishes } from "./order-product-details"

export type SelectedOrderItem = {
  line?: string
  versionId?: string
  productId: string
  quantity: string
  structureColor: string
  swingArmColor: string
  upholsteryColor: string
  plateHolderColor: string
  plateHolderType: string
}

export const orderColorParts = [
  { field: "structureColor", options: "structureColors", part: "structure", title: "Estrutura", label: "Cor da estrutura" },
  { field: "swingArmColor", options: "swingArmColors", part: "swingArm", title: "Braços", label: "Cor dos braços" },
  { field: "upholsteryColor", options: "upholsteryColors", part: "upholstery", title: "Estofado", label: "Cor do estofado" },
] as const

type ColorPart = typeof orderColorParts[number]

export function orderFinishOptions(item: SelectedOrderItem, product: Partial<ProductFinishes> | undefined, { options }: ColorPart) {
  if (item.line === "national" || !product || options === "upholsteryColors" && product.upholsteryConfigurable === false) return []
  return product[options] ?? []
}

export function requiredOrderFinishParts(item: SelectedOrderItem, product: ProductFinishes | undefined) {
  return orderColorParts.filter(color => {
    const options = orderFinishOptions(item, product, color)
    return options.length > 0 && !options.some(option => option.trim().toLocaleLowerCase("pt-BR") === item[color.field].trim().toLocaleLowerCase("pt-BR"))
  })
}

export function compatibleOrderFinishUpdates(source: SelectedOrderItem, items: SelectedOrderItem[], products: Record<string, ProductFinishes>) {
  const colors = source.line === "national" ? [] : orderColorParts.filter(({ field }) => source[field])
  const updates: SelectedOrderItem[] = []
  const skipped: { productId: string; parts: string[] }[] = []
  for (const item of items) {
    if (item.productId === source.productId) continue
    const product = products[item.productId.toLowerCase()]
    const next = { ...item }
    const incompatible = []
    let changed = false
    for (const color of colors) {
      const value = source[color.field]
      if (!orderFinishOptions(item, product, color).includes(value)) {
        incompatible.push(color.title)
      } else if (item[color.field] !== value) {
        next[color.field] = value
        changed = true
      }
    }
    if (changed) updates.push(next)
    if (incompatible.length) skipped.push({ productId: item.productId, parts: incompatible })
  }
  return { updates, skipped }
}

export function orderEquipmentQuantity(raw: string) {
  if (!/^\d{1,7}$/.test(raw)) return null
  const quantity = Number(raw)
  return quantity >= 1 && quantity <= 1_000_000 ? quantity : null
}

export function orderEquipmentPrice(item: SelectedOrderItem, prices: PriceItem[]) {
  return prices.find(price => price.productId === item.productId && price.line === item.line && price.versionId === item.versionId)
}

export function orderEquipmentAmounts(item: SelectedOrderItem, price: PriceItem | undefined, simulated: Pick<Sale["items"][number], "quantity" | "tableUnitCents" | "netCents" | "totalCents"> | undefined) {
  const quantity = orderEquipmentQuantity(item.quantity)
  const available = price && price.available !== false
  const tableUnitCents = available && Number.isSafeInteger(price.priceWithoutIpiCents) ? price.priceWithoutIpiCents : null
  const tableLine = available && quantity !== null ? price.priceWithIpiCents * quantity : null
  const tableLineCents = Number.isSafeInteger(tableLine) ? tableLine : null
  const valid = available && simulated && simulated.quantity === quantity
  return {
    tableUnitCents,
    tableLineCents,
    discountCents: valid ? simulated.tableUnitCents * simulated.quantity - simulated.netCents : null,
    simulatedLineCents: valid ? simulated.totalCents : null,
  }
}
