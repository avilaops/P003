import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { fixed, validateDate } from "../sales/fixed.js"
import type { OrderInput } from "./schema.js"
import type { loadOrder } from "./snapshot.js"

function invalid(message: string): never { throw new Problem(422, "invalid_input", message) }
function conflict(message: string): never { throw new Problem(409, "domain_conflict", message) }
export function selectColor(requested: string | undefined, available: string[], previous: string | undefined): string | null {
  const selected = (requested ?? previous)?.trim() || undefined
  if (!selected) return available.length === 0 ? null : invalid("Escolha as cores disponíveis da estrutura, dos braços e do estofado antes de salvar")
  if (selected === previous) return selected
  return available.find(value => value.toLowerCase() === selected.toLowerCase()) ?? invalid("A cor escolhida não está disponível neste produto; atualize as opções antes de salvar")
}
export async function prepareOrder(context: AuthorizedContext, input: OrderInput, previous?: Awaited<ReturnType<typeof loadOrder>>) {
  const { client, tenantId } = context
  const due = validateDate(input.dueDate)
  if (input.items.length === 0 || input.items.length > 100) invalid("Pedido exige de 1 a 100 itens")
  const customers = await client.query<{ legal_name: string; tax_id: string }>("SELECT legal_name,tax_id FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer AND status='active'", [tenantId, input.customerId])
  const customer = customers.rows[0] ?? conflict("Selecione um cliente ativo desta empresa")
  const preserveCustomer = previous?.data.customerId === input.customerId
  const lines = [], seen = new Set<string>()
  let total = 0n
  for (const item of input.items) {
    if (seen.has(item.productId)) invalid("Agrupe a quantidade de cada produto em um único item")
    seen.add(item.productId)
    const quantity = fixed(item.quantity, 6)
    if (quantity === 0n) invalid("Quantidade deve ser positiva")
    const saved = previous?.items.find(line => line.productId === item.productId)
    if (!saved) {
      const published = await client.query<{ published: boolean }>("SELECT EXISTS(SELECT 1 FROM product_costs c JOIN commercial_settings s ON s.tenant_id=c.tenant_id AND s.product_line=c.product_line WHERE c.tenant_id=$1 AND c.product_id=$2 AND s.active_price_version_id IS NOT NULL) OR EXISTS(SELECT 1 FROM price_table_items i JOIN commercial_settings s ON s.tenant_id=i.tenant_id AND s.active_price_version_id=i.version_id WHERE i.tenant_id=$1 AND i.product_id=$2) AS published", [tenantId, item.productId])
      if (published.rows[0]?.published) conflict("Este produto usa tabela publicada. Simule a negociação antes de criar o pedido")
    }
    const products = await client.query<{ sku: string; name: string; unit: string; price_cents: string; status: string; structure_colors: string[]; swing_arm_colors: string[]; plate_holder_colors: string[]; upholstery_colors: string[]; upholstery_configurable: boolean }>("SELECT sku,name,unit,price_cents,status,structure_colors,swing_arm_colors,plate_holder_colors,upholstery_colors,COALESCE((SELECT (data->>'upholsteryConfigurable')::boolean FROM registration_settings WHERE tenant_id=products.tenant_id AND section='products'),true) AS upholstery_configurable FROM products WHERE tenant_id=$1 AND id=$2", [tenantId, item.productId])
    const product = products.rows[0]
    if (!product) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
    if (product.status !== "active") conflict("Produto arquivado não pode compor um rascunho")
    if (saved && saved.unit !== product.unit) conflict("Unidade do produto mudou no catálogo. Substitua o item ou crie outro pedido")
    const previousColor = (key: "structureColor" | "swingArmColor" | "plateHolderColor" | "plateHolderType" | "upholsteryColor") => saved?.[key] as string | undefined
    const structure = selectColor(item.structureColor, product.structure_colors, previousColor("structureColor"))
    const swing = item.swingArmColor === undefined && saved ? previousColor("swingArmColor") ?? null : selectColor(item.swingArmColor, product.swing_arm_colors, previousColor("swingArmColor"))
    if (item.plateHolderColor !== undefined && item.armColor !== undefined && item.plateHolderColor.trim().replace(/[A-Z]/g, c => c.toLowerCase()) !== item.armColor.trim().replace(/[A-Z]/g, c => c.toLowerCase())) invalid("Informe a cor dos anilheiros apenas em plateHolderColor")
    const requestedHolder = (item.plateHolderColor ?? item.armColor)?.trim()
    const holderColor = requestedHolder ? selectColor(requestedHolder, product.plate_holder_colors, previousColor("plateHolderColor")) : null
    const requestedType = item.plateHolderType?.trim()
    const holderType = !requestedType || requestedType.toLowerCase() === "não se aplica" ? null : requestedType.toLowerCase() === "standard" ? "Standard" : requestedType.toLowerCase() === "olímpico" ? "Olímpico" : requestedType === previousColor("plateHolderType") ? requestedType : invalid("Tipo de anilheiro deve ser Standard, Olímpico ou Não se aplica")
    let upholstery: string | null
    if (product.upholstery_configurable) upholstery = selectColor(item.upholsteryColor, product.upholstery_colors, previousColor("upholsteryColor"))
    else if (item.upholsteryColor === undefined) upholstery = previousColor("upholsteryColor") ?? null
    else if (item.upholsteryColor.trim() === "") upholstery = null
    else if (item.upholsteryColor.trim() === previousColor("upholsteryColor")) upholstery = previousColor("upholsteryColor")!
    else invalid("O estofado é padrão nesta empresa; preserve a escolha registrada ou deixe sem seleção")
    const price = saved ? fixed(String(saved.unitPrice), 2) : BigInt(product.price_cents)
    const amount = (price * quantity + 500000n) / 1000000n
    total += amount
    if (amount > 9223372036854775807n || total > 99999999999999n) invalid("Total fora do limite")
    lines.push({ productId: item.productId, sku: saved?.sku ?? product.sku, name: saved?.name ?? product.name, unit: product.unit, quantity, price, amount, structure, swing, holderColor, holderType, upholstery })
  }
  if (total === 0n) invalid("Pedido precisa ter valor comercial positivo")
  return { customerName: preserveCustomer ? previous!.data.customerName : customer.legal_name, customerTaxId: preserveCustomer ? previous!.data.customerTaxId : customer.tax_id, due, total, lines }
}
export async function storeLines(context: AuthorizedContext, orderId: string, lines: Awaited<ReturnType<typeof prepareOrder>>["lines"]) {
  for (const [index, line] of lines.entries()) await context.client.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents,structure_color,plate_holder_color,plate_holder_type,upholstery_color,swing_arm_color) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)", [context.tenantId, orderId, index + 1, line.productId, line.sku, line.name, line.unit, line.quantity, line.price, line.amount, line.structure, line.holderColor, line.holderType, line.upholstery, line.swing])
}
