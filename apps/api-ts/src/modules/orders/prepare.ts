import { catalogPriceSources } from "../commercial/price-origin.js"
import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { fixed, validateDate } from "../sales/fixed.js"
import { assertPaymentTermLimit } from "./payment-term-limit.js"
import type { OrderInput } from "./schema.js"
import type { loadOrder } from "./snapshot.js"

function invalid(message: string): never { throw new Problem(422, "invalid_input", message) }
function conflict(message: string): never { throw new Problem(409, "domain_conflict", message) }
export { selectColor } from "../sales/finishes.js"
import { loadSaleProduct, selectFinishes } from "../sales/finishes.js"
export async function prepareOrder(context: AuthorizedContext, input: OrderInput, previous?: Awaited<ReturnType<typeof loadOrder>>, channel?:string, allowPublished=false) {
  const { client, tenantId } = context
  const due = validateDate(input.dueDate)
  await assertPaymentTermLimit(context, due)
  if (input.items.length === 0 || input.items.length > 100) invalid("Pedido exige de 1 a 100 itens")
  const customers = await client.query<{ legal_name: string; tax_id: string }>("SELECT legal_name,tax_id FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer AND status='active'", [tenantId, input.customerId])
  const customer = customers.rows[0] ?? conflict("Selecione um cliente ativo desta empresa")
  const preserveCustomer = previous?.data.customerId === input.customerId
  const lines = [], seen = new Set<string>()
  const origins = await catalogPriceSources(context,input.items.map(i=>i.productId),input.customerId,channel)
  let total = 0n
  for (const item of input.items) {
    if (seen.has(item.productId)) invalid("Agrupe a quantidade de cada produto em um único item")
    seen.add(item.productId)
    const quantity = fixed(item.quantity, 6)
    if (quantity === 0n) invalid("Quantidade deve ser positiva")
    const saved = previous?.items.find(line => line.productId === item.productId)
    if (!saved && !allowPublished) {
      const published = await client.query<{ published: boolean }>("SELECT EXISTS(SELECT 1 FROM product_costs c JOIN commercial_settings s ON s.tenant_id=c.tenant_id AND s.product_line=c.product_line WHERE c.tenant_id=$1 AND c.product_id=$2 AND s.active_price_version_id IS NOT NULL) OR EXISTS(SELECT 1 FROM price_table_items i JOIN commercial_settings s ON s.tenant_id=i.tenant_id AND s.active_price_version_id=i.version_id WHERE i.tenant_id=$1 AND i.product_id=$2) AS published", [tenantId, item.productId])
      if (published.rows[0]?.published) conflict("Este produto usa tabela publicada. Simule a negociação antes de criar o pedido")
    }
    const product = await loadSaleProduct(context, item.productId)
    if (product.status !== "active") conflict("Produto arquivado não pode compor um rascunho")
    if (saved && saved.unit !== product.unit) conflict("Unidade do produto mudou no catálogo. Substitua o item ou crie outro pedido")
    const { structure, swing, holderColor, holderType, upholstery } = selectFinishes(item, product, saved)
    const currentOrigin = origins.get(item.productId)
    const priceOrigin = saved && preserveCustomer ? saved.priceOrigin : currentOrigin
    const price = saved && preserveCustomer ? fixed(String(saved.unitPrice), 2) : BigInt(currentOrigin?.baseCents ?? product.price_cents)
    const amount = (price * quantity + 500000n) / 1000000n
    total += amount
    if (amount > 9223372036854775807n || total > 99999999999999n) invalid("Total fora do limite")
    lines.push({ productId: item.productId, sku: saved?.sku ?? product.sku, name: saved?.name ?? product.name, unit: product.unit, quantity, priceOrigin, price, amount, structure, swing, holderColor, holderType, upholstery })
  }
  if (total === 0n) invalid("Pedido precisa ter valor comercial positivo")
  return { customerName: preserveCustomer ? previous!.data.customerName : customer.legal_name, customerTaxId: preserveCustomer ? previous!.data.customerTaxId : customer.tax_id, due, total, lines }
}
export async function storeLines(context: AuthorizedContext, orderId: string, lines: Awaited<ReturnType<typeof prepareOrder>>["lines"]) {
  for (const [index, line] of lines.entries()) await context.client.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents,structure_color,plate_holder_color,plate_holder_type,upholstery_color,swing_arm_color,price_origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)", [context.tenantId, orderId, index + 1, line.productId, line.sku, line.name, line.unit, line.quantity, line.price, line.amount, line.structure, line.holderColor, line.holderType, line.upholstery, line.swing,line.priceOrigin])
}
