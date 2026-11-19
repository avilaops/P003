import { z } from "zod"
import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest,requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey,record,remember,replay } from "../../platform/commands.js"
import { revisionValue,parseRevision } from "../../platform/revision.js"
import { Problem } from "../../platform/problem.js"
import { parsed } from "./schema.js"

const path="/api/v1/pos/settings"
const schema=z.strictObject({enabled:z.boolean()})
async function read(c:AuthorizedContext) {
  const row=(await c.client.query("SELECT enabled,revision FROM pos_settings WHERE tenant_id=$1",[c.tenantId])).rows[0]
  return {tenantId:c.tenantId,canEdit:c.permissions.includes("platform.company.manage"),data:{enabled:row?.enabled!==false,revision:row?revisionValue(row.revision):0}}
}
export function registerPosSettings(app:FastifyInstance,deps:AppDependencies) {
  app.get(path,async(req,reply)=>{
    const result=await authorizeRequest(req,deps,read)
    return reply.header("cache-control","no-store").header("etag",`"${result.data.revision}"`).send(result)
  })
  app.put(path,async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async c=>{
      requirePermission(c,"platform.company.manage")
      const expected=req.headers["if-match"]==='"0"' ? 0 : parseRevision(req.headers["if-match"])
      const key=commandKey(req.headers["idempotency-key"]), input={...parsed(schema,req.body),revision:expected}
      const previous=await replay(c,key,"pos.settings.updated",input)
      if (previous) return {value:previous,replayed:true}
      const current=await read(c)
      if (current.data.revision!==expected) throw new Problem(412,"revision_conflict","Outra pessoa alterou a preferência do PDV. Atualize os dados")
      await c.client.query("INSERT INTO pos_settings(tenant_id,enabled) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET enabled=EXCLUDED.enabled,revision=pos_settings.revision+1",[c.tenantId,input.enabled])
      const value=await read(c)
      await record(c,req.headers,"pos_settings",c.tenantId,"pos.settings.updated",input)
      await remember(c,key,"pos.settings.updated",input,value)
      return {value,replayed:false}
    })
    if (result.replayed) reply.header("idempotency-replayed","true")
    return reply.header("cache-control","no-store").header("etag",`"${(result.value.data as {revision:number}).revision}"`).send(result.value)
  })
}
