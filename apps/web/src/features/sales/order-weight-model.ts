import { normalizeDecimal } from "@/lib/decimal-input"

type WeightedItem = { quantity: string; weight?: string | null }

export function orderEquipmentWeight(items: WeightedItem[]) {
  let total = BigInt(0)
  let missingWeights = 0
  let invalidQuantities = false
  for (const item of items) {
    const weight = normalizeDecimal((item.weight || "").trim().replace(/\s*kg$/i, "").trim(), 6)
    const quantity = normalizeDecimal(item.quantity, 6)
    if (!weight || BigInt(weight.replace(".", "")) <= BigInt(0)) { missingWeights++; continue }
    if (!quantity || BigInt(quantity.replace(".", "")) <= BigInt(0)) { invalidQuantities = true; continue }
    total += BigInt(weight.replace(".", "")) * BigInt(quantity.replace(".", ""))
  }
  const scale = BigInt("1000000000000")
  const fraction = (total % scale).toString().padStart(12, "0").replace(/0+$/, "")
  const totalKg = missingWeights || invalidQuantities ? null : `${total / scale}${fraction ? `.${fraction}` : ""}`
  return { totalKg, missingWeights, invalidQuantities }
}

type MeasuredItem = { quantity: string; dimensionsMm?: readonly unknown[] | null }

// Catalog dimensions are length, width and height in whole millimetres, the same bounds the order PDF accepts.
function catalogDimensions(value: MeasuredItem["dimensionsMm"]) {
  if (!Array.isArray(value) || value.length !== 3) return null
  if (!value.every(size => typeof size === "number" && Number.isInteger(size) && size > 0 && size <= 50000)) return null
  return value.map(size => BigInt(size as number))
}

function roundedDecimal(value: bigint, scale: bigint, digits: number) {
  const unit = scale / BigInt(10 ** digits)
  const digitsText = ((value + unit / BigInt(2)) / unit).toString().padStart(digits + 1, "0")
  const whole = digitsText.slice(0, -digits), fraction = digitsText.slice(-digits).replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : whole
}

/** Floor area (length × width, m², 2 decimals) and volume (m³, 3 decimals) for freight quotes; incomplete data never yields a partial total. */
export function orderEquipmentFootprint(items: MeasuredItem[]) {
  let area = BigInt(0)
  let volume = BigInt(0)
  let missingDimensions = 0
  let invalidQuantities = false
  for (const item of items) {
    const dimensions = catalogDimensions(item.dimensionsMm)
    const quantity = normalizeDecimal(item.quantity, 6)
    if (!dimensions) { missingDimensions++; continue }
    if (!quantity || BigInt(quantity.replace(".", "")) <= BigInt(0)) { invalidQuantities = true; continue }
    const [length, width, height] = dimensions as [bigint, bigint, bigint]
    const quantityMicros = BigInt(quantity.replace(".", ""))
    area += length * width * quantityMicros
    volume += length * width * height * quantityMicros
  }
  const complete = !missingDimensions && !invalidQuantities
  return {
    areaM2: complete ? roundedDecimal(area, BigInt("1000000000000"), 2) : null,
    volumeM3: complete ? roundedDecimal(volume, BigInt("1000000000000000"), 3) : null,
    missingDimensions,
    invalidQuantities,
  }
}
