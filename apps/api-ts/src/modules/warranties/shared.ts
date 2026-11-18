import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision } from "../../platform/revision.js"
import { earlierWarrantyCommand } from "./command-history.js"

export const read = "service.warranties.read"
export const manage = "service.warranties.manage"
export const approve = "service.warranties.approve"
export const invalid = (message: string): never => { throw new Problem(422, "invalid_input", message) }
export const conflict = (message: string): never => { throw new Problem(409, "domain_conflict", message) }
export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  return result.success ? result.data : invalid("Dados de garantia inválidos")
}
export const idParam = z.guid()
export const criticalities = z.enum(["low","normal","high","critical"])
export const statuses = z.enum(["opened","triage","diagnosis","treatment","resolved","closed","cancelled"])
export const limitedText = (min: number, max: number) => z.string().trim().min(min).max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/)
export const money = z.number().int().min(0).max(99999999999999)
export const metadata = z.record(z.string(),z.unknown())
export function capabilities(ctx: AuthorizedContext) {
  return { tenantId: ctx.tenantId, canEdit: ctx.permissions.includes(manage), canApprove: ctx.permissions.includes(approve) }
}
export function event(ctx: AuthorizedContext, caseId: string, type: string, status: string, details: unknown) {
  return ctx.client.query("INSERT INTO warranty_case_events(id,tenant_id,case_id,event_type,status,details) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), ctx.tenantId, caseId, type, status, details])
}
type Entity = "warranty_cases" | "warranty_rmas" | "warranty_quarantines" | "warranty_service_orders"
export async function current(ctx: AuthorizedContext, entity: Entity, id: string, expected: number | bigint) {
  const row = (await ctx.client.query("SELECT * FROM " + entity + " WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [ctx.tenantId,id])).rows[0]
  if (!row) throw new Problem(404,"not_found","Registro de garantia não encontrado")
  if (String(row.revision) !== String(expected)) throw new Problem(412,"revision_conflict","O registro foi alterado. Atualize antes de confirmar.")
  return row
}
export type Change = { data: Record<string, unknown>; aggregateId: string }
export function command<T>(
  app: FastifyInstance, deps: AccessDependencies, path: string, schema: z.ZodType<T>, scope: string,
  entity: string, permission: string, execute: (context: AuthorizedContext, input: T, id: string, expected: number | bigint) => Promise<Change>,
  options?: { bodyLimit: number; fingerprint: (input: T) => unknown }
) {
  const hasId = path.includes(":id")
  app.post<{ Params: { id: string } }>(path, options ? {bodyLimit:options.bodyLimit} : {}, async (request, reply) => {
    const result = await authorizeRequest(request, deps, async ctx => {
      requirePermission(ctx,read)
      requirePermission(ctx,permission)
      const id = hasId ? parse(idParam,request.params.id) : ""
      const expected = hasId ? parseRevision(request.headers["if-match"]) : 0
      const input = parse(schema,request.body)
      const key = commandKey(request.headers["idempotency-key"])
      const intent = { id, revision: expected, input: options ? options.fingerprint(input) : input }
      const previous = await replay(ctx,key,scope,intent,earlierWarrantyCommand(scope,id,expected,input))
      if (previous) {
        const data=previous.data as Record<string,unknown>
        return {value:{...capabilities(ctx),data:{...data,revision:data.revision??1}},status:200,replayed:true}
      }
      const change = await execute(ctx,input,id,expected)
      const value = { ...capabilities(ctx), data: change.data }
      await record(ctx,request.headers,entity,change.aggregateId,scope,{tenantId:ctx.tenantId,data:value.data})
      await remember(ctx,key,scope,intent,value)
      return { value, status: hasId ? 200 : 201 }
    })
    const data = result.value.data as Record<string, unknown>
    if (result.replayed) reply.header("idempotency-replayed","true")
    return reply.code(result.status).header("cache-control","no-store").header("etag",'"' + String(data.revision) + '"').send(result.value)
  })
}
export async function readWith<T>(request: FastifyRequest, deps: AccessDependencies, load: (ctx: AuthorizedContext) => Promise<T>) {
  return authorizeRequest(request,deps,async ctx => { requirePermission(ctx,read); return { ...capabilities(ctx), ...await load(ctx) } })
}
