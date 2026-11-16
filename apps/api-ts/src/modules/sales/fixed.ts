import { Problem } from "../../platform/problem.js"

export function fixed(value: string, scale: number): bigint {
  if (!new RegExp(`^(0|[1-9][0-9]{0,11})\\.[0-9]{${scale}}$`).test(value)) throw new Problem(422, "invalid_input", "Decimal inválido ou fora da escala permitida")
  return BigInt(value.replace(".", ""))
}
export function decimal(value: bigint, scale: number): string {
  const factor = 10n ** BigInt(scale)
  return `${value / factor}.${(value % factor).toString().padStart(scale, "0")}`
}
export function validateDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900 || Number(value.slice(0, 4)) > 2100 || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Problem(422, "invalid_input", "Data inexistente ou fora do intervalo permitido")
  return value
}
