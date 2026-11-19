import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest,requirePermission,type AuthorizedContext } from "../../platform/access.js"
import { commandKey,replay,remember,record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision,revisionValue } from "../../platform/revision.js"
import { channelCode,evaluate,previewSchema,type ImportResult,type ImportRow } from "./service.js"

const base="/api/v1/sales-imports"
const summary='id,filename,channel,status,revision,created_at AS "createdAt",confirmed_at AS "confirmedAt"'
function idOf(value:string) {
  const id=z.guid().safeParse(value)
  if(!id.success) throw new Problem(422,"invalid_input","Identificador de importação inválido")
  return id.data.toLowerCase()
}
async function job(c:AuthorizedContext,id:string) {
  const row=(await c.client.query(`SELECT ${summary},results FROM sales_order_imports WHERE tenant_id=$1 AND id=$2`,[c.tenantId,id])).rows[0]
  if(!row) throw new Problem(404,"not_found","Importação não encontrada")
  return {tenantId:c.tenantId,data:{...row,id,revision:revisionValue(row.revision)},canEdit:c.permissions.includes("sales.orders.manage")}
}
export function registerOrderImports(app:FastifyInstance,deps:AppDependencies) {
  app.get(base,async(req,reply)=>{
    const value=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,"sales.orders.read")
      const rows=await c.client.query(`SELECT ${summary} FROM sales_order_imports WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`,[c.tenantId])
      return {tenantId:c.tenantId,data:rows.rows,canEdit:c.permissions.includes("sales.orders.manage")}
    })
    return reply.header("cache-control","no-store").send(value)
  })
  app.get<{Params:{id:string}}>(base+"/:id",async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,"sales.orders.read")
      return job(c,idOf(req.params.id))
    })
    return reply.header("etag",`"${result.data.revision}"`).header("cache-control","no-store").send(result)
  })
  app.post(base+"/preview",async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,"sales.orders.read"); requirePermission(c,"sales.orders.manage")
      const parsed=previewSchema.safeParse(req.body)
      if(!parsed.success) throw new Problem(422,"invalid_input","Arquivo, canal ou linhas fora do formato permitido")
      const input=parsed.data, key=commandKey(req.headers["idempotency-key"]),scope="sales_import.previewed"
      const previous=await replay(c,key,scope,input)
      if(previous) return {value:previous,replayed:true}
      const id=randomUUID(),results=await evaluate(c,input.channel,input.rows)
      await c.client.query("INSERT INTO sales_order_imports(tenant_id,id,filename,channel,rows,results,status,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'previewed',$7)",[c.tenantId,id,input.filename,input.channel,JSON.stringify(input.rows),JSON.stringify(results),c.authSubject])
      const value=await job(c,id)
      await record(c,req.headers,"sales_import",id,scope,{channel:input.channel,rows:results.length})
      await remember(c,key,scope,input,value)
      return {value,replayed:false}
    })
    if(result.replayed) reply.header("idempotency-replayed","true")
    return reply.code(201).header("cache-control","no-store").header("etag",'"1"').send(result.value)
  })
  app.post<{Params:{id:string}}>(base+"/:id/confirm",async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,"sales.orders.read"); requirePermission(c,"sales.orders.manage")
      const id=idOf(req.params.id),revision=parseRevision(req.headers["if-match"]), key=commandKey(req.headers["idempotency-key"])
      if(!z.strictObject({}).safeParse(req.body).success) throw new Problem(422,"invalid_input","A confirmação usa o arquivo já validado")
      const scope="sales_import.confirmed",input={id,revision},previous=await replay(c,key,scope,input)
      if(previous) return {value:previous,replayed:true}
      const source=(await c.client.query("SELECT channel,revision,status,rows,results FROM sales_order_imports WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[c.tenantId,id])).rows[0]
      if(!source) throw new Problem(404,"not_found","Importação não encontrada")
      if(source.status==="confirmed") {
        const current=revisionValue(source.revision)
        if (revision!==current && BigInt(revision)!==BigInt(current)-1n) throw new Problem(412,"revision_conflict","A revisão da confirmação é inválida")
        const value=await job(c,id)
        await remember(c,key,scope,input,value)
        return {value,replayed:true}
      }
      if(revisionValue(source.revision)!==revision) throw new Problem(412,"revision_conflict","A prévia mudou. Atualize a importação")
      const results=await evaluate(c,String(source.channel),source.rows as ImportRow[],{id,trace:req.headers,preview:source.results as ImportResult[]})
      await c.client.query("UPDATE sales_order_imports SET status='confirmed',confirmed_at=clock_timestamp(),results=$3::jsonb,revision=revision+1 WHERE tenant_id=$1 AND id=$2",[c.tenantId,id,JSON.stringify(results)])
      const value=await job(c,id)
      await record(c,req.headers,"sales_import",id,scope,{channel:source.channel,orders:new Set(results.filter(r=>r.status==="imported").map(r=>r.orderId)).size})
      await remember(c,key,scope,input,value)
      return {value,replayed:false}
    })
    if(result.replayed) reply.header("idempotency-replayed","true")
    return reply.header("cache-control","no-store").header("etag",`"${(result.value.data as {revision:number}).revision}"`).send(result.value)
  })
  app.get<{Params:{channel:string};Querystring:{external?:string}}>("/api/v1/sales-channels/:channel/orders",async(req,reply)=>{
    const value=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,"sales.orders.read")
      const channel=channelCode.safeParse(req.params.channel),query=z.strictObject({external:z.string().min(1).max(120).optional()}).safeParse(req.query)
      if(!channel.success || !query.success) throw new Problem(422,"invalid_input","Canal ou filtro inválido")
      const rows=await c.client.query(`SELECT co.external_number AS "externalNumber",o.id AS "orderId",o.number::text AS "orderNumber",o.status,o.revision,o.updated_at AS "updatedAt" FROM sales_channel_orders co JOIN sales_orders o ON o.tenant_id=co.tenant_id AND o.id=co.order_id WHERE co.tenant_id=$1 AND co.channel=$2 AND ($3::text IS NULL OR co.external_number=$3) ORDER BY o.updated_at DESC,o.id DESC LIMIT 100`,[c.tenantId,channel.data,query.data.external])
      return {tenantId:c.tenantId,channel:channel.data,data:rows.rows}
    })
    return reply.header("cache-control","no-store").send(value)
  })
}
