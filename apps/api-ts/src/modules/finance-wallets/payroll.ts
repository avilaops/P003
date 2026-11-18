import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import type { DatabasePool, TenantContext } from "../../platform/database.js"
import { commandKey, replay, remember, record } from "../../platform/commands.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { queryInteger } from "../registrations/query.js"
import { fixed, validateDate } from "../sales/fixed.js"
import { conflict, currentRevision, invalid, missing } from "./snapshot.js"
import { pathId } from "./documents.js"

const read = "finance.staff.read",
  manage = "finance.staff.manage",
  approve = "finance.staff.approve"
const str = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !/\p{Cc}/u.test(v))
const date = z.string().transform(validateDate),
  money = z.string().refine((v) => fixed(v, 2) > 0n)
const profileSchema = z
  .strictObject({
    salary: money,
    pixType: z.enum(["", "cpf", "cnpj", "email", "phone", "random"]).default(""),
    pixKey: str(200).default(""),
    recurring: z.boolean().default(false),
    businessDay: z.union([z.literal(1), z.literal(5)]),
    startsOn: date,
    excludedDates: z.array(date).max(366).default([]),
    bank: str(200).default(""),
    branch: str(200).default(""),
    account: str(200).default(""),
  })
  .refine((s) => Boolean(s.pixKey) === Boolean(s.pixType))
const paymentSchema = z.strictObject({
  amount: money,
  dueDate: date,
  category: str(120).refine((v) => !!v.trim()),
  note: str(500).default(""),
})
const proposal = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("settings"),
    baseRevision: z.number().int().nonnegative(),
    settings: profileSchema,
  }),
  z.strictObject({ kind: z.literal("payment"), payment: paymentSchema }),
])
type Profile = z.infer<typeof profileSchema>
function valid<T>(schema: z.ZodType<T>, value: unknown) {
  const v = schema.safeParse(value)
  if (!v.success) invalid("Dados de folha inválidos")
  return v.data
}
async function employee(ctx: TenantContext, id: string, active = true) {
  const row = (
    await ctx.client.query("SELECT name,is_employee,status FROM staff WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, id])
  ).rows[0]
  if (!row) missing()
  if (active && (!row.is_employee || row.status !== "active")) conflict("Pagamento exige funcionário ativo")
  return String(row.name)
}
async function profile(ctx: AuthorizedContext, id: string) {
  const row = (
    await ctx.client.query("SELECT revision,settings FROM staff_payroll_profiles WHERE tenant_id=$1 AND staff_id=$2", [
      ctx.tenantId,
      id,
    ])
  ).rows[0]
  return { revision: revisionValue(row?.revision ?? 0), settings: row?.settings ?? null }
}
function dueOn(month: string, s: Profile) {
  const first = validateDate(month + "-01")
  const day = new Date(first + "T00:00:00Z")
  let count = 0
  while (day.toISOString().slice(0, 7) === month) {
    const current = day.toISOString().slice(0, 10)
    if (
      day.getUTCDay() !== 0 &&
      day.getUTCDay() !== 6 &&
      !s.excludedDates.includes(current) &&
      ++count === s.businessDay
    )
      return current
    day.setUTCDate(day.getUTCDate() + 1)
  }
  return invalid("Calendário sem dias úteis suficientes")
}
async function originate(
  ctx: TenantContext,
  headers: FastifyRequest["headers"],
  staff: string,
  source: string,
  month: string,
  kind: "salary" | "one_off",
  p: z.infer<typeof paymentSchema>,
) {
  const name = await employee(ctx, staff),
    obligation = randomUUID(),
    id = randomUUID()
  await ctx.client.query(
    "INSERT INTO staff_payroll_obligations(id,tenant_id,staff_id,source_request_id,competence,kind,category,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [obligation, ctx.tenantId, staff, source, month + "-01", kind, p.category, p.note],
  )
  await ctx.client.query(
    "INSERT INTO payables(id,tenant_id,staff_obligation_id,supplier_name,due_date,amount_cents,competence_on) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [id, ctx.tenantId, obligation, name, p.dueDate, fixed(p.amount, 2), month + "-01"],
  )
  await record(ctx, headers, "payable", id, "payable.created", {
    staffId: staff,
    obligationId: obligation,
    approvalId: source,
    kind,
    amount: p.amount,
    revision: 1,
  })
}
async function generateFor(
  ctx: TenantContext,
  headers: FastifyRequest["headers"],
  staff: string,
  request: string,
  month: string,
  s: Profile,
) {
  if (!s.recurring || month < s.startsOn.slice(0, 7)) return 0
  if (
    (
      await ctx.client.query(
        "SELECT id FROM staff_payroll_obligations WHERE tenant_id=$1 AND staff_id=$2 AND competence=$3 AND kind='salary'",
        [ctx.tenantId, staff, month + "-01"],
      )
    ).rows.length
  )
    return 0
  await originate(ctx, headers, staff, request, month, "salary", {
    amount: s.salary,
    dueDate: dueOn(month, s),
    category: "Salário",
    note: "Salário • " + month,
  })
  return 1
}
async function applyProfile(
  ctx: AuthorizedContext,
  headers: FastifyRequest["headers"],
  staff: string,
  source: string,
  s: Profile,
  base: unknown,
) {
  if (BigInt((await profile(ctx, staff)).revision) !== BigInt(String(base)))
    conflict("Salário ou Pix mudou. Envie uma proposta atualizada")
  await ctx.client.query(
    `INSERT INTO staff_payroll_profiles(tenant_id,staff_id,revision,settings) VALUES($1,$2,1,$3) ON CONFLICT(tenant_id,staff_id) DO UPDATE SET settings=excluded.settings,revision=staff_payroll_profiles.revision+1,updated_at=now()`,
    [ctx.tenantId, staff, s],
  )
  const rows = (
    await ctx.client.query(
      `SELECT p.id,to_char(o.competence,'YYYY-MM') AS month FROM payables p JOIN staff_payroll_obligations o ON (o.tenant_id,o.id)=(p.tenant_id,p.staff_obligation_id)
    WHERE p.tenant_id=$1 AND o.staff_id=$2 AND o.kind='salary' AND p.status='open' AND p.due_date >= (now() AT TIME ZONE 'America/Sao_Paulo')::date AND NOT EXISTS(SELECT 1 FROM payable_payments x WHERE x.tenant_id=p.tenant_id AND x.payable_id=p.id)`,
      [ctx.tenantId, staff],
    )
  ).rows
  for (const r of rows) {
    const month = String(r.month)
    if (s.recurring && month >= s.startsOn.slice(0, 7))
      await ctx.client.query(
        "UPDATE payables SET amount_cents=$3,due_date=$4,revision=revision+1 WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId, r.id, fixed(s.salary, 2), dueOn(month, s)],
      )
    else
      await ctx.client.query(
        "UPDATE payables SET status='cancelled',revision=revision+1 WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId, r.id],
      )
  }
  const now = (await ctx.client.query("SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS month"))
    .rows[0]!
  await generateFor(ctx, headers, staff, source, String(now.month), s)
}
async function generateMonth(ctx: TenantContext, headers: FastifyRequest["headers"], month: string) {
  const rows = (
    await ctx.client.query(
      `SELECT p.staff_id,p.settings,(SELECT id FROM staff_payroll_requests r WHERE r.tenant_id=p.tenant_id AND r.staff_id=p.staff_id AND r.kind='settings' AND r.status='approved' ORDER BY r.reviewed_at DESC,r.id DESC LIMIT 1) AS source
    FROM staff_payroll_profiles p JOIN staff s ON (s.tenant_id,s.id)=(p.tenant_id,p.staff_id)
    WHERE p.tenant_id=$1 AND s.status='active' AND s.is_employee AND p.settings->>'recurring'='true' ORDER BY p.staff_id`,
      [ctx.tenantId],
    )
  ).rows
  let created = 0
  for (const row of rows)
    created += await generateFor(
      ctx,
      headers,
      String(row.staff_id),
      String(row.source),
      month,
      valid(profileSchema, row.settings),
    )
  return created
}

export async function reconcilePayroll(pool: DatabasePool) {
  const connection = await pool.connect()
  let created = 0
  const failures: unknown[] = []
  try {
    const tenants = (
      await connection.query<{ id: string }>("SELECT id FROM erp_staff_payroll_due_tenants() AS id ORDER BY id")
    ).rows
    for (const company of tenants) {
      try {
        await connection.query("BEGIN")
        await connection.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.auth_subject','',true)", [
          company.id,
        ])
        const ctx: TenantContext = { client: connection, tenantId: company.id, authSubject: "", permissions: [] }
        const row = (
          await connection.query<{ month: string }>(
            "SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS month FROM tenants WHERE id=$1 AND status='active' FOR UPDATE",
            [company.id],
          )
        ).rows[0]
        if (row) {
          const count = await generateMonth(ctx, {}, row.month)
          if (count)
            await record(ctx, {}, "staff_payroll", ctx.tenantId, "staff.payroll.generated", {
              source: "approved-payroll-recurrence",
              month: row.month,
              created: count,
            })
          await connection.query("COMMIT")
          created += count
        } else await connection.query("COMMIT")
      } catch (error) {
        await connection.query("ROLLBACK")
        failures.push(error)
      }
    }
  } finally {
    connection.release()
  }
  if (failures.length) throw new AggregateError(failures, "Falha ao gerar folha recorrente")
  return created
}

export function startPayrollWorker(app: FastifyInstance, pool: DatabasePool) {
  let active: Promise<void> | undefined
  const tick = () => {
    if (!active)
      active = reconcilePayroll(pool)
        .then(() => {})
        .catch((error) => {
          app.log.error({ err: error }, "Falha ao gerar folha recorrente")
        })
        .finally(() => {
          active = undefined
        })
  }
  const timer = setInterval(tick, 3_600_000)
  timer.unref()
  app.addHook("onReady", async () => {
    tick()
  })
  app.addHook("onClose", async () => {
    clearInterval(timer)
    await active
  })
}

const requestRows = `SELECT jsonb_build_object('id',r.id,'staffId',r.staff_id,'name',s.name,'kind',r.kind,'payload',r.payload,'baseRevision',r.base_revision,'revision',r.revision,'status',r.status,'requestedBy',r.requested_by,'reviewedBy',r.reviewed_by,'reason',r.review_reason,'createdAt',r.created_at,'reviewedAt',r.reviewed_at) AS data
  FROM staff_payroll_requests r JOIN staff s ON (s.tenant_id,s.id)=(r.tenant_id,r.staff_id)`
const rights = (ctx: AuthorizedContext) => ({
  tenantId: ctx.tenantId,
  canEdit: ctx.permissions.includes(manage),
  canApprove: ctx.permissions.includes(approve),
})
export function registerPayroll(app: FastifyInstance, deps: AppDependencies) {
  app.get<{ Params: { id: string } }>("/api/v1/staff/:id/payroll", async (req, reply) => {
    const body = await authorizeRequest(req, deps, async (ctx) => {
      requirePermission(ctx, read)
      const id = pathId(req.params.id),
        name = await employee(ctx, id, false)
      const requests = (
        await ctx.client.query(
          requestRows + " WHERE r.tenant_id=$1 AND r.staff_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 100",
          [ctx.tenantId, id],
        )
      ).rows.map((r) => r.data)
      const payments = (
        await ctx.client.query(
          `SELECT p.id,p.revision,o.kind,o.competence::text,o.category,o.note,p.due_date::text AS "dueDate",(p.amount_cents::numeric/100)::numeric(16,2)::text AS amount,
        (coalesce((SELECT sum(CASE WHEN x.kind='payment' THEN x.amount_cents ELSE -x.amount_cents END) FROM payable_payments x WHERE x.tenant_id=p.tenant_id AND x.payable_id=p.id),0)::numeric/100)::numeric(16,2)::text AS "paidAmount",p.status
        FROM staff_payroll_obligations o JOIN payables p ON (p.tenant_id,p.staff_obligation_id)=(o.tenant_id,o.id) WHERE o.tenant_id=$1 AND o.staff_id=$2 ORDER BY p.due_date DESC,p.id DESC LIMIT 200`,
          [ctx.tenantId, id],
        )
      ).rows.map((r) => ({ ...r, revision: revisionValue(r.revision) }))
      return { ...rights(ctx), staffId: id, name, ...(await profile(ctx, id)), requests, payments }
    })
    return reply
      .header("cache-control", "no-store")
      .header("etag", '"' + body.revision + '"')
      .send(body)
  })
  app.get("/api/v1/staff-payroll/employees", async (req, reply) => {
    const body = await authorizeRequest(req, deps, async (ctx) => {
      requirePermission(ctx, read)
      const paging = valid(
        z.strictObject({ offset: queryInteger(0, 100000).default(0), limit: queryInteger(1, 100).default(25) }),
        req.query,
      )
      const filter = " FROM staff WHERE tenant_id=$1 AND is_employee AND status='active'"
      const total = Number((await ctx.client.query("SELECT count(*) AS total" + filter, [ctx.tenantId])).rows[0]!.total)
      const data = (
        await ctx.client.query("SELECT id,name" + filter + " ORDER BY name,id LIMIT $2 OFFSET $3", [
          ctx.tenantId,
          paging.limit,
          paging.offset,
        ])
      ).rows
      return { tenantId: ctx.tenantId, data, total, ...paging }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  app.get("/api/v1/staff-payroll", async (req, reply) => {
    const body = await authorizeRequest(req, deps, async (ctx) => {
      requirePermission(ctx, read)
      const q = valid(
        z.strictObject({
          status: z.enum(["pending", "approved", "rejected", "cancelled", "all"]).default("pending"),
          limit: queryInteger(1, 100).default(25),
          offset: queryInteger(0, 10000).default(0),
        }),
        req.query,
      )
      const filter = " WHERE r.tenant_id=$1 AND ($2='all' OR r.status=$2)"
      const args = [ctx.tenantId, q.status]
      const data = (
        await ctx.client.query(requestRows + filter + " ORDER BY r.created_at DESC,r.id DESC LIMIT $3 OFFSET $4", [
          ...args,
          q.limit,
          q.offset,
        ])
      ).rows.map((r) => r.data)
      const total = Number(
        (await ctx.client.query("SELECT count(*) AS total FROM staff_payroll_requests r" + filter, args)).rows[0]!
          .total,
      )
      return { ...rights(ctx), data, total, limit: q.limit, offset: q.offset }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  async function createRequest(
    ctx: AuthorizedContext,
    headers: FastifyRequest["headers"],
    staff: string,
    input: z.infer<typeof proposal>,
    batch?: string,
  ) {
    await employee(ctx, staff)
    const base = input.kind === "settings" ? input.baseRevision : 0,
      payload = input.kind === "settings" ? input.settings : input.payment,
      id = randomUUID()
    if (input.kind === "settings") currentRevision((await profile(ctx, staff)).revision, base)
    await ctx.client.query(
      "INSERT INTO staff_payroll_requests(id,tenant_id,staff_id,kind,payload,base_revision,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id, ctx.tenantId, staff, input.kind, payload, base, ctx.authSubject],
    )
    await record(ctx, headers, "staff_payroll_request", id, "staff.payroll.proposed", {
      staffId: staff,
      kind: input.kind,
      ...(batch ? { batch } : {}),
    })
    return id
  }
  const paths = {
    propose: "/staff/:id/payroll/requests",
    review: "/staff-payroll/requests/:id/review",
    generate: "/staff-payroll/generate",
    salaries: "/staff-payroll/salaries",
  } as const
  for (const action of Object.keys(paths) as (keyof typeof paths)[])
    app.post<{ Params: { id?: string } }>("/api/v1" + paths[action], async (req, reply) => {
      const key = commandKey(req.headers["idempotency-key"])
      const result = await authorizeRequest(req, deps, async (ctx) => {
        requirePermission(ctx, read)
        requirePermission(ctx, action === "review" || action === "generate" ? approve : manage)
        const id = req.params.id ? pathId(req.params.id) : "",
          scope = "staff.payroll." + action
        const p = action === "propose" ? valid(proposal, req.body) : null
        const review =
          action === "review"
            ? valid(
                z.strictObject({ approve: z.boolean(), reason: str(500).refine((v) => v.trim().length >= 3) }),
                req.body,
              )
            : null
        const rev = review ? parseRevision(req.headers["if-match"]) : 1
        const gen =
          action === "generate" ? valid(z.strictObject({ month: z.string().regex(/^\d{4}-\d{2}$/) }), req.body) : null
        const batch =
          action === "salaries"
            ? valid(
                z.strictObject({
                  changes: z
                    .array(
                      z.strictObject({
                        staffId: z.guid().transform((v) => v.toLowerCase()),
                        baseRevision: z.number().int().nonnegative(),
                        salary: money,
                      }),
                    )
                    .min(1)
                    .max(100),
                }),
                req.body,
              )
            : null
        const intent = p ? { staffId: id, proposal: p } : review ? { id, revision: rev, ...review } : (gen ?? batch)
        const previous = await replay(ctx, key, scope, intent)
        if (previous) return previous
        let body: Record<string, unknown>
        if (p) body = { id: await createRequest(ctx, req.headers, id, p), revision: 1, status: "pending" }
        else if (review) {
          const row = (
            await ctx.client.query("SELECT * FROM staff_payroll_requests WHERE tenant_id=$1 AND id=$2", [
              ctx.tenantId,
              id,
            ])
          ).rows[0]
          if (!row) missing()
          currentRevision(revisionValue(row.revision), rev)
          if (row.status !== "pending") conflict("Solicitação já decidida")
          const staff = String(row.staff_id)
          if (review.approve) {
            await employee(ctx, staff)
            if (row.kind === "settings")
              await applyProfile(ctx, req.headers, staff, id, valid(profileSchema, row.payload), row.base_revision)
            else {
              const one = valid(paymentSchema, row.payload)
              await originate(ctx, req.headers, staff, id, one.dueDate.slice(0, 7), "one_off", one)
            }
          }
          const status = review.approve ? "approved" : "rejected"
          await ctx.client.query(
            "UPDATE staff_payroll_requests SET status=$3,revision=revision+1,reviewed_by=$4,review_reason=$5,reviewed_at=now() WHERE tenant_id=$1 AND id=$2",
            [ctx.tenantId, id, status, ctx.authSubject, review.reason],
          )
          await record(ctx, req.headers, "staff_payroll_request", id, "staff.payroll.reviewed", {
            staffId: staff,
            status,
            reason: review.reason,
          })
          body = { id, status, revision: nextRevision(rev) }
        } else if (gen) {
          const year = Number(validateDate(gen.month + "-01").slice(0, 4))
          if (Math.abs(year - new Date().getUTCFullYear()) > 1) invalid("Competência fora do intervalo permitido")
          const created = await generateMonth(ctx, req.headers, gen.month)
          body = { month: gen.month, created }
          await record(ctx, req.headers, "staff_payroll", ctx.tenantId, "staff.payroll.generated", body)
        } else {
          const ids: string[] = [],
            changes = batch!.changes
          if (new Set(changes.map((c) => c.staffId)).size !== changes.length) invalid("Funcionário repetido no lote")
          for (const change of changes) {
            const old = await profile(ctx, change.staffId)
            currentRevision(old.revision, change.baseRevision)
            if (!old.settings) conflict("Aprove o salário inicial antes de usar o lote")
            ids.push(
              await createRequest(
                ctx,
                req.headers,
                change.staffId,
                {
                  kind: "settings",
                  baseRevision: change.baseRevision,
                  settings: { ...valid(profileSchema, old.settings), salary: change.salary },
                },
                key,
              ),
            )
          }
          body = { ids, status: "pending", revision: 1 }
        }
        await remember(ctx, key, scope, intent, body)
        return body
      })
      return reply
        .code(action === "propose" || action === "salaries" ? 201 : 200)
        .header("cache-control", "no-store")
        .header("etag", '"' + (result.revision ?? 1) + '"')
        .send(result)
    })
}
