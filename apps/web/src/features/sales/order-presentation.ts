import { normalizeDecimal } from "@/lib/decimal-input"

export const orderStatusLabels: Record<string, string> = { draft: "Rascunho", accepted: "Encomenda aceita", confirmed: "Reservado", completed: "Concluído", cancelled: "Cancelado" }

export function orderNumber(number: string | undefined) {
  return number ? `PV-${number.padStart(6, "0")}` : "Pedido"
}

// Format fixed-point API strings without rounding through floating-point numbers.
export function commercialQuantity(value: string) {
  const [integer, fraction = ""] = value.split(".")
  const decimals = fraction.replace(/0+$/, "")
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  return decimals ? `${grouped},${decimals}` : grouped
}

export function commercialMoney(value: string) {
  const [integer, fraction = ""] = value.split(".")
  return `R$ ${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${fraction.padEnd(2, "0")}`
}

export function normalizeCommercialMoney(raw: string) {
  const value = raw.trim().replace(/^R\$\s*/, "")
  const grouped = /^[1-9][0-9]{0,2}(?:\.[0-9]{3})+(?:,[0-9]{1,2})?$/.test(value)
  return normalizeDecimal(grouped ? value.replaceAll(".", "") : value, 2)
}

export function proposalCatalogTotal(items: readonly { basePrice?: string | null; quantity: string }[]) {
  let total = BigInt(0)
  const scale = BigInt(1_000_000)
  for (const item of items) {
    const price = normalizeCommercialMoney(item.basePrice || "")
    const quantity = normalizeDecimal(item.quantity, 6)
    if (!price || !quantity) return null
    const cents = BigInt(price.replace(".", ""))
    const units = BigInt(quantity.replace(".", ""))
    total += (cents * units + scale / BigInt(2)) / scale
  }
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null
}

export function commercialMoneyInput(value: string) {
  const normalized = normalizeCommercialMoney(value)
  return normalized ? commercialMoney(normalized).slice(3) : value
}
