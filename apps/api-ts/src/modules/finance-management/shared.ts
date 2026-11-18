import type { FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, type Revision } from "../../platform/revision.js"
import { decimal, fixed, validateDate } from "../sales/fixed.js"

export type Context = AuthorizedContext
export type Headers = FastifyRequest["headers"]
export const commissionRead = "finance.commissions.read",
  commissionManage = "finance.commissions.manage"
export const accountingRead = "finance.accounting.read",
  accountingManage = "finance.accounting.manage"
export function invalid(message: string): never {
  throw new Problem(422, "invalid_input", message)
}
export function conflict(message: string): never {
  throw new Problem(409, "domain_conflict", message)
}
export function missing(): never {
  throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
}
export function checkRevision(actual: unknown, expected: Revision) {
  if (BigInt(String(actual)) !== BigInt(expected))
    throw new Problem(412, "revision_conflict", "O registro mudou. Recarregue os dados.")
}
export function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const result = schema.safeParse(value)
  return result.success ? result.data : invalid("Confira os campos, formatos e limites informados")
}
export const day = z.number().int().min(1).max(28)
export const reason = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .refine((value) => !value.includes("\u0000"))
export const date = z.string().transform(validateDate)
export const month = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .refine((value) => !!validateDate(value + "-01"))
export const percent = z.string().refine((value) => fixed(value, 4) <= 1000000n)
export function money(amount: unknown) {
  const value = BigInt(String(amount))
  return (value < 0n ? "-" : "") + decimal(value < 0n ? -value : value, 2)
}
export function dueDate(competence: string, paymentDay: number) {
  const result = new Date(competence.slice(0, 7) + "-01T00:00:00.000Z")
  result.setUTCMonth(result.getUTCMonth() + 1, paymentDay)
  return validateDate(result.toISOString().slice(0, 10))
}
export function response(reply: FastifyReply, body: Record<string, unknown>, status = 200) {
  const data = body.data as Record<string, unknown> | undefined
  if (data?.revision !== undefined) reply.header("etag", '"' + String(data.revision) + '"')
  return reply.header("cache-control", "no-store").code(status).send(body)
}
type Apply<T> = (context: Context, input: T, revision: Revision) => Promise<Record<string, unknown>>
export async function command<T>(
  request: FastifyRequest,
  deps: AppDependencies,
  scope: string,
  id: string,
  permissions: string[],
  schema: z.ZodType<T>,
  apply: Apply<T>,
) {
  const key = commandKey(request.headers["idempotency-key"]),
    revision = parseRevision(request.headers["if-match"])
  return authorizeRequest(request, deps, async (context) => {
    for (const permission of permissions) requirePermission(context, permission)
    const input = parse(schema, request.body),
      envelope = { id, revision, input }
    const cached = await replay(context, key, scope, envelope)
    if (cached) return cached
    const result = await apply(context, input, revision)
    await remember(context, key, scope, envelope, result)
    return result
  })
}
export async function seller(context: Context, id: string, active = false) {
  const row = (
    await context.client.query("SELECT name,is_seller,status FROM staff WHERE tenant_id=$1 AND id=$2", [
      context.tenantId,
      id,
    ])
  ).rows[0]
  if (!row) missing()
  if (active && (!row.is_seller || row.status !== "active")) conflict("Selecione um vendedor ativo desta empresa")
  return String(row.name)
}
export async function lockSeller(context: Context, id: string) {
  const { client, tenantId } = context
  await client.query(
    "INSERT INTO commission_accounts(tenant_id,seller_staff_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [tenantId, id],
  )
  return (
    await client.query(
      "SELECT revision FROM commission_accounts WHERE tenant_id=$1 AND seller_staff_id=$2 FOR UPDATE",
      [tenantId, id],
    )
  ).rows[0]!.revision
}
export async function bumpSeller(context: Context, id: string) {
  await context.client.query(
    "UPDATE commission_accounts SET revision=revision+1 WHERE tenant_id=$1 AND seller_staff_id=$2",
    [context.tenantId, id],
  )
}
