import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { parseRevision, type Revision } from "../../platform/revision.js"
import { open, close, movement } from "./cash.js"
import { checkout, cancel } from "./sales.js"
import { rights, current, sessions, sales, products, sessionDetail, saleDetail } from "./read.js"
import { registerPosSettings } from "./settings.js"
import { openInput, closeInput, movementInput, checkoutInput, cancelInput, uuid, parsed, currentQuery, sessionsQuery, salesQuery, productsQuery } from "./schema.js"

type Body = Record<string, unknown>
function replyWith(reply:FastifyReply, body:Body, status=200) {
  const owner=(body.session ?? body.data) as {revision?:Revision}|null
  if (owner?.revision !== undefined) reply.header("etag",`"${owner.revision}"`)
  return reply.code(status).header("cache-control","no-store").send(body)
}

export function registerPosRoutes(app: FastifyInstance, deps: AppDependencies) {
  registerPosSettings(app,deps)
  const base="/api/v1/pos"
  function get(path:string,load:(c:AuthorizedContext,id:string,query:unknown)=>Promise<Body>) {
    app.get<{Params:{id?:string}}>(base+path,async(req,reply)=>{
      const body=await authorizeRequest(req,deps,async c=>{
        requirePermission(c,"sales.pos.read")
        const id=req.params.id===undefined ? "" : parsed(uuid,req.params.id)
        return load(c,id,req.query)
      })
      return replyWith(reply,body)
    })
  }
  get("/sessions",(c,_,q)=>sessions(c,parsed(sessionsQuery,q)))
  get("/sessions/current",(c,_,q)=>current(c,parsed(currentQuery,q).register))
  get("/sessions/:id",async(c,id)=>({...rights(c),data:await sessionDetail(c,id)}))
  get("/products",(c,_,q)=>products(c,parsed(productsQuery,q)))
  get("/sales",(c,_,q)=>sales(c,parsed(salesQuery,q)))
  get("/sales/:id",(c,id)=>saleDetail(c,id))
  function command<T>(path:string,scope:string,permission:string,status:number,schema:z.ZodType<T>,run:(c:AuthorizedContext,id:string,revision:Revision,input:T)=>Promise<Body>) {
    app.post<{Params:{id?:string}}>(base+path,async(req,reply)=>{
      const result=await authorizeRequest(req,deps,async c=>{
        requirePermission(c,"sales.pos.read")
        requirePermission(c,"sales.pos."+permission)
        const key=commandKey(req.headers["idempotency-key"])
        const id=req.params.id===undefined ? "" : parsed(uuid,req.params.id)
        const revision=id ? parseRevision(req.headers["if-match"]) : 0
        const body=parsed(schema,req.body)
        const input=id ? { id,revision,input:body } : body
        const previous=await replay(c,key,scope,input)
        if (previous) return {value:previous,replayed:true}
        const value=await run(c,id,revision,body)
        const entity=(value.data as {id:string}).id
        await record(c,req.headers,"pos",entity,scope,input)
        await remember(c,key,scope,input,value)
        return {value,replayed:false}
      })
      if (result.replayed) reply.header("idempotency-replayed","true")
      return replyWith(reply,result.value,status)
    })
  }
  command("/sessions","pos.open","manage",201,openInput,(c,_,__,input)=>open(c,input))
  command("/sessions/:id/movements","pos.movement","manage",200,movementInput,movement)
  command("/sessions/:id/sales","pos.checkout","manage",201,checkoutInput,checkout)
  command("/sessions/:id/close","pos.close","close",200,closeInput,close)
  command("/sales/:id/cancel","pos.cancel","cancel",200,cancelInput,cancel)
}
