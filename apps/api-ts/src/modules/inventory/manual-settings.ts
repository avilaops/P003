import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"

const schema = z.strictObject({allowManualMovements:z.boolean(),minimumReasonLength:z.number().int().min(3).max(200)})
async function snapshot(context:AuthorizedContext) {
  const {rows:[row]}=await context.client.query("SELECT allow_manual_movements,minimum_reason_length,revision FROM inventory_settings WHERE tenant_id=$1",[context.tenantId])
  return {tenantId:context.tenantId,canEdit:context.permissions.includes("platform.company.manage"),revision:revisionValue(row?.revision??1),
    data:row?{allowManualMovements:row.allow_manual_movements,minimumReasonLength:row.minimum_reason_length}:null}
}

export function registerManualSettings(app:FastifyInstance,deps:AccessDependencies) {
  app.get("/api/v1/inventory-settings",async(req,reply)=>{
    const data=await authorizeRequest(req,deps,context=>{
      if(!["platform.company.manage","platform.company.read","inventory.stock.read"].some(p=>context.permissions.includes(p)))
        throw new Problem(403,"forbidden","Acesso não autorizado para esta empresa")
      return snapshot(context)
    })
    return reply.header("cache-control","no-store").header("etag",'"'+data.revision+'"').send(data)
  })
  app.put("/api/v1/inventory-settings",async(req,reply)=>{
    const result=await authorizeRequest(req,deps,async context=>{
      requirePermission(context,"platform.company.manage")
      const current=await snapshot(context), expected=parseRevision(req.headers["if-match"])
      if(expected!==current.revision) throw new Problem(412,"revision_conflict","A configuração de estoque mudou. Atualize a página")
      const checked=schema.safeParse(req.body)
      if(!checked.success) throw new Problem(422,"invalid_input","Informe a permissão de lançamentos e um motivo mínimo de 3 a 200 caracteres")
      const data=checked.data,next=nextRevision(expected)
      await context.client.query(`INSERT INTO inventory_settings(tenant_id,allow_manual_movements,minimum_reason_length,revision) VALUES($1,$2,$3,$4)
        ON CONFLICT(tenant_id) DO UPDATE SET allow_manual_movements=excluded.allow_manual_movements,minimum_reason_length=excluded.minimum_reason_length,
        revision=excluded.revision,updated_at=now()`,[context.tenantId,data.allowManualMovements,data.minimumReasonLength,next])
      await record(context,req.headers,"inventory_settings",context.tenantId,"inventory.settings.updated",{previousRevision:expected,revision:next,previous:current.data,data})
      return {...current,revision:next,data}
    })
    return reply.header("cache-control","no-store").header("etag",'"'+result.revision+'"').send(result)
  })
}
