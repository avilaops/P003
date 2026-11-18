import type { AppDependencies } from "../../app.js"
import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
export function fiscalEngine(deps:AppDependencies) {
  if(!deps.fiscalOperations)throw new Problem(503,"fiscal_engine_unavailable","Motor fiscal indisponível")
  return deps.fiscalOperations
}

// Persist the outcome even if the initiating operator has since lost permission.
// Callers verify the reserved run or event in the original tenant before settling it.
export async function settle<T>(deps:AppDependencies,actor:Omit<AuthorizedContext,"client">,work:(c:AuthorizedContext)=>Promise<T>) {
  const client=await deps.pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.auth_subject',$2,true)",[actor.tenantId,actor.authSubject])
    await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE",[actor.tenantId])
    const result=await work({...actor,client})
    await client.query("COMMIT")
    return result
  } catch(error){await client.query("ROLLBACK");throw error} finally {client.release()}
}
export function actorOf(c:AuthorizedContext) {return {tenantId:c.tenantId,authSubject:c.authSubject,identity:c.identity,permissions:c.permissions}}
