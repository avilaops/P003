import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
type PriceSource = {productId:string;priceCents:number|bigint;priceOrigin?:PriceOrigin}

export type PriceOrigin = { kind: "customer" | "channel"; listId: string; name: string; revision: string; baseCents: number }
export async function applyPriceLists(context: AuthorizedContext, sources:PriceSource[], customerId?:string, channel?:string) {
 if (!customerId && !channel) return
 const {tenantId,client}=context
 const rows=await client.query<{product_id:string;kind:"customer"|"channel";id:string;name:string;revision:string;price_cents:string}>(`
 WITH sources AS (
  SELECT price_list_id,1 AS priority,'customer'::text AS kind FROM sales_customer_policies WHERE tenant_id=$1 AND customer_id=$2
  UNION ALL SELECT price_list_id,2,'channel' FROM sales_channel_prices WHERE tenant_id=$1 AND channel=$3
 )
 SELECT DISTINCT ON (i.product_id) i.product_id,s.kind,l.id,l.name,l.revision::text,i.price_cents::text
 FROM sources s JOIN price_lists l ON l.tenant_id=$1 AND l.id=s.price_list_id
 JOIN price_list_items i ON i.tenant_id=l.tenant_id AND i.price_list_id=l.id
 WHERE i.product_id=ANY($4::uuid[]) AND l.status='active'
 AND COALESCE(l.valid_from,'-infinity'::date)<=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date
 AND COALESCE(l.valid_until,'infinity'::date)>=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date
 ORDER BY i.product_id,s.priority`,[tenantId,customerId??null,channel??null,sources.map(s=>s.productId)])
 for(const source of sources){
   const row=rows.rows.find(r=>r.product_id===source.productId)
   if(!row) continue
   if(BigInt(row.price_cents)<=0n) throw new Problem(409,"domain_conflict","A lista selecionada contém preço inválido para este equipamento")
   source.priceCents=Number(row.price_cents)
   source.priceOrigin={kind:row.kind,listId:row.id,name:row.name,revision:row.revision,baseCents:Number(row.price_cents)}
 }
}
export async function catalogPriceSources(context: AuthorizedContext, products: string[], customerId: string, channel?:string) {
  const sources: PriceSource[] = products.map(productId=>({productId,priceCents:0n}))
  await applyPriceLists(context,sources,customerId,channel)
  return new Map(sources.filter(row=>row.priceOrigin).map(row=>[row.productId,row.priceOrigin!]))
}
export async function checkPriceCustomer(context:AuthorizedContext,input:{customerId?:string|undefined;items:{productId:string}[]},customerId:string){
 if (!input.customerId && (await catalogPriceSources(context,input.items.map(i=>i.productId),customerId)).size) throw new Problem(409,"domain_conflict","Este cliente tem uma lista de preços vigente. Recalcule com o cliente selecionado")
 if(input.customerId && input.customerId!==customerId) throw new Problem(409,"domain_conflict","Recalcule a negociação para o cliente escolhido")
}
