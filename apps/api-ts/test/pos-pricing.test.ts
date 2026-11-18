import assert from "node:assert/strict"
import test from "node:test"
import { publishedPrice } from "../src/modules/pos/pricing.js"
import { commercialFixture } from "./commercial-fixture.js"

test("PDV usa IPI e quantidade da publicação e preserva o sigilo do custo",()=>{
  const {parameters,input,sources}=commercialFixture()
  const source=sources[0]!, tenant="00000000-0000-4000-8000-123456789abc"
  const row={version:1,version_id:input.versionId,product_line:input.line,product_snapshot:{sku:source.sku,unit:source.unit},unit_matches:true,policy_snapshot:parameters,price_without_ipi_cents:source.priceCents,cost_snapshot:{purchaseCostCents:source.purchaseCents,taxCreditBps:source.creditBps,packagingCents:source.packagingCents}}
  const price=publishedPrice(row,tenant,source.productId,2000000n,"SP",false)
  assert.equal(price.unit,1419645n)
  assert.equal(price.amount,price.unit*2n)
  assert.equal(price.pricing.sale.band,"at_target")
  assert.equal(price.pricing.sale.needsApproval,false)
  assert.match(price.pricing.digest,/^[a-f0-9]{64}$/)
  assert.doesNotMatch(Object.keys(price.pricing).join(" "),/director|cost/i)
  assert.throws(()=>publishedPrice(row,tenant,source.productId,500000n,"SP",false),/quantidade inteira/i)
  assert.throws(()=>publishedPrice({...row,price_without_ipi_cents:100},tenant,source.productId,1000000n,"SP",false),/aprovação/i)
})
