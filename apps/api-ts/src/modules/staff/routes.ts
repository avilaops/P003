import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { queryInteger } from "../registrations/query.js"
import { validateDate } from "../sales/fixed.js"
import { staffInputSchema, validateStaff, type StaffInput } from "./schema.js"

const read = "catalog.staff.read", manage = "catalog.staff.manage"
const projection = "id,revision,code,name,job_title,email,phone,is_employee,is_seller,status,profile"
const querySchema = z.strictObject({
  q: z.string().optional(), status: z.enum(["active", "archived"]).optional(), role: z.enum(["employee", "seller"]).optional(),
  offset: queryInteger(0, 100_000).default(0), limit: queryInteger(1, 100).default(25),
})
const filter = "tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND (strpos(lower(name),lower($3))>0 OR strpos(lower(COALESCE(job_title,'')),lower($3))>0 OR strpos(code,upper($3))>0) AND ($4::text IS NULL OR ($4='employee' AND is_employee) OR ($4='seller' AND is_seller))"
const profileKeys = ["cpf", "rg", "birthDate", "admissionDate", "documentIssuedOn", "pis", "ctps", "address", "emergencyPhone", "photo"] as const

function fullProfile(value: Record<string, unknown> | null | undefined) {
  return Object.fromEntries(profileKeys.map(key => [key, value?.[key] ?? null]))
}
function staff(row: Record<string, unknown>) {
  return {
    id: row.id, revision: revisionValue(row.revision), name: row.name, jobTitle: row.job_title, code: row.code,
    email: row.email, phone: row.phone, isEmployee: row.is_employee, isSeller: row.is_seller, status: row.status,
    profile: fullProfile(row.profile as Record<string, unknown> | null),
  }
}
function guard(id: string) { if (!z.guid().safeParse(id).success) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa") }
async function load(context: AuthorizedContext, id: string) {
  const result = await context.client.query(`SELECT ${projection} FROM staff WHERE tenant_id=$1 AND id=$2`, [context.tenantId, id])
  if (!result.rows[0]) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
  return staff(result.rows[0])
}
function codeConflict(error: unknown): never {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new Problem(409, "domain_conflict", "Código já cadastrado nesta empresa, inclusive em registro arquivado")
  throw error
}
function parseInput(body: unknown): StaffInput {
  const parsed = staffInputSchema.safeParse(body)
  if (!parsed.success) throw new Problem(422, "invalid_input", "JSON inválido ou campos desconhecidos")
  const input = validateStaff(parsed.data)
  for (const key of ["birthDate", "admissionDate", "documentIssuedOn"] as const) { const date = input.profile?.[key]; if (date) validateDate(date) }
  return input
}

// Dismissing an employee stops payroll: open titles are cancelled and paid history stays.
async function stopPayroll(context: AuthorizedContext, id: string, headers: Record<string, string | string[] | undefined>) {
  const has = await context.client.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM staff_payroll_profiles WHERE tenant_id=$1 AND staff_id=$2) OR EXISTS(SELECT 1 FROM staff_payroll_requests WHERE tenant_id=$1 AND staff_id=$2) AS exists", [context.tenantId, id])
  if (!has.rows[0]?.exists) return
  requirePermission(context, "finance.staff.approve")
  const titles = await context.client.query<{ id: string }>("SELECT p.id FROM payables p JOIN staff_payroll_obligations o ON o.tenant_id=p.tenant_id AND o.id=p.staff_obligation_id WHERE p.tenant_id=$1 AND o.staff_id=$2 AND p.status='open'", [context.tenantId, id])
  for (const title of titles.rows) await context.client.query("UPDATE payables SET status='cancelled',revision=revision+1 WHERE tenant_id=$1 AND id=$2 AND staff_obligation_id IS NOT NULL AND status='open'", [context.tenantId, title.id])
  await context.client.query("UPDATE staff_payroll_profiles SET settings=jsonb_set(settings,'{recurring}','false'),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND staff_id=$2", [context.tenantId, id])
  await context.client.query("UPDATE staff_payroll_requests SET status='cancelled',revision=revision+1,reviewed_by=$3,review_reason='Funcionário desligado',reviewed_at=now() WHERE tenant_id=$1 AND staff_id=$2 AND status='pending'", [context.tenantId, id, context.authSubject])
  await record(context, headers, "staff", id, "staff.payroll.stopped", { cancelledTitles: titles.rows.length, paidHistoryPreserved: true })
}

export function registerStaffRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/staff", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query)
    if (!parsed.success || (parsed.data.q ?? "").trim().length > 0 && [...(parsed.data.q ?? "").trim()].length > 160) throw new Problem(422, "invalid_input", "Busca, paginação, situação ou papel inválido")
    const query = parsed.data, q = (query.q ?? "").trim()
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, read)
      const values = [context.tenantId, query.status ?? null, q, query.role ?? null]
      const rows = await context.client.query(`SELECT ${projection} FROM staff WHERE ${filter} ORDER BY name,id LIMIT $5 OFFSET $6`, [...values, query.limit, query.offset])
      const count = await context.client.query<{ total: string }>(`SELECT count(*)::text AS total FROM staff WHERE ${filter}`, values)
      return { tenantId: context.tenantId, canEdit: context.permissions.includes(manage), data: rows.rows.map(staff), total: Number(count.rows[0]?.total ?? 0), offset: query.offset, limit: query.limit }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.get<{ Params: { id: string } }>("/api/v1/staff/:id", async (request, reply) => {
    guard(request.params.id)
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, read)
      return { tenantId: context.tenantId, canEdit: context.permissions.includes(manage), data: await load(context, request.params.id) }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })

  app.post("/api/v1/staff", async (request, reply) => {
    const key = commandKey(request.headers["idempotency-key"])
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, read)
      requirePermission(context, manage)
      const input = parseInput(request.body)
      const previous = await replay(context, key, "staff.create", input)
      if (previous) return previous as { data: { revision: number } }
      const id = randomUUID()
      await context.client.query("INSERT INTO staff(id,tenant_id,code,name,job_title,email,phone,is_employee,is_seller,status,profile) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [id, context.tenantId, input.code, input.name, input.jobTitle, input.email, input.phone, input.isEmployee, input.isSeller, input.status, fullProfile(input.profile)]).catch(codeConflict)
      const result = { tenantId: context.tenantId, canEdit: true, data: await load(context, id) }
      await record(context, request.headers, "staff", id, "staff.created", { revision: 1, isEmployee: input.isEmployee, isSeller: input.isSeller })
      await remember(context, key, "staff.create", input, result)
      return result
    })
    return reply.code(201).header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })

  app.put<{ Params: { id: string } }>("/api/v1/staff/:id", async (request, reply) => {
    const expected = parseRevision(request.headers["if-match"])
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, read)
      requirePermission(context, manage)
      guard(request.params.id)
      const input = parseInput(request.body)
      const previous = await load(context, request.params.id)
      if (previous.revision !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      if (input.status === "archived" && previous.status !== "archived" || previous.isEmployee && !input.isEmployee) await stopPayroll(context, request.params.id, request.headers)
      const next = nextRevision(expected)
      await context.client.query("UPDATE staff SET code=$3,name=$4,job_title=$5,email=$6,phone=$7,is_employee=$8,is_seller=$9,status=$10,revision=$11,profile=COALESCE($12,profile),updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [context.tenantId, request.params.id, input.code, input.name, input.jobTitle, input.email, input.phone, input.isEmployee, input.isSeller, input.status, next, input.profile ? fullProfile(input.profile) : null]).catch(codeConflict)
      await record(context, request.headers, "staff", request.params.id, "staff.updated", { previousRevision: expected, revision: next, isEmployee: input.isEmployee, isSeller: input.isSeller })
      return { tenantId: context.tenantId, canEdit: true, data: await load(context, request.params.id) }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })
}
