import type { AuthorizedContext } from "../../platform/access.js"
import type { prepareNegotiation } from "./prepare.js"
import type { prepareMixed } from "./mixed-prepare.js"
import type { MixedInput } from "./mixed-model.js"
import type { NegotiationInput } from "./negotiation-model.js"
import { loadSaleProduct, selectFinishes } from "../sales/finishes.js"

type Prepared = Awaited<ReturnType<typeof prepareNegotiation | typeof prepareMixed>>
export async function quoteLines(context:AuthorizedContext,prepared:Prepared) {
  const lines = []
  for (const item of prepared.sale.items) {
    const product = await loadSaleProduct(context, item.productId)
    const line = prepared.kind === "single" ? prepared.line : ("line" in item ? String(item.line) : undefined)
    const finishes = selectFinishes({ structureColor: item.structureColor, swingArmColor: item.swingArmColor, plateHolderColor: item.plateHolderColor ?? undefined, plateHolderType: item.plateHolderType ?? undefined, upholsteryColor: item.upholsteryColor }, product, undefined, line)
    lines.push({ priceOrigin:item.priceOrigin??{kind:"published",baseCents:item.tableUnitCents}, productId: item.productId, sku: item.sku, name: item.name, unit: item.unit, quantity: BigInt(item.quantity) * 1000000n, price: BigInt(item.unitTotalCents), amount: BigInt(item.totalCents), ...finishes })
  }
  return lines
}
export async function storeQuote(context:AuthorizedContext, order:string, simulation:NegotiationInput|MixedInput, prepared:Prepared) {
  const {client,tenantId}=context
  const status = prepared.sale.approvalReasons.length ? "pending" : "not_required"
  const publicSnapshot = prepared.kind === "single" ? { input: simulation, sale: prepared.sale, version: prepared.version, digest: prepared.digest } : { kind: "mixed", input: simulation, sale: prepared.sale, digest: prepared.digest }
  const privateSnapshot = prepared.kind === "single" ? { director: prepared.director, policy: prepared.policy, sources: prepared.sources } : { director: prepared.director, policies: prepared.policies, sources: prepared.sources }
  const priceVersion = prepared.kind === "single" ? (simulation as NegotiationInput).versionId : null
  await client.query("INSERT INTO commercial_order_quotes(tenant_id,order_id,price_version_id,public_snapshot,private_snapshot,approval_rules,approval_status,requires_director,created_by) SELECT $1,$2,$3,$4,$5,$6,$7,$8,id FROM identities WHERE auth_subject=$9", [tenantId, order, priceVersion, publicSnapshot, privateSnapshot, prepared.rules, status, prepared.director.requiresDirector, context.authSubject])
  if (prepared.kind === "mixed") for (const policy of prepared.policies) await client.query("INSERT INTO commercial_order_quote_versions(tenant_id,order_id,product_line,version_id,version_snapshot) VALUES($1,$2,$3,$4,$5)", [tenantId, order, policy.line, policy.versionId, policy])
  return {status,priceVersion}
}
