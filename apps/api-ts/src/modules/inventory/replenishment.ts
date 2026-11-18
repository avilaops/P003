import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest,requirePermission,type AuthorizedContext,type AccessDependencies } from "../../platform/access.js"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { commandKey,record,replay,remember } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { queryInteger,searchQuery } from "../registrations/query.js"
import { fixed,decimal } from "../sales/fixed.js"

const inputSchema=z.strictObject({minimum:z.string(),reorderPoint:z.string(),purchaseLot:z.string(),
  leadDays:z.number().int().min(0).max(3650),revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)})
const querySchema=z.strictObject({q:searchQuery,mode:z.enum(["needed","all"]).default("needed"),
  offset:queryInteger(0,100000).default(0),limit:queryInteger(1,100).default(25)})
const notFound=()=>new Problem(404,"not_found","Produto não encontrado nesta empresa")

function productId(value:unknown) {
  const parsed=normalizedDatabaseId.safeParse(value)
  if(!parsed.success) throw notFound()
  return parsed.data
}
function readAccess(context:AuthorizedContext) {
  if(!context.permissions.includes("purchasing.orders.read")) requirePermission(context,"inventory.stock.read")
}
const micros=(value:unknown)=>decimal(BigInt(String(value)),6)

async function position(context:AuthorizedContext,query:z.output<typeof querySchema>,id?:string) {
  const {rows}=await context.client.query(`
    WITH demand AS (
      SELECT l.product_id,coalesce(sum(l.quantity_micros) FILTER(WHERE o.status='confirmed'),0) reserved,
        coalesce(sum(l.quantity_micros) FILTER(WHERE o.status='accepted'),0) accepted
      FROM sales_order_lines l JOIN sales_orders o ON (o.tenant_id,o.id)=(l.tenant_id,l.order_id)
      WHERE l.tenant_id=$1 AND o.status IN ('accepted','confirmed') AND ($2::uuid IS NULL OR l.product_id=$2) GROUP BY l.product_id
    ), supply AS (
      SELECT l.product_id,sum(l.quantity_micros-l.received_micros) quantity FROM purchase_order_lines l
      JOIN purchase_orders o ON (o.tenant_id,o.id)=(l.tenant_id,l.order_id)
      WHERE l.tenant_id=$1 AND o.status IN ('confirmed','partially_received') AND ($2::uuid IS NULL OR l.product_id=$2) GROUP BY l.product_id
    ), basis AS (
      SELECT p.id,p.sku,p.name,p.unit,p.status,r.product_id IS NOT NULL AS configured,coalesce(r.revision,1) revision,
        coalesce(r.minimum_micros,0) min,coalesce(r.reorder_micros,0) point,coalesce(r.lot_micros,0) lot,coalesce(r.lead_days,0) lead,
        coalesce(b.quantity_micros,0)-coalesce(d.reserved,0)-coalesce(held.quantity,0) available,coalesce(d.accepted,0) accepted,coalesce(s.quantity,0) supply
      FROM products p LEFT JOIN stock_replenishment_rules r ON (r.tenant_id,r.product_id)=(p.tenant_id,p.id)
      LEFT JOIN stock_balances b ON (b.tenant_id,b.product_id)=(p.tenant_id,p.id)
      LEFT JOIN demand d ON d.product_id=p.id LEFT JOIN supply s ON s.product_id=p.id
      LEFT JOIN (SELECT product_id,sum(quantity_micros) quantity FROM production_component_reservations
        WHERE tenant_id=$1 AND ($2::uuid IS NULL OR product_id=$2) GROUP BY product_id) held ON held.product_id=p.id
      WHERE p.tenant_id=$1 AND ($2::uuid IS NULL AND p.status='active' OR p.id=$2)
        AND (strpos(lower(p.sku),lower($3))>0 OR strpos(lower(p.name),lower($3))>0)
    ), needs AS (
      SELECT *,greatest(0,min+accepted-available-supply) need FROM basis
    ), matches AS (
      SELECT *,CASE WHEN lot>0 THEN div(need::numeric+lot-1,lot)*lot ELSE need END AS suggested
      FROM needs WHERE $4 OR (configured AND available-accepted<=point AND need>0)
    ), page AS (SELECT * FROM matches ORDER BY name,id LIMIT $5 OFFSET $6)
    SELECT page.*,totals.total FROM (SELECT count(*) AS total FROM matches) totals LEFT JOIN page ON true ORDER BY page.name,page.id`,
  [context.tenantId,id,query.q,query.mode==="all"||Boolean(id),query.limit,query.offset])
  return {tenantId:context.tenantId,canEdit:context.permissions.includes("inventory.stock.manage"),total:Number(rows[0]!.total),offset:query.offset,limit:query.limit,
    data:rows.filter(row=>row.id).map(row=>({productId:row.id,sku:row.sku,name:row.name,unit:row.unit,configured:row.configured,revision:Number(row.revision),
      minimum:micros(row.min),reorderPoint:micros(row.point),purchaseLot:micros(row.lot),leadDays:Number(row.lead),
      available:micros(row.available),acceptedDemand:micros(row.accepted),openPurchases:micros(row.supply),netNeed:micros(row.need),suggested:micros(row.suggested)}))}
}
async function detail(ctx:AuthorizedContext,id:string) {
  const result=await position(ctx,{q:"",mode:"all",offset:0,limit:1},id)
  const data=result.data[0]
  if(!data) throw notFound()
  return {tenantId:ctx.tenantId,canEdit:result.canEdit,data}
}

export function registerReplenishment(app:FastifyInstance,deps:AccessDependencies) {
  const path="/api/v1/stock/replenishment"
  app.get(path,(req,reply)=>{
    reply.header("cache-control","no-store")
    return authorizeRequest(req,deps,ctx=>{
      readAccess(ctx)
      const parsed=querySchema.safeParse(req.query)
      if(!parsed.success) throw new Problem(422,"invalid_input","Filtros de reposição inválidos")
      return position(ctx,parsed.data)
    })
  })
  app.get<{Params:{id:string}}>(path+"/:id",(req,reply)=>{
    reply.header("cache-control","no-store")
    return authorizeRequest(req,deps,ctx=>{readAccess(ctx);return detail(ctx,productId(req.params.id))})
  })
  app.put<{Params:{id:string}}>(path+"/:id",async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async ctx=>{
      requirePermission(ctx,"inventory.stock.manage")
      readAccess(ctx)
      const id=productId(req.params.id),key=commandKey(req.headers["idempotency-key"]),scope="stock.replenishment.updated"
      const parsed=inputSchema.safeParse(req.body)
      if(!parsed.success) throw new Problem(422,"invalid_input","Revise quantidades, prazo e revisão da regra")
      const input={...parsed.data,productId:id}, prior=await replay(ctx,key,scope,input)
      if(prior) return prior
      const before=await detail(ctx,id),minimum=fixed(input.minimum,6),point=fixed(input.reorderPoint,6),lot=fixed(input.purchaseLot,6)
      if(point<minimum) throw new Problem(422,"invalid_input","O ponto de pedido deve ser igual ou superior ao mínimo")
      if(before.data.revision!==input.revision) throw new Problem(412,"revision_conflict","A regra de reposição mudou. Atualize a página")
      await ctx.client.query(`INSERT INTO stock_replenishment_rules(tenant_id,product_id,minimum_micros,reorder_micros,lot_micros,lead_days,revision)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,product_id) DO UPDATE SET minimum_micros=excluded.minimum_micros,
          reorder_micros=excluded.reorder_micros,lot_micros=excluded.lot_micros,lead_days=excluded.lead_days,revision=excluded.revision`,
        [ctx.tenantId,id,minimum,point,lot,input.leadDays,input.revision+1])
      const saved=await detail(ctx,id)
      await record(ctx,req.headers,"stock_replenishment_rule",id,scope,input)
      await remember(ctx,key,scope,input,saved)
      return saved
    })
    return reply.header("cache-control","no-store").header("etag",'"'+String((result.data as {revision:number}).revision)+'"').send(result)
  })
}
