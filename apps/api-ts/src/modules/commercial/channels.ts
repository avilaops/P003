import {randomUUID} from "node:crypto"
import {z} from "zod"
import type {FastifyInstance} from "fastify"
import type {AppDependencies} from "../../app.js"
import {authorizeRequest,requirePermission} from "../../platform/access.js"
import {commandKey,record,remember,replay} from "../../platform/commands.js"
import {normalizedDatabaseId as id} from "../../platform/database-id.js"
import {Problem} from "../../platform/problem.js"
import {revisionValue} from "../../platform/revision.js"
import {publishedProducts} from "../order-imports/pricing.js"
import {prepareMixed} from "./mixed-prepare.js"
import {channelCode} from "../order-imports/service.js"
import {heldQuantity} from "../orders/fulfillment.js"
import {applyPriceLists,type PriceOrigin} from "./price-origin.js"
import {registerChannelTransport} from "./channel-service.js"

const root="/api/v1/commercial/policies/store"
const rev=z.number().int().nonnegative().safe(), label=z.string().trim().min(1).max(120).regex(/^[^\p{Cc}]+$/u)
const settings=z.discriminatedUnion("kind",[
 z.strictObject({kind:z.literal("return"),channel:channelCode,eventId:label,returnId:id}),
 z.strictObject({kind:z.literal("connector"),channel:channelCode,name:label,keyId:id,enabled:z.boolean(),revision:rev}),
 z.strictObject({kind:z.literal("listing"),id:id.optional(),channel:channelCode,productId:id,reference:label,title:label,revision:rev}),
 z.strictObject({kind:z.literal("delivery"),id,action:z.enum(["publish","sync","pause"]),revision:rev.min(1)})
])
const listings=`SELECT l.id,l.product_id AS "productId",p.sku,p.name AS product,l.channel,l.title,l.external_ref AS reference,l.status,l.revision::int,
 (SELECT jsonb_build_object('id',d.id,'status',d.status,'action',d.action,'reference',d.confirmation,'at',coalesce(d.confirmed_at,d.created_at)) FROM sales_channel_deliveries d
  WHERE d.tenant_id=l.tenant_id AND d.listing_id=l.id ORDER BY d.created_at DESC,d.id DESC LIMIT 1) AS delivery
 FROM sales_channel_listings l JOIN products p ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id) WHERE l.tenant_id=$1`
const changed=()=>new Problem(412,"revision_conflict","O registro mudou. Atualize a consulta")
const invalid=(s:string)=>new Problem(422,"invalid_input",s)
export function registerSalesChannels(app:FastifyInstance,deps:AppDependencies){
 registerChannelTransport(app,deps)
 app.get<{Params:{id?:string}}>(root+"/:id?",async(req,reply)=>{
  if(req.params.id&&!id.safeParse(req.params.id).success)throw invalid("Anúncio inválido")
  const query=z.strictObject({offset:z.coerce.number().int().min(0).max(2147483647).default(0),channel:channelCode.optional()}).safeParse(req.query)
  if(!query.success)throw invalid("Filtro de canal inválido")
  const {offset,channel}=query.data
  const result=await authorizeRequest(req,deps,async ctx=>{
   requirePermission(ctx,"sales.orders.read")
   const {client,tenantId}=ctx, canConfigure=ctx.permissions.includes("platform.integrations.manage")
   const data=(await client.query(listings+" AND ($2::uuid IS NULL OR l.id=$2) AND ($3::text IS NULL OR l.channel=$3) ORDER BY l.channel,l.external_ref,l.id LIMIT 51 OFFSET $4",[tenantId,req.params.id??null,channel??null,offset])).rows
   if(req.params.id&&!data.length)throw new Problem(404,"not_found","Anúncio não encontrado")
   const connectors=(await client.query(`SELECT c.code,c.name,c.enabled,c.revision::int,CASE WHEN $2 THEN c.service_key_id END AS "keyId",k.revoked_at IS NULL AS "keyActive" FROM sales_connectors c JOIN service_api_keys k ON (k.tenant_id,k.id)=(c.tenant_id,c.service_key_id) WHERE c.tenant_id=$1 ORDER BY c.name`,[tenantId,canConfigure])).rows
   const keys=canConfigure?(await client.query("SELECT id,name FROM service_api_keys WHERE tenant_id=$1 AND revoked_at IS NULL ORDER BY name",[tenantId])).rows:[]
   const orders=(await client.query(`SELECT c.channel,c.external_number AS external,o.id,o.number::text,o.status,
    coalesce((SELECT sum(l.quantity_micros-order_line_delivered(l.tenant_id,l.order_id,l.line_number)) FROM sales_order_lines l WHERE l.tenant_id=o.tenant_id AND l.order_id=o.id AND o.status='confirmed'),0)::text AS "reservedMicros"
    FROM sales_channel_orders c JOIN sales_orders o ON (o.tenant_id,o.id)=(c.tenant_id,c.order_id) WHERE c.tenant_id=$1 AND ($2::text IS NULL OR c.channel=$2) ORDER BY o.updated_at DESC,o.id LIMIT 50`,[tenantId,channel??null])).rows
   const events=(await client.query(`SELECT i.event_id AS id,i.kind,i.channel,i.external_number AS external,i.received_at AS at,i.import_id AS "importId",c.order_id AS "orderId",
    CASE WHEN i.kind='return' AND i.return_id IS NULL THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'reason',r.reason) ORDER BY r.created_at DESC),'[]'::jsonb)
      FROM sales_partial_returns r JOIN sales_invoice_lots l ON (l.tenant_id,l.id)=(r.tenant_id,r.lot_id)
      WHERE r.tenant_id=c.tenant_id AND l.order_id=c.order_id AND l.environment='production' AND NOT EXISTS(SELECT 1 FROM sales_channel_inbox used WHERE used.tenant_id=r.tenant_id AND used.return_id=r.id)) END AS "availableReturns",
    CASE WHEN i.kind='order' THEN CASE WHEN c.order_id IS NULL THEN 'awaiting_import' ELSE o.status END
         WHEN i.kind='cancel' AND o.status='cancelled' THEN 'reconciled'
         WHEN i.kind='return' AND i.return_id IS NOT NULL THEN 'reconciled'
         ELSE 'awaiting_reconciliation' END AS status
    FROM sales_channel_inbox i LEFT JOIN sales_channel_orders c ON (c.tenant_id,c.channel,c.external_number)=(i.tenant_id,i.channel,i.external_number)
    LEFT JOIN sales_orders o ON o.tenant_id=c.tenant_id AND o.id=c.order_id WHERE i.tenant_id=$1 AND ($2::text IS NULL OR i.channel=$2) ORDER BY i.received_at DESC,i.event_id LIMIT 50`,[tenantId,channel??null])).rows
   return {tenantId,canConfigure,canEdit:ctx.permissions.includes("sales.orders.manage"),keys,connectors,listings:data.slice(0,50),more:data.length>50,orders,events}
  })
  return reply.header("cache-control","no-store").send(result)
 })
 app.post(root,async(req,reply)=>{
  const parsed=settings.safeParse(req.body)
  if(!parsed.success)throw invalid("Confira o canal, o produto e a revisão")
  const input=parsed.data
  const result=await authorizeRequest(req,deps,async ctx=>{
   requirePermission(ctx,"sales.orders.read");requirePermission(ctx,input.kind==="connector"?"platform.integrations.manage":"sales.orders.manage")
   const {tenantId,client}=ctx,key=commandKey(req.headers["idempotency-key"]),scope="channel."+input.kind
   const repeated=await replay(ctx,key,scope,input)
   if(repeated) return repeated
   let result:{id:string;revision:number;deliveryId?:string}
   if(input.kind==="return"){
    const saved=(await client.query(`UPDATE sales_channel_inbox i SET return_id=$4 FROM sales_channel_orders co JOIN sales_invoice_lots l ON l.tenant_id=co.tenant_id AND l.order_id=co.order_id
     JOIN sales_partial_returns r ON r.tenant_id=l.tenant_id AND r.lot_id=l.id WHERE i.tenant_id=$1 AND i.channel=$2 AND i.event_id=$3 AND i.kind='return'
     AND (i.return_id IS NULL OR i.return_id=$4) AND (co.tenant_id,co.channel,co.external_number)=(i.tenant_id,i.channel,i.external_number) AND r.id=$4 AND l.environment='production' RETURNING i.event_id`,[tenantId,input.channel,input.eventId,input.returnId])).rows[0]
    if(!saved) throw invalid("Selecione uma devolução fiscal do pedido de origem")
    result={id:input.eventId,revision:1}
   }else if(input.kind==="connector"){
    const keyExists=(await client.query("SELECT id FROM service_api_keys WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL",[tenantId,input.keyId])).rows.length
    if(!keyExists)throw invalid("Selecione uma chave ativa da empresa")
    const taken=(await client.query("SELECT code FROM sales_connectors WHERE tenant_id=$1 AND service_key_id=$2 AND code<>$3",[tenantId,input.keyId,input.channel])).rows.length
    if(taken)throw invalid("Essa chave já pertence a outro canal")
    const row=(await client.query(`INSERT INTO sales_connectors(tenant_id,code,name,service_key_id,enabled)
      SELECT $1,$2,$3,$4,$5 WHERE $6::bigint=0 OR EXISTS(SELECT FROM sales_connectors WHERE tenant_id=$1 AND code=$2)
      ON CONFLICT(tenant_id,code) DO UPDATE SET name=$3,service_key_id=$4,enabled=$5,revision=sales_connectors.revision+1 WHERE sales_connectors.revision=$6 RETURNING revision::int`,[tenantId,input.channel,input.name,input.keyId,input.enabled,input.revision])).rows[0]
    if(!row)throw changed();result={id:input.channel,revision:Number(row.revision)}
   }else if(input.kind==="listing"){
    const listing=input.id??randomUUID()
    if(!(await client.query("SELECT 1 FROM sales_connectors c JOIN products p ON p.tenant_id=c.tenant_id WHERE c.tenant_id=$1 AND c.code=$2 AND p.id=$3 AND p.status='active'",[tenantId,input.channel,input.productId])).rows.length)throw invalid("Selecione um canal e um produto ativo da empresa")
    if((await client.query("SELECT 1 FROM sales_channel_listings WHERE tenant_id=$1 AND channel=$2 AND external_ref=$3 AND id<>$4",[tenantId,input.channel,input.reference,listing])).rows.length)throw invalid("Referência externa já vinculada neste canal")
    const row=(await client.query(`INSERT INTO sales_channel_listings(tenant_id,id,channel,product_id,external_ref,title)
      SELECT $1,$2,$3,$4,$5,$6 WHERE $7::bigint=0 OR EXISTS(SELECT FROM sales_channel_listings WHERE tenant_id=$1 AND id=$2)
      ON CONFLICT(tenant_id,id) DO UPDATE SET title=$6,revision=sales_channel_listings.revision+1
      WHERE sales_channel_listings.revision=$7 AND sales_channel_listings.channel=$3 AND sales_channel_listings.product_id=$4 AND sales_channel_listings.external_ref=$5
      AND NOT EXISTS(SELECT FROM sales_channel_deliveries WHERE tenant_id=$1 AND listing_id=$2 AND status='pending') RETURNING revision::int`,[tenantId,listing,input.channel,input.productId,input.reference,input.title,input.revision])).rows[0]
    if(!row)throw changed();result={id:listing,revision:Number(row.revision)}
   }else{
    const row=(await client.query(`SELECT l.*,c.enabled,k.revoked_at,p.sku,p.price_cents,p.status AS product_status,coalesce(b.quantity_micros,0) AS balance
      FROM sales_channel_listings l JOIN sales_connectors c ON (c.tenant_id,c.code)=(l.tenant_id,l.channel)
      JOIN service_api_keys k ON (k.tenant_id,k.id)=(c.tenant_id,c.service_key_id)
      JOIN products p ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id) LEFT JOIN stock_balances b ON (b.tenant_id,b.product_id)=(p.tenant_id,p.id)
      WHERE l.tenant_id=$1 AND l.id=$2`,[tenantId,input.id])).rows[0]
    if(!row)throw new Problem(404,"not_found","Anúncio não encontrado")
    if(revisionValue(row.revision)!==input.revision)throw changed()
    if(!row.enabled||row.revoked_at||input.action!=="pause"&&row.product_status!=="active")throw invalid("O conector, a chave e o produto precisam estar ativos")
    if(input.action==="publish"?row.status==="published":row.status!=="published")throw invalid("Ação incompatível com o estado do anúncio")
    if((await client.query("SELECT id FROM sales_channel_deliveries WHERE tenant_id=$1 AND listing_id=$2 AND status='pending'",[tenantId,input.id])).rows.length)throw new Problem(409,"domain_conflict","Aguarde a confirmação da operação pendente")
    const delivery=randomUUID(),held=await heldQuantity(ctx,row.product_id),free=BigInt(String(row.balance))-held
    const item:{productId:string;priceCents:number|bigint;priceOrigin?:PriceOrigin}={productId:String(row.product_id),priceCents:BigInt(String(row.price_cents))}
    await applyPriceLists(ctx,[item],undefined,String(row.channel))
    let unitPriceCents=String(item.priceCents),priceVersionId:string|null=null
    if(input.action!=="pause"){
     const publications=await publishedProducts(ctx,[String(row.product_id)])
     if(publications.length>1)throw invalid("O produto deve ter uma publicação vigente única para este anúncio")
     const version=publications[0]
     if(version){
      const priced=await prepareMixed(ctx,{channel:String(row.channel),destinationState:version.origin,taxpayer:false,discount:{kind:"percent",value:0},freightCents:0,downPaymentCents:null,
       items:[{productId:String(row.product_id),line:version.line,versionId:version.version,quantity:1,structureColor:null,swingArmColor:null,plateHolderColor:null,plateHolderType:null,upholsteryColor:null}]})
      unitPriceCents=String(priced.sale.totalCents);priceVersionId=version.version
     }
    }
    const payload={priceVersionId,reference:row.external_ref,sku:row.sku,title:row.title,availableMicros:String(free<0n?0n:free),unitPriceCents,priceList:item.priceOrigin?.listId??null}
    await client.query("INSERT INTO sales_channel_deliveries(tenant_id,id,listing_id,action,payload) VALUES($1,$2,$3,$4,$5)",[tenantId,delivery,input.id,input.action,payload])
    await client.query("UPDATE sales_channel_listings SET revision=revision+1 WHERE tenant_id=$1 AND id=$2",[tenantId,input.id])
    result={id:input.id,revision:input.revision+1,deliveryId:delivery}
   }
   await record(ctx,req.headers,"sales_channel",result.id,scope,{revision:result.revision,...(input.kind==="delivery"?{action:input.action,deliveryId:result.deliveryId}:{})})
   const response={tenantId,...result}
   await remember(ctx,key,scope,input,response);return response
  })
  return reply.header("etag",'"'+String(result.revision)+'"').header("cache-control","no-store").send(result)
 })
}
