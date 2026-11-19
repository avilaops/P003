import { catalogPriceSources } from "../commercial/price-origin.js"
import { requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { fixed, validateDate } from "../sales/fixed.js"
import { loadSaleProduct, selectFinishes } from "../sales/finishes.js"
import { proposalText, type ProposalInput } from "./schema.js"
import type { loadProposal } from "./snapshot.js"
import { prepareProposalCommercial, verifyProposalCommercialLines, captureTechnical } from "./commercial.js"

function invalid(title: string): never { throw new Problem(422, "invalid_input", title) }
function conflict(title: string): never { throw new Problem(409, "domain_conflict", title) }
export async function prepareProposal(context: AuthorizedContext, input: ProposalInput, previous?: Awaited<ReturnType<typeof loadProposal>>) {
  const validity = validateDate(input.validUntil), payment = proposalText(input.paymentTerms, 2000, true), delivery = proposalText(input.deliveryTerms, 2000, true), notes = proposalText(input.notes, 10000, false)
  if (!input.items.length || input.items.length > 100) invalid("Proposta exige de 1 a 100 itens")
  const customer = (await context.client.query("SELECT legal_name,tax_id FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer AND status='active'", [context.tenantId, input.customerId])).rows[0]
  if (!customer) conflict("Selecione um cliente ativo desta empresa")
  const commercial = await prepareProposalCommercial(context, input)
  const origins = commercial ? new Map() : await catalogPriceSources(context,input.items.map(i=>i.productId),input.customerId)
  const seen = new Set<string>(), lines = []
  let total = 0n
  for (const item of input.items) {
    if (seen.has(item.productId)) invalid("Agrupe a quantidade de cada produto em um único item")
    seen.add(item.productId)
    const product = await loadSaleProduct(context, item.productId), saved = previous?.items.find(line => line.productId === item.productId)
    if (saved && saved.unit !== product.unit) conflict("Unidade do produto mudou; revise o item")
    if (product.status !== "active") conflict("Selecione produtos ativos desta empresa")
    const quoted = commercial?.prepared.sale.items.find(line => line.productId === item.productId)
    const finishes = selectFinishes(item, product, saved, quoted?.line)
    const origin = origins.get(item.productId)
    const sameCustomer = previous?.data.customerId === input.customerId
    const agreed = saved && sameCustomer ? fixed(String(saved.unitPrice), 2) : BigInt(origin?.baseCents ?? product.price_cents), price = item.unitPrice === null ? quoted ? BigInt(quoted.unitTotalCents) : agreed : fixed(item.unitPrice, 2)
    if (price !== agreed && !commercial) requirePermission(context, "sales.proposals.negotiate")
    const quantity = fixed(item.quantity, 6)
    if (quantity === 0n || price > 99999999999999n) invalid("Quantidade ou preço fora do limite")
    const amount = (quantity * price + 500000n) / 1000000n
    if (amount > 99999999999999n) invalid("Valor do item fora do limite")
    total += amount
    if (total > 99999999999999n) invalid("Total da proposta fora do limite")
    lines.push({ productId: item.productId, sku: saved?.sku ?? product.sku, name: saved?.name ?? product.name, unit: product.unit, quantity, price, amount, priceOrigin: quoted ? quoted.priceOrigin ?? {kind:"published",baseCents:quoted.tableUnitCents} : saved && sameCustomer ? saved.priceOrigin : origin, catalog: quoted ? BigInt(quoted.tableUnitCents) : saved && sameCustomer ? fixed(String(saved.catalogPrice), 2) : BigInt(origin?.baseCents ?? product.price_cents), technical: commercial ? await captureTechnical(context, item.productId) : null, ...finishes })
  }
  if (!total) invalid("Proposta exige de 1 a 100 itens e valor positivo")
  if (commercial) verifyProposalCommercialLines(commercial, lines, total)
  const preserve = previous?.data.customerId === input.customerId
  return { validity, payment, delivery, notes, commercial, customerName: preserve ? previous!.data.customerName : customer.legal_name, customerTaxId: preserve ? previous!.data.customerTaxId : customer.tax_id, lines, total }
}
export async function storeProposalLines(context: AuthorizedContext, id: string, version: number, lines: Awaited<ReturnType<typeof prepareProposal>>["lines"]) {
  for (const [index, line] of lines.entries()) await context.client.query("INSERT INTO sales_proposal_lines(tenant_id,proposal_id,version,line_number,product_id,sku,name,unit,quantity_micros,catalog_price_cents,price_cents,amount_cents,structure_color,upholstery_color,plate_holder_color,plate_holder_type,swing_arm_color,technical_snapshot,price_origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)", [context.tenantId, id, version, index + 1, line.productId, line.sku, line.name, line.unit, line.quantity, line.catalog, line.price, line.amount, line.structure, line.upholstery, line.holderColor, line.holderType, line.swing, line.technical,line.priceOrigin])
}
