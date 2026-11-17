import { z } from "zod"
import type { AuthorizedContext } from "./access.js"
import { sameJson } from "./json.js"
import { Problem } from "./problem.js"

export function commandKey(value: string | string[] | undefined) {
  if (value === undefined) throw new Problem(428, "idempotency_required", "Informe Idempotency-Key para confirmar esta operação")
  const parsed = z.string().uuid().safeParse(value)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Idempotency-Key deve ser UUID")
  return parsed.data
}
export async function replay(context: AuthorizedContext, key: string, scope: string, input: unknown) {
  const result = await context.client.query<{ scope: string; request: unknown; result: Record<string, unknown> }>("SELECT scope,request,result FROM domain_commands WHERE tenant_id=$1 AND auth_subject=$2 AND command_key=$3", [context.tenantId, context.authSubject, key])
  if (!result.rows[0]) return undefined
  if (result.rows[0].scope !== scope || !sameJson(result.rows[0].request, input)) throw new Problem(409, "domain_conflict", "Esta chave de idempotência já foi usada com outros dados")
  return result.rows[0].result
}
export async function remember(context: AuthorizedContext, key: string, scope: string, input: unknown, result: unknown) {
  await context.client.query("INSERT INTO domain_commands(tenant_id,auth_subject,command_key,scope,request,result) VALUES($1,$2,$3,$4,$5,$6)", [context.tenantId, context.authSubject, key, scope, input, result])
}
export async function record(context: AuthorizedContext, headers: Record<string, string | string[] | undefined>, kind: string, id: string, event: string, details: unknown) {
  const requestId = typeof headers["x-request-id"] === "string" ? headers["x-request-id"] : null
  await context.client.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,entity_id,request_id,details) VALUES($1,(SELECT id FROM identities WHERE auth_subject=$2),$3,$4,$5,$6,$7)", [context.tenantId, context.authSubject, event, kind, id, requestId, details])
  await context.client.query("INSERT INTO outbox_events(tenant_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5)", [context.tenantId, kind, id, event, details])
}
