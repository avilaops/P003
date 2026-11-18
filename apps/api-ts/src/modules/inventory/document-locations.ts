import type {FastifyInstance} from "fastify"
import {z} from "zod"
import {authorizeRequest,requirePermission,type AccessDependencies,type AuthorizedContext} from "../../platform/access.js"
import {normalizedDatabaseId as id} from "../../platform/database-id.js"
import {commandKey,record,remember,replay} from "../../platform/commands.js"
import {Problem} from "../../platform/problem.js"
import {activeStockLocations} from "./locations.js"

const params=z.strictObject({kind:z.enum(["sale","purchase"]),id})
const change=z.strictObject({productId:id,warehouseId:id.nullable(),previousWarehouseId:id.nullable()})
const source={
  sale:{table:"sales_orders",lines:"sales_order_lines",permission:"sales.orders",editable:["draft","accepted"],default:"sales_id"},
  purchase:{table:"purchase_orders",lines:"purchase_order_lines",permission:"purchasing.orders",editable:["draft","confirmed","partially_received"],default:"purchase_id"},
} as const
const absent=()=>new Problem(404,"not_found","Pedido não encontrado nesta empresa")
async function read(ctx:AuthorizedContext,p:z.output<typeof params>){
  const s=source[p.kind]
  const order=(await ctx.client.query(`SELECT status FROM ${s.table} WHERE tenant_id=$1 AND id=$2`,[ctx.tenantId,p.id])).rows[0]
  if(!order) throw absent()
  const config=(await ctx.client.query(`SELECT enabled,${s.default} AS default FROM stock_location_settings WHERE tenant_id=$1`,[ctx.tenantId])).rows[0]
  const enabled=config?.enabled===true,editable=(s.editable as readonly string[]).includes(String(order.status))
  const lines=await ctx.client.query(`SELECT product_id AS "productId",sku,name,warehouse_id AS "warehouseId",
    ${p.kind==="purchase"?"received_micros<quantity_micros":"TRUE"} AS pending FROM ${s.lines} WHERE tenant_id=$1 AND order_id=$2 ORDER BY line_number`,[ctx.tenantId,p.id])
  return {tenantId:ctx.tenantId,id:p.id,kind:p.kind,enabled,canEdit:enabled&&editable&&ctx.permissions.includes(s.permission+".manage"),
    defaultId:config?.default??null,warehouses:enabled?await activeStockLocations(ctx):[],lines:lines.rows}
}
export function registerDocumentLocations(app:FastifyInstance,deps:AccessDependencies){
  const url="/api/v1/stock/document-locations/:kind/:id"
  app.get(url,(req,reply)=>{
    reply.header("cache-control","no-store")
    return authorizeRequest(req,deps,ctx=>{
      const p=params.safeParse(req.params)
      if(!p.success) throw absent()
      requirePermission(ctx,source[p.data.kind].permission+".read")
      return read(ctx,p.data)
    })
  })
  app.put(url,async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async ctx=>{
      const p=params.safeParse(req.params)
      if(!p.success) throw absent()
      const doc=p.data,s=source[doc.kind]
      requirePermission(ctx,s.permission+".read");requirePermission(ctx,s.permission+".manage")
      const parsed=change.safeParse(req.body)
      if(!parsed.success) throw new Problem(422,"invalid_input","Selecione um depósito ativo e um item do pedido")
      const key=commandKey(req.headers["idempotency-key"]),scope="stock.document.location",input={...doc,...parsed.data}
      const old=await replay(ctx,key,scope,input)
      if(old) return old
      await ctx.client.query(`SELECT id FROM ${s.table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[ctx.tenantId,doc.id])
      const state=await read(ctx,doc),line=state.lines.find(l=>l.productId===input.productId)
      if(!line) throw absent()
      if(!state.canEdit||!line.pending) throw new Problem(409,"domain_conflict","O pedido ou o controle por depósito não permite esta alteração")
      if(line.warehouseId!==input.previousWarehouseId) throw new Problem(412,"revision_conflict","O depósito do item mudou. Atualize o pedido")
      if(input.warehouseId&&!state.warehouses.some(w=>w.id===input.warehouseId)) throw new Problem(422,"invalid_input","Depósito indisponível nesta empresa")
      await ctx.client.query(`UPDATE ${s.lines} SET warehouse_id=$4 WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3`,[ctx.tenantId,doc.id,input.productId,input.warehouseId])
      const result={tenantId:ctx.tenantId,...input}
      await record(ctx,req.headers,doc.kind==="sale"?"sales_order":"purchase_order",doc.id,scope,result)
      await remember(ctx,key,scope,input,result)
      return result
    })
    return reply.header("cache-control","no-store").header("etag",'"'+req.headers["idempotency-key"]+'"').send(result)
  })
}
