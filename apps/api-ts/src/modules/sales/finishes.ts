import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"

export type FinishInput = { structureColor?: string | null | undefined; swingArmColor?: string | undefined; plateHolderColor?: string | undefined; plateHolderType?: string | undefined; upholsteryColor?: string | null | undefined; armColor?: string | undefined }
export type SavedFinishes = { structureColor?: unknown; swingArmColor?: unknown; plateHolderColor?: unknown; plateHolderType?: unknown; upholsteryColor?: unknown }
export type SaleProduct = { sku: string; name: string; unit: string; price_cents: string; status: string; structure_colors: string[]; swing_arm_colors: string[]; plate_holder_colors: string[]; upholstery_colors: string[]; upholstery_configurable: boolean }
function invalid(message: string): never { throw new Problem(422, "invalid_input", message) }
export function selectColor(requested: string | undefined, available: string[], previous: string | undefined): string | null {
  const selected = (requested ?? previous)?.trim() || undefined
  if (!selected) return available.length === 0 ? null : invalid("Escolha as cores disponíveis da estrutura, dos braços e do estofado antes de salvar")
  if (selected === previous) return selected
  return available.find(value => value.toLowerCase() === selected.toLowerCase()) ?? invalid("A cor escolhida não está disponível neste produto; atualize as opções antes de salvar")
}
export function selectFinishes(item: FinishInput, product: SaleProduct, saved?: SavedFinishes) {
  const previous = (key: keyof SavedFinishes) => typeof saved?.[key] === "string" ? saved[key] as string : undefined
  const structure = selectColor(item.structureColor ?? undefined, product.structure_colors, previous("structureColor"))
  const swing = item.swingArmColor === undefined && saved ? previous("swingArmColor") ?? null : selectColor(item.swingArmColor, product.swing_arm_colors, previous("swingArmColor"))
  const lowerAscii = (value: string) => value.trim().replace(/[A-Z]/g, c => c.toLowerCase())
  if (item.plateHolderColor !== undefined && item.armColor !== undefined && lowerAscii(item.plateHolderColor) !== lowerAscii(item.armColor)) invalid("Informe a cor dos anilheiros apenas em plateHolderColor")
  const requestedHolder = (item.plateHolderColor ?? item.armColor)?.trim()
  const holderColor = requestedHolder ? selectColor(requestedHolder, product.plate_holder_colors, previous("plateHolderColor")) : null
  const requestedType = item.plateHolderType?.trim()
  const holderType = !requestedType || requestedType.toLowerCase() === "não se aplica" ? null : requestedType.toLowerCase() === "standard" ? "Standard" : requestedType.toLowerCase() === "olímpico" ? "Olímpico" : requestedType === previous("plateHolderType") ? requestedType : invalid("Tipo de anilheiro deve ser Standard, Olímpico ou Não se aplica")
  let upholstery: string | null
  if (product.upholstery_configurable) upholstery = selectColor(item.upholsteryColor ?? undefined, product.upholstery_colors, previous("upholsteryColor"))
  else if (item.upholsteryColor == null) upholstery = previous("upholsteryColor") ?? null
  else if (item.upholsteryColor.trim() === "") upholstery = null
  else if (item.upholsteryColor.trim() === previous("upholsteryColor")) upholstery = previous("upholsteryColor")!
  else invalid("O estofado é padrão nesta empresa; preserve a escolha registrada ou deixe sem seleção")
  return { structure, swing, holderColor, holderType, upholstery }
}
export async function loadSaleProduct(context: AuthorizedContext, id: string) {
  const product = (await context.client.query<SaleProduct>("SELECT sku,name,unit,price_cents,status,structure_colors,swing_arm_colors,plate_holder_colors,upholstery_colors,COALESCE((SELECT (data->>'upholsteryConfigurable')::boolean FROM registration_settings WHERE tenant_id=products.tenant_id AND section='products'),true) AS upholstery_configurable FROM products WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])).rows[0]
  if (!product) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
  return product
}
