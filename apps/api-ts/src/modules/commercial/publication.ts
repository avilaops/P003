import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { canonicalJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, revisionValue } from "../../platform/revision.js"
import { invalidCommercial, parametersSchema, rounded, simulateParameters, up, type CommercialParameters } from "./parameters.js"
import { monthlyExpenses } from "./pricing-expenses.js"
import { lineSchema, lockPricingSnapshot, pricingInput, publicationManager, stale } from "./pricing-validation.js"

const calculator="legacy-managerial-v1-ceil-cents"
async function readInputs(c:AuthorizedContext,line:string) {
  const result=await c.client.query(`SELECT p.id AS "productId",p.sku,p.name,p.unit,p.price_revision AS "productRevision",c.revision AS "costRevision",
    c.purchase_cost_cents AS "purchaseCostCents",c.tax_credit_bps AS "taxCreditBps",c.packaging_cents AS "packagingCents"
    FROM product_costs c JOIN products p ON p.tenant_id=c.tenant_id AND p.id=c.product_id
    WHERE c.tenant_id=$1 AND c.product_line=$2 AND p.status='active' ORDER BY p.id LIMIT 5001`,[c.tenantId,line])
  if(result.rows.length>5000)invalidCommercial("Publicação limitada a 5000 produtos por linha")
  return result.rows.map(r=>({productId:String(r.productId),sku:String(r.sku),name:String(r.name),unit:String(r.unit),
    productRevision:revisionValue(r.productRevision),costRevision:revisionValue(r.costRevision),purchaseCostCents:BigInt(String(r.purchaseCostCents)),
    taxCreditBps:Number(r.taxCreditBps),packagingCents:BigInt(String(r.packagingCents))}))
}
type Cost=Awaited<ReturnType<typeof readInputs>>[number]
// Keep the full cost and margin fractions until the final cent, including IPI.
function prices(p:CommercialParameters,costs:number,c:Cost) {
  const retained=BigInt(10000-p.incomeTaxBps)
  const share=BigInt(10000-costs)*retained-BigInt(p.netMarginBps)*10000n
  const adjusted=c.purchaseCostCents*BigInt(10000-c.taxCreditBps)*BigInt(10000+p.costSafetyBps)+c.packagingCents*100000000n
  const denominator=share*BigInt(10000-p.freeDiscountBps)
  if(denominator<=0n||adjusted<=0n)invalidCommercial("O custo ajustado e a margem disponível devem ser positivos para publicar")
  const priceWithoutIpiCents=up(adjusted*retained,denominator)
  const priceWithIpiCents=up(priceWithoutIpiCents*BigInt(10000+p.ipiBps),10000n)
  if(priceWithIpiCents>1000000000000n)invalidCommercial("Preço calculado ultrapassa o limite de R$ 10 bilhões")
  return {priceWithoutIpiCents,ipiBps:p.ipiBps,priceWithIpiCents}
}
export async function suggestedDownPayment(c:AuthorizedContext,line:string,p:CommercialParameters,variableCostsBps:number) {
  const items=await readInputs(c,line)
  let worst:{numerator:bigint;denominator:bigint;sku:string}|null=null
  for(const item of items) {
    const priced=prices(p,variableCostsBps,item)
    const net=rounded(priced.priceWithoutIpiCents*BigInt(10000-p.freeDiscountBps),10000n)
    const gross=rounded(net*BigInt(10000+p.ipiBps),10000n)
    if(!gross)continue
    const numerator=(item.purchaseCostCents*BigInt(10000+p.costSafetyBps)+net*BigInt(p.netMarginBps))*BigInt(10000+p.ipiBps)
    const denominator=10000n*BigInt(10000+p.ipiBps-p.commissionBps)*gross
    if(denominator<=0n)invalidCommercial("Comissão inviabiliza a entrada sugerida")
    if(!worst||numerator*worst.denominator>worst.numerator*denominator)worst={numerator,denominator,sku:item.sku}
  }
  return worst?{recommendedBps:up(worst.numerator*20n,worst.denominator)*500n,exactBps:up(worst.numerator*10000n,worst.denominator),worstSku:worst.sku,canApply:worst.numerator<=worst.denominator}:null
}
async function candidate(c:AuthorizedContext,line:string) {
  const row=(await c.client.query("SELECT revision,parameters FROM commercial_settings WHERE tenant_id=$1 AND product_line=$2",[c.tenantId,line])).rows[0]
  if(!row)throw new Problem(409,"domain_conflict","Salve os parâmetros da linha antes de preparar a publicação")
  const policy={...(row.parameters as Record<string,unknown>),monthlyExpensesCents:await monthlyExpenses(c)}
  const settings=pricingInput(parametersSchema,policy),calculation=simulateParameters(settings),revision=revisionValue(row.revision)
  const inputs=await readInputs(c,line)
  if(!inputs.length)throw new Problem(409,"domain_conflict","Cadastre custos de pelo menos um produto ativo nesta linha")
  const items=inputs.map(input=>({...input,...prices(settings,calculation.variableCostsBps,input)}))
  const digest=createHash("sha256").update(canonicalJson({tenantId:c.tenantId,line,revision,policy,calculator,items})).digest("hex")
  return {policy,revision,digest,items}
}
export function registerPricePublication(app:FastifyInstance,deps:AccessDependencies) {
  const url="/api/v1/price-tables/:line"
  app.get<{Params:{line:string}}>(url,async(req,reply)=>{
    const body=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,publicationManager)
      const line=pricingInput(lineSchema,req.params.line)
      const data=(await c.client.query(`SELECT jsonb_build_object('id',v.id,'version',v.version,'settingsRevision',v.settings_revision,
        'publishedAt',v.published_at,'calculatorVersion',v.calculator_version,'items',(SELECT coalesce(jsonb_agg(jsonb_build_object(
        'productId',i.product_id,'sku',i.product_snapshot->>'sku','name',i.product_snapshot->>'name',
        'priceWithoutIpiCents',i.price_without_ipi_cents,'ipiBps',i.ipi_bps,'priceWithIpiCents',i.price_with_ipi_cents) ORDER BY i.product_id),'[]'::jsonb)
        FROM price_table_items i WHERE i.tenant_id=v.tenant_id AND i.version_id=v.id)) AS data FROM commercial_settings s
        JOIN price_table_versions v ON v.tenant_id=s.tenant_id AND v.id=s.active_price_version_id AND v.product_line=s.product_line
        WHERE s.tenant_id=$1 AND s.product_line=$2`,[c.tenantId,line])).rows[0]?.data??null
      return {tenantId:c.tenantId,line,data}
    })
    return reply.header("cache-control","no-store").send(body)
  })
  app.get<{Params:{line:string}}>(url+"/preview",async(req,reply)=>{
    const body=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,publicationManager)
      await lockPricingSnapshot(c)
      const line=pricingInput(lineSchema,req.params.line),p=await candidate(c,line)
      return {tenantId:c.tenantId,line,revision:p.revision,digest:p.digest,calculatorVersion:calculator,items:p.items}
    })
    return reply.header("cache-control","no-store").header("etag",'"'+body.revision+'"').send(body)
  })
  app.post<{Params:{line:string}}>(url+"/publish",async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,publicationManager)
      const line=pricingInput(lineSchema,req.params.line),revision=parseRevision(req.headers["if-match"]),key=commandKey(req.headers["idempotency-key"])
      const {digest}=pricingInput(z.strictObject({digest:z.string().regex(/^[a-f0-9]{64}$/)}),req.body)
      const scope="price_table.publish",command={line,revision,digest}
      const repeated=await replay(c,key,scope,command)
      let body=repeated
      if(!body){
        const p=await candidate(c,line)
        if(p.revision!==revision || p.digest!==digest)stale()
        let version=(await c.client.query("SELECT id,version FROM price_table_versions WHERE tenant_id=$1 AND product_line=$2 AND digest=$3",[c.tenantId,line,digest])).rows[0]
        if(!version) {
          const id=randomUUID()
          version=(await c.client.query(`INSERT INTO price_table_versions(id,tenant_id,product_line,version,settings_revision,policy_snapshot,calculator_version,digest,published_by)
            SELECT $1,$2,$3,(SELECT coalesce(max(version),0)+1 FROM price_table_versions WHERE tenant_id=$2 AND product_line=$3),$4,$5,$6,$7,id FROM identities WHERE auth_subject=$8 RETURNING id,version`,
            [id,c.tenantId,line,revision,p.policy,calculator,digest,c.authSubject])).rows[0]!
          const items=p.items.map(i=>({product_id:i.productId,product_snapshot:{sku:i.sku,name:i.name,unit:i.unit,revision:i.productRevision},cost_revision:i.costRevision,
            cost_snapshot:{purchaseCostCents:i.purchaseCostCents,taxCreditBps:i.taxCreditBps,packagingCents:i.packagingCents},
            price_without_ipi_cents:i.priceWithoutIpiCents,ipi_bps:i.ipiBps,price_with_ipi_cents:i.priceWithIpiCents}))
          await c.client.query(`INSERT INTO price_table_items(tenant_id,version_id,product_id,product_snapshot,cost_revision,cost_snapshot,price_without_ipi_cents,ipi_bps,price_with_ipi_cents)
            SELECT $1,$2,r.* FROM jsonb_to_recordset($3::jsonb) AS r(product_id uuid,product_snapshot jsonb,cost_revision bigint,cost_snapshot jsonb,price_without_ipi_cents bigint,ipi_bps integer,price_with_ipi_cents bigint)`,[c.tenantId,id,canonicalJson(items)])
          await record(c,req.headers,"price_table",id,"price_table.published",{line,version:revisionValue(version.version),itemCount:items.length})
        }
        await c.client.query("UPDATE commercial_settings SET active_price_version_id=$3 WHERE tenant_id=$1 AND product_line=$2",[c.tenantId,line,version.id])
        body={tenantId:c.tenantId,line,id:version.id,version:revisionValue(version.version),revision,itemCount:p.items.length,status:"published"}
        await remember(c,key,scope,command,body)
      }
      return {body, revision, replayed:Boolean(repeated)}
    })
    if(result.replayed) reply.header("idempotency-replayed","true")
    return reply.header("cache-control","no-store").header("etag",'"'+result.revision+'"').send(result.body)
  })
}
