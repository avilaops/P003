import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, type Revision } from "../../platform/revision.js"

/** Permissões do módulo Serviços (S1 contratos recorrentes, S2 ordens de serviço). */
export const permissions = {
  contractsRead: "service.contracts.read",
  contractsManage: "service.contracts.manage",
  ordersRead: "service.orders.read",
  ordersManage: "service.orders.manage",
} as const

export const invalid = (message: string): never => { throw new Problem(422, "invalid_input", message) }
export const conflict = (message: string): never => { throw new Problem(409, "domain_conflict", message) }
export const notFound = (message = "Registro não encontrado nesta empresa"): never => { throw new Problem(404, "not_found", message) }
export function staleRevision(actual: unknown, expected: Revision) {
  if (BigInt(String(actual)) !== BigInt(expected)) throw new Problem(412, "revision_conflict", "O registro foi alterado. Atualize antes de confirmar.")
}
export function parse<T>(schema: z.ZodType<T>, data: unknown, message = "Confira os campos, formatos e limites informados"): T {
  const result = schema.safeParse(data)
  return result.success ? result.data : invalid(message)
}

export const id = z.guid()
export const text = (min: number, max: number) => z.string().trim().min(min).max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/)
export const isoDate = z.iso.date()
export const cents = z.number().int().min(0).max(99999999999999)
/** Quantidade decimal com até 6 casas, como no estoque (`"1.5"`). */
export const quantity = z.string().regex(/^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/).refine(value => /[1-9]/.test(value))
export function micros(value: string) {
  const [whole, fraction = ""] = value.split(".")
  return BigInt(whole! + fraction.padEnd(6, "0"))
}

/** Data de hoje no fuso da operação (o ERP fatura no calendário de Brasília). */
export function brazilToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

export function send(reply: FastifyReply, body: { data?: unknown } & Record<string, unknown>, status = 200) {
  const data = body.data as { revision?: unknown } | undefined
  if (data && typeof data === "object" && data.revision !== undefined) reply.header("etag", `"${String(data.revision)}"`)
  return reply.code(status).header("cache-control", "no-store").send(body)
}

export function readRoute<T>(request: FastifyRequest, deps: AccessDependencies, read: string, manage: string, load: (ctx: AuthorizedContext) => Promise<T>) {
  return authorizeRequest(request, deps, async ctx => {
    requirePermission(ctx, read)
    return { tenantId: ctx.tenantId, canEdit: ctx.permissions.includes(manage), ...await load(ctx) }
  })
}

export type Change = { data: Record<string, unknown>; aggregateId: string }
type CommandOptions<T> = {
  path: string; schema: z.ZodType<T>; scope: string; entity: string; read: string; manage: string
  /** Rotas com `:id` exigem If-Match; as de criação, não. */
  execute: (ctx: AuthorizedContext, input: T, id: string, expected: Revision) => Promise<Change>
  bodyLimit?: number
  fingerprint?: (input: T) => unknown
}
/** Escrita padrão: permissão de leitura e gestão, zod, Idempotency-Key, If-Match, auditoria e outbox. */
export function command<T>(app: FastifyInstance, deps: AccessDependencies, options: CommandOptions<T>) {
  const hasId = options.path.includes(":id")
  app.post<{ Params: { id: string } }>(options.path, options.bodyLimit ? { bodyLimit: options.bodyLimit } : {}, async (request, reply) => {
    const result = await authorizeRequest(request, deps, async ctx => {
      requirePermission(ctx, options.read)
      requirePermission(ctx, options.manage)
      const target = hasId ? parse(id, request.params.id, "Identificador inválido") : ""
      const expected = hasId ? parseRevision(request.headers["if-match"]) : 0
      const input = parse(options.schema, request.body)
      const key = commandKey(request.headers["idempotency-key"])
      const intent = { id: target, revision: expected, input: options.fingerprint ? options.fingerprint(input) : input }
      const previous = await replay(ctx, key, options.scope, intent)
      if (previous) return { value: previous, status: 200, replayed: true }
      const change = await options.execute(ctx, input, target, expected)
      const value = { tenantId: ctx.tenantId, canEdit: true, data: change.data }
      await record(ctx, request.headers, options.entity, change.aggregateId, options.scope, { tenantId: ctx.tenantId, data: change.data })
      await remember(ctx, key, options.scope, intent, value)
      return { value, status: hasId ? 200 : 201, replayed: false }
    })
    if (result.replayed) reply.header("idempotency-replayed", "true")
    return send(reply, result.value as { data?: unknown }, result.status)
  })
}
