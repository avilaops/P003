import {randomUUID} from "node:crypto"
import {z} from "zod"
import {type AuthorizedContext,requirePermission} from "../../platform/access.js"
import {commandKey,record,remember,replay} from "../../platform/commands.js"
import {normalizedDatabaseId as id} from "../../platform/database-id.js"
import {parseRevision,revisionValue,nextRevision} from "../../platform/revision.js"
import {fixed} from "../sales/fixed.js"
import {conflict,defaults,history,invalid,load,missing,stale,stockPermission,structure,type Headers} from "./read.js"

const component=z.strictObject({productId:id,quantity:z.string()})
const bill=z.strictObject({previousVersion:z.number().int().nonnegative(),components:z.array(component).min(1).max(200)})
const stage=z.strictObject({name:z.string().transform(s=>s.trim().replace(/\s+/g," ")).pipe(z.string().min(2).max(40)),position:z.number().int().min(1).max(10000),kind:z.enum(["andamento","pronta"])})
export async function publish(ctx:AuthorizedContext,headers:Headers,productId:string,body:unknown){
  stockPermission(ctx)
  const parsed=bill.safeParse(body)
  if(!parsed.success)throw invalid("Informe componentes, quantidades e a versão anterior")
  const {components,previousVersion}=parsed.data,key=commandKey(headers["idempotency-key"]),scope="production.structure"
  const input={productId,...parsed.data},prior=await replay(ctx,key,scope,input)
  if(prior)return prior
  const current=await structure(ctx,productId)
  if(previousVersion!==current.version)throw stale()
  if(current.product.status!=="active")throw conflict("Reative o produto antes de publicar a estrutura")
  const ids=components.map(c=>c.productId)
  if(ids.includes(productId)||new Set(ids).size!==ids.length)throw invalid("Os componentes precisam ser distintos entre si e do produto acabado")
  const existing=await ctx.client.query("SELECT id FROM products WHERE tenant_id=$1 AND status='active' AND id=ANY($2::uuid[])",[ctx.tenantId,ids])
  if(existing.rows.length!==ids.length)throw missing()
  const cyclic=await ctx.client.query(`WITH RECURSIVE latest AS (SELECT product_id,max(version) version FROM production_structures WHERE tenant_id=$1 GROUP BY product_id),
    branch(product) AS (SELECT unnest($2::uuid[]) UNION SELECT i.component_id FROM branch b JOIN latest l ON l.product_id=b.product
      JOIN production_structure_items i ON i.tenant_id=$1 AND i.product_id=l.product_id AND i.version=l.version)
    SELECT 1 FROM branch WHERE product=$3 LIMIT 1`,[ctx.tenantId,ids,productId])
  if(cyclic.rows.length)throw conflict("A estrutura criaria um ciclo entre os produtos")
  const version=current.version+1
  await ctx.client.query("INSERT INTO production_structures(tenant_id,product_id,version,created_by) VALUES($1,$2,$3,$4)",[ctx.tenantId,productId,version,ctx.authSubject])
  for(const c of components){
    const amount=fixed(c.quantity,6)
    if(amount<=0n)throw invalid("Informe quantidade positiva para cada componente")
    await ctx.client.query("INSERT INTO production_structure_items(tenant_id,product_id,version,component_id,per_unit_micros) VALUES($1,$2,$3,$4,$5)",[ctx.tenantId,productId,version,c.productId,amount])
  }
  const result={tenantId:ctx.tenantId,productId,version}
  await record(ctx,headers,"product",productId,scope,{version,components})
  await remember(ctx,key,scope,input,result)
  return result
}
export async function createOrders(ctx:AuthorizedContext,headers:Headers,body:unknown){
  requirePermission(ctx,"sales.orders.read")
  const parsed=z.strictObject({orderId:id}).safeParse(body)
  if(!parsed.success)throw invalid("Informe o pedido de origem")
  const order=parsed.data.orderId,revision=parseRevision(headers["if-match"]),key=commandKey(headers["idempotency-key"]),scope="production.create",input={orderId:order,revision}
  const prior=await replay(ctx,key,scope,input)
  if(prior)return prior
  const sale=(await ctx.client.query(`SELECT s.status,s.revision,((c.created_at AT TIME ZONE 'America/Sao_Paulo')::date+c.manufacturing_days)::text AS planned
    FROM sales_orders s LEFT JOIN sales_order_checkouts c ON (c.tenant_id,c.order_id)=(s.tenant_id,s.id) WHERE s.tenant_id=$1 AND s.id=$2 FOR UPDATE OF s`,[ctx.tenantId,order])).rows[0]
  if(!sale)throw missing()
  if(revisionValue(sale.revision)!==revision)throw stale()
  if(!["accepted","confirmed","completed"].includes(String(sale.status)))throw conflict("Envie um pedido aceito, reservado ou concluído")
  const lines=(await ctx.client.query(`SELECT l.product_id,l.sku,l.name,l.unit,l.quantity_micros,(SELECT max(version) FROM production_structures b
    WHERE b.tenant_id=l.tenant_id AND b.product_id=l.product_id) AS version FROM sales_order_lines l WHERE tenant_id=$1 AND order_id=$2 ORDER BY line_number`,[ctx.tenantId,order])).rows
  if(!lines.length)throw conflict("Pedido sem itens para fabricar")
  if(lines.some(l=>l.version))stockPermission(ctx)
  await defaults(ctx)
  await ctx.client.query("SELECT ensure_stock_location($1)",[ctx.tenantId])
  const site=(await ctx.client.query("SELECT CASE WHEN enabled THEN production_id ELSE opening_id END AS site FROM stock_location_settings WHERE tenant_id=$1",[ctx.tenantId])).rows[0]!.site
  const first=(await ctx.client.query("SELECT id FROM production_stages WHERE tenant_id=$1 AND kind='andamento' ORDER BY position,id LIMIT 1",[ctx.tenantId])).rows[0]!.id
  const data=[]
  for(const line of lines){
    const job=randomUUID()
    await ctx.client.query(`INSERT INTO production_orders(id,tenant_id,order_id,product_id,sku,name,unit,quantity_micros,stage_id,bom_version,warehouse_id,planned_on)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[job,ctx.tenantId,order,line.product_id,line.sku,line.name,line.unit,line.quantity_micros,first,line.version,site,sale.planned])
    await history(ctx,headers,job,"production.created",{orderId:order,revision:1,bomVersion:line.version})
    data.push(await load(ctx,job))
  }
  const result={tenantId:ctx.tenantId,data}
  await remember(ctx,key,scope,input,result)
  return result
}
export async function saveStage(ctx:AuthorizedContext,headers:Headers,stageId:string|null,body:unknown){
  const parsed=stage.safeParse(body)
  if(!parsed.success)throw invalid("Confira nome, tipo e posição da etapa")
  const {name,kind,position}=parsed.data,revision=stageId?parseRevision(headers["if-match"]):null,key=commandKey(headers["idempotency-key"]),scope="production.stage"
  const input={id:stageId,revision,input:parsed.data},prior=await replay(ctx,key,scope,input)
  if(prior)return prior
  await defaults(ctx)
  const target=stageId??randomUUID(),next=revision===null?1:nextRevision(revision)
  if(stageId){
    const current=(await ctx.client.query("SELECT kind,revision FROM production_stages WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,target])).rows[0]
    if(!current)throw missing()
    if(revisionValue(current.revision)!==revision)throw stale()
    if(current.kind!==kind)throw conflict("O tipo da etapa precisa permanecer igual")
    await ctx.client.query("UPDATE production_stages SET name=$3,position=$4,revision=$5 WHERE tenant_id=$1 AND id=$2",[ctx.tenantId,target,name,position,next])
  }else{
    if(kind!=="andamento")throw conflict("A etapa Pronto é única")
    await ctx.client.query("INSERT INTO production_stages(id,tenant_id,name,kind,position) VALUES($1,$2,$3,$4,$5)",[target,ctx.tenantId,name,kind,position])
  }
  const result={tenantId:ctx.tenantId,data:{id:target,name,kind,position,revision:next}}
  await record(ctx,headers,"production_stage",target,"production.stage_saved",result.data)
  await remember(ctx,key,scope,input,result)
  return result
}
