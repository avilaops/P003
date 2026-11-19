import { createHash } from "node:crypto"
import { z } from "zod"
import { canonicalJson } from "../../platform/json.js"
import { unsigned64, unsigned32 } from "../../platform/numbers.js"
import { revisionValue } from "../../platform/revision.js"
import { commercialCents, parametersSchema, rounded, simulateParameters, up } from "../commercial/parameters.js"
import type { Context } from "./read.js"
import { invalid, conflict } from "./schema.js"

const publishedCost = z.strictObject({purchaseCostCents:unsigned64,taxCreditBps:unsigned32,packagingCents:unsigned64})
const bps = 10000n
const squared = bps*bps
const roundSigned = (v: bigint, denominator: bigint) => v<0n ? -rounded(-v,denominator) : rounded(v,denominator)
function lastPassing(high: bigint, passes: (value: bigint)=>boolean) {
  let low = 0n
  while (low<high) {
    const mid = (low+high+1n)/2n
    if (passes(mid)) low=mid
    else high=mid-1n
  }
  return low
}

// The PDV honors the published zero-discount unit price, including its upward IPI rounding.
export function publishedPrice(row: Record<string,unknown>, tenantId: string, productId: string, micros: bigint, destination: string, taxpayer: boolean) {
  const policy = parametersSchema.safeParse(row.policy_snapshot), costs = publishedCost.safeParse(row.cost_snapshot)
  if (!policy.success || !costs.success || !row.unit_matches) conflict("Publicação incompatível com o produto atual. Revise a tabela comercial")
  const p=policy.data, c=costs.data, price=BigInt(String(row.price_without_ipi_cents)), q=micros/1000000n
  if (micros%1000000n!==0n || q<1n || q>1000000n) invalid("Tabela publicada exige quantidade inteira entre 1 e 1.000.000")
  const purchase=BigInt(c.purchaseCostCents), pack=BigInt(c.packagingCents)
  if (price<1n || price>1000000000000n || purchase>1000000000000n || pack>1000000000000n || c.taxCreditBps>10000) invalid("Quantidade ou custo publicado inválido")
  simulateParameters(p)
  const rate = p.stateRates.find(r=>r.state===destination) ?? invalid("UF de destino inválida")
  const outgoing=rate.outgoingBps ?? p.interstateBps
  const icms=destination===p.originState ? p.domesticIcmsBps : taxpayer ? outgoing : Math.max(outgoing,rate.internalBps)+rate.fcpBps
  const channel=p.commissionBps+p.adsBps+p.gatewayBps+p.otherFeesBps, provisions=p.lossBps+p.warrantyBps+p.badDebtBps
  const adjusted=purchase*(bps-BigInt(c.taxCreditBps))*(bps+BigInt(p.costSafetyBps))+pack*squared
  const variable=BigInt(icms+p.pisCofinsBps+channel+provisions), fixed=BigInt(p.fixedOrderFeeCents)
  const pretaxAt=(v:bigint)=>v*q*(bps-variable)*bps-adjusted*q-fixed*squared
  const incomeAt=(v:bigint)=> (v>0n?v:0n)*BigInt(p.incomeTaxBps)
  const profitAt=(v:bigint)=>{const pre=pretaxAt(v);return pre*bps-incomeAt(pre)}
  const margin=BigInt(p.netMarginBps)
  const meets=(v:bigint,target:boolean)=>profitAt(v)>=(target?v*q*margin*squared:0n)
  if (!meets(price,true)) conflict("Política comercial exige aprovação. Conclua a negociação no fluxo comercial")
  const gross=(v:bigint)=>rounded(v*(bps+BigInt(p.ipiBps)),bps)
  const limit=(target:boolean)=> Number(lastPassing(9999n, discount=>{const v=rounded(price*(bps-discount),bps);return v>0n && meets(v,target)}))
  const minUnit=lastPassing(price, v=>!meets(v,true))+1n
  const qty=Number(q), net=price*q, unit=gross(price), amount=unit*q
  const sale={quantity:qty,tableUnitCents:commercialCents(price),tableTotalCents:commercialCents(net),discountCents:0,discountBps:0,unitWithoutIpiCents:commercialCents(price),unitWithIpiCents:commercialCents(unit),netSaleCents:commercialCents(net),ipiCents:commercialCents(amount-net),ipiBps:p.ipiBps,invoiceTotalCents:commercialCents(amount),minimumDownPaymentBps:p.minimumDownPaymentBps,minimumDownPaymentCents:commercialCents(rounded(amount*BigInt(p.minimumDownPaymentBps),bps)),freeDiscountBps:p.freeDiscountBps,freightCents:0,band:"at_target",needsApproval:false,approvalReasons:[]}
  const pre=pretaxAt(price), pretax=roundSigned(pre,squared), income=rounded(incomeAt(pre),squared*bps)
  const equipment=rounded(adjusted*q,squared), tax=(r:number)=>rounded(net*BigInt(r),bps)
  const supplier=rounded(purchase*(bps+BigInt(p.costSafetyBps))*q,bps), target=tax(p.netMarginBps), factor=bps+BigInt(p.ipiBps)
  const required=up((supplier+target)*factor,factor-BigInt(p.commissionBps))
  const director={icmsCents:commercialCents(tax(icms)),pisCofinsCents:commercialCents(tax(p.pisCofinsBps)),channelCents:commercialCents(tax(channel)),provisionsCents:commercialCents(tax(provisions)),roundingCents:commercialCents(net-equipment-fixed-pretax-tax(icms)-tax(p.pisCofinsBps)-tax(channel)-tax(provisions)),equipmentCostCents:commercialCents(equipment),fixedFeeCents:commercialCents(fixed),profitBeforeIncomeTaxCents:commercialCents(pretax),incomeTaxCents:commercialCents(income),netProfitCents:commercialCents(pretax-income),netProfitBps:profitAt(price)/(squared*net),targetMarginBps:p.netMarginBps,atTargetBps:limit(true),noLossBps:limit(false),minimumTargetUnitWithIpiCents:commercialCents(gross(minUnit)),supplierPaymentCents:commercialCents(supplier),targetProfitCents:commercialCents(target),downPaymentCommissionCents:commercialCents(required-supplier-target),requiredDownPaymentCents:commercialCents(required),requiredDownPaymentBps:up(required*bps,amount)}
  const line=row.product_line, input={versionId:row.version_id,productId,quantity:qty,destination,taxpayer,discount:{kind:"percent",value:0},freightCents:0}
  const digest=createHash("sha256").update(canonicalJson({tenantId,line,input,calculator:"commercial-quote-v1-unit-cents",sale,director})).digest("hex")
  return {unit,amount,pricing:{tenantId,line,versionId:row.version_id,version:revisionValue(row.version),product:row.product_snapshot,input,digest,sale}}
}
export async function priceFor(c: Context, product: string, catalog: bigint, quantity: bigint, destination: string, taxpayer: boolean) {
  const args=[c.tenantId,product]
  const pub=(await c.client.query(`SELECT v.id AS version_id,v.version,v.product_line,v.policy_snapshot,i.product_snapshot,i.cost_snapshot,i.price_without_ipi_cents,p.unit=i.product_snapshot->>'unit' AS unit_matches
    FROM commercial_settings s JOIN price_table_versions v ON v.tenant_id=s.tenant_id AND v.id=s.active_price_version_id
    JOIN price_table_items i ON i.tenant_id=v.tenant_id AND i.version_id=v.id JOIN products p ON p.tenant_id=i.tenant_id AND p.id=i.product_id
    WHERE s.tenant_id=$1 AND i.product_id=$2 ORDER BY v.published_at DESC,v.id LIMIT 1`,args)).rows[0]
  if (pub) return publishedPrice(pub,c.tenantId,product,quantity,destination,taxpayer)
  const covered=(await c.client.query("SELECT 1 FROM product_costs c JOIN commercial_settings s ON s.tenant_id=c.tenant_id AND s.product_line=c.product_line WHERE c.tenant_id=$1 AND c.product_id=$2 AND s.active_price_version_id IS NOT NULL LIMIT 1",args)).rows[0]
  if (covered) conflict("Produto ausente da tabela publicada. Atualize a tabela comercial")
  return { unit:catalog,amount:rounded(catalog*quantity,1000000n),pricing:{source:"catalog"} }
}
