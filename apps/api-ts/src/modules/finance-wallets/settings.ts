import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { parseRevision, revisionValue } from "../../platform/revision.js"
import { decimal, fixed } from "../sales/fixed.js"
import { conflict, currentRevision, invalid, missing } from "./snapshot.js"
import { pathId } from "./documents.js"

const id = z.guid().nullable()
const walletSettingsSchema = z.strictObject({
  salesCategoryId: id,
  purchasesCategoryId: id,
  payrollCategoryId: id,
  defaultCostCenterId: id,
  requireCostCenter: z.boolean(),
  interestMonthlyBps: z.number().int().min(0).max(10000),
  penaltyBps: z.number().int().min(0).max(10000),
  graceDays: z.number().int().min(0).max(365),
  discountLimitBps: z.number().int().min(0).max(10000),
  paymentApprovalLimit: z.string().nullable(),
  restructureApprovalLimit: z.string().nullable().optional(),
})
type WalletSettings = z.infer<typeof walletSettingsSchema>
export const walletDefaults: WalletSettings = {
  salesCategoryId: null,
  purchasesCategoryId: null,
  payrollCategoryId: null,
  defaultCostCenterId: null,
  requireCostCenter: false,
  interestMonthlyBps: 0,
  penaltyBps: 0,
  graceDays: 0,
  discountLimitBps: 10000,
  paymentApprovalLimit: null,
  restructureApprovalLimit: null,
}
function requireSettingsRead(ctx: AuthorizedContext) {
  if (
    ![
      "platform.company.read",
      "platform.company.manage",
      "finance.receivables.read",
      "finance.payables.read",
      "finance.categories.read",
    ].some((p) => ctx.permissions.includes(p))
  )
    requirePermission(ctx, "platform.company.read")
}
export async function walletSettings(ctx: AuthorizedContext) {
  const row = (
    await ctx.client.query(
      `SELECT revision,sales_category_id AS "salesCategoryId",purchases_category_id AS "purchasesCategoryId",payroll_category_id AS "payrollCategoryId",default_cost_center_id AS "defaultCostCenterId",require_cost_center AS "requireCostCenter",
    interest_monthly_bps AS "interestMonthlyBps",penalty_bps AS "penaltyBps",grace_days AS "graceDays",discount_limit_bps AS "discountLimitBps",payment_approval_limit_cents,restructure_approval_limit_cents FROM financial_wallet_settings WHERE tenant_id=$1`,
      [ctx.tenantId],
    )
  ).rows[0]
  if (!row) return { revision: 1, data: walletDefaults }
  const { revision, payment_approval_limit_cents, restructure_approval_limit_cents, ...rest } = row
  return {
    revision: revisionValue(revision),
    data: {
      ...rest,
      restructureApprovalLimit:
        restructure_approval_limit_cents == null ? null : decimal(BigInt(String(restructure_approval_limit_cents)), 2),
      paymentApprovalLimit:
        payment_approval_limit_cents == null ? null : decimal(BigInt(String(payment_approval_limit_cents)), 2),
    } as WalletSettings,
  }
}
export async function checkClassification(
  ctx: AuthorizedContext,
  category: string | null,
  center: string | null,
  direction: "income" | "expense",
  required: boolean,
) {
  if (
    category &&
    !(
      await ctx.client.query(
        "SELECT id FROM financial_categories WHERE tenant_id=$1 AND id=$2 AND direction=$3 AND status='active'",
        [ctx.tenantId, category, direction],
      )
    ).rows.length
  )
    invalid("Escolha uma natureza ativa compatível com a carteira")
  if (required && !center) invalid("Informe o centro de custo")
  if (
    center &&
    !(
      await ctx.client.query("SELECT id FROM financial_cost_centers WHERE tenant_id=$1 AND id=$2 AND status='active'", [
        ctx.tenantId,
        center,
      ])
    ).rows.length
  )
    invalid("Escolha um centro de custo ativo")
}
const centerInput = z.strictObject({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9._/-]{0,39}$/),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((v) => !/\p{Cc}/u.test(v)),
  status: z.enum(["active", "archived"]),
})
export function registerWalletSettings(app: FastifyInstance, deps: AppDependencies) {
  app.get("/api/v1/financial-wallet-settings", async (req, reply) => {
    const body = await authorizeRequest(req, deps, async (ctx) => {
      requireSettingsRead(ctx)
      const settings = await walletSettings(ctx)
      const categories = (
        await ctx.client.query(
          "SELECT id,code,name,direction FROM financial_categories WHERE tenant_id=$1 AND status='active' ORDER BY code",
          [ctx.tenantId],
        )
      ).rows
      const costCenters = (
        await ctx.client.query(
          "SELECT id,code,name FROM financial_cost_centers WHERE tenant_id=$1 AND status='active' ORDER BY code",
          [ctx.tenantId],
        )
      ).rows
      return {
        tenantId: ctx.tenantId,
        canEdit: ctx.permissions.includes("platform.company.manage"),
        categories,
        accounts: ctx.permissions.some((p) =>
          ["finance.accounts.read", "finance.receivables.manage", "finance.payables.manage"].includes(p),
        )
          ? (
              await ctx.client.query(
                "SELECT id,code,name FROM financial_accounts WHERE tenant_id=$1 AND status='active' ORDER BY code,id",
                [ctx.tenantId],
              )
            ).rows
          : [],
        costCenters,
        ...settings,
      }
    })
    return reply.header("etag", `"${body.revision}"`).header("cache-control", "no-store").send(body)
  })
  app.put("/api/v1/financial-wallet-settings", async (req, reply) => {
    const expected = parseRevision(req.headers["if-match"])
    const body = await authorizeRequest(req, deps, async (ctx) => {
      requirePermission(ctx, "platform.company.manage")
      const parsed = walletSettingsSchema.safeParse(req.body)
      if (!parsed.success) invalid("Parâmetros financeiros inválidos")
      const key = req.headers["idempotency-key"] ? commandKey(req.headers["idempotency-key"]) : null,
        scope = "finance.wallet.settings",
        intent = { revision: expected, input: parsed.data }
      if (key) {
        const previous = await replay(ctx, key, scope, intent)
        if (previous) return previous
      }
      const s = parsed.data,
        existing = await walletSettings(ctx)
      currentRevision(existing.revision, expected)
      await checkClassification(ctx, s.salesCategoryId, s.defaultCostCenterId, "income", s.requireCostCenter)
      for (const category of [s.purchasesCategoryId, s.payrollCategoryId])
        await checkClassification(ctx, category, null, "expense", false)
      const restructure =
        s.restructureApprovalLimit === undefined ? existing.data.restructureApprovalLimit : s.restructureApprovalLimit
      const threshold = s.paymentApprovalLimit === null ? null : fixed(s.paymentApprovalLimit, 2)
      await ctx.client.query(
        `INSERT INTO financial_wallet_settings(tenant_id,revision,sales_category_id,purchases_category_id,payroll_category_id,default_cost_center_id,require_cost_center,interest_monthly_bps,penalty_bps,grace_days,discount_limit_bps,payment_approval_limit_cents,restructure_approval_limit_cents)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(tenant_id) DO UPDATE SET revision=excluded.revision,sales_category_id=excluded.sales_category_id,purchases_category_id=excluded.purchases_category_id,payroll_category_id=excluded.payroll_category_id,default_cost_center_id=excluded.default_cost_center_id,require_cost_center=excluded.require_cost_center,interest_monthly_bps=excluded.interest_monthly_bps,penalty_bps=excluded.penalty_bps,grace_days=excluded.grace_days,discount_limit_bps=excluded.discount_limit_bps,payment_approval_limit_cents=excluded.payment_approval_limit_cents,restructure_approval_limit_cents=excluded.restructure_approval_limit_cents`,
        [
          ctx.tenantId,
          BigInt(expected) + 1n,
          s.salesCategoryId,
          s.purchasesCategoryId,
          s.payrollCategoryId,
          s.defaultCostCenterId,
          s.requireCostCenter,
          s.interestMonthlyBps,
          s.penaltyBps,
          s.graceDays,
          s.discountLimitBps,
          threshold,
          restructure == null ? null : fixed(restructure, 2),
        ],
      )
      await record(ctx, req.headers, "financial_wallet_settings", ctx.tenantId, "finance.wallet_settings_updated", s)
      const result = { tenantId: ctx.tenantId, canEdit: true, ...(await walletSettings(ctx)) }
      if (key) await remember(ctx, key, scope, intent, result)
      return result
    })
    return reply.header("etag", `"${body.revision}"`).header("cache-control", "no-store").send(body)
  })
  const centers = "/api/v1/financial-cost-centers"
  app.get(centers, async (req, reply) => {
    const body = await authorizeRequest(req, deps, async (ctx) => {
      requireSettingsRead(ctx)
      const rows = (
        await ctx.client.query(
          "SELECT id,code,name,status,revision FROM financial_cost_centers WHERE tenant_id=$1 ORDER BY code",
          [ctx.tenantId],
        )
      ).rows
      return {
        tenantId: ctx.tenantId,
        canEdit: ctx.permissions.includes("finance.categories.manage"),
        data: rows.map((r) => ({ ...r, revision: revisionValue(r.revision) })),
      }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  app.get<{ Params: { id: string } }>(centers + "/:id", async (req, reply) => {
    const body = await authorizeRequest(req, deps, async (ctx) => {
      requireSettingsRead(ctx)
      const row = (
        await ctx.client.query(
          "SELECT id,code,name,status,revision FROM financial_cost_centers WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, pathId(req.params.id)],
        )
      ).rows[0]
      if (!row) missing()
      return {
        tenantId: ctx.tenantId,
        canEdit: ctx.permissions.includes("finance.categories.manage"),
        data: { ...row, revision: revisionValue(row.revision) },
      }
    })
    return reply.header("etag", `"${body.data.revision}"`).header("cache-control", "no-store").send(body)
  })
  for (const method of ["POST", "PUT"] as const)
    app.route<{ Params: { id?: string } }>({
      method,
      url: method === "POST" ? centers : centers + "/:id",
      handler: async (req, reply) => {
        const key = commandKey(req.headers["idempotency-key"])
        const body = await authorizeRequest(req, deps, async (ctx) => {
          requirePermission(ctx, "finance.categories.manage")
          const rowId = req.params.id ? pathId(req.params.id) : null,
            expected = rowId ? parseRevision(req.headers["if-match"]) : null
          const input = centerInput.safeParse(req.body)
          if (!input.success) invalid("Código, nome ou situação do centro de custo inválidos")
          const s = input.data,
            intent = { id: rowId, revision: expected, input: s },
            scope = "finance.center." + method
          const previous = await replay(ctx, key, scope, intent)
          if (previous) return previous
          if (rowId) {
            const current = (
              await ctx.client.query("SELECT revision FROM financial_cost_centers WHERE tenant_id=$1 AND id=$2", [
                ctx.tenantId,
                rowId,
              ])
            ).rows[0]
            if (!current) missing()
            currentRevision(revisionValue(current.revision), expected!)
            if (s.status === "archived" && (await walletSettings(ctx)).data.defaultCostCenterId === rowId)
              conflict("Altere o centro padrão antes de arquivar")
          }
          if (
            (
              await ctx.client.query(
                "SELECT id FROM financial_cost_centers WHERE tenant_id=$1 AND code=$2 AND id IS DISTINCT FROM $3",
                [ctx.tenantId, s.code, rowId],
              )
            ).rows.length
          )
            conflict("Código de centro de custo já utilizado")
          const centerId = rowId ?? randomUUID(),
            revision = expected ? revisionValue(BigInt(expected) + 1n) : 1
          await ctx.client.query(
            `INSERT INTO financial_cost_centers(id,tenant_id,code,name,status,revision) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,status=excluded.status,revision=excluded.revision`,
            [centerId, ctx.tenantId, s.code, s.name, s.status, revision],
          )
          await record(ctx, req.headers, "financial_cost_center", centerId, "finance.cost_center_saved", {
            revision,
            ...s,
          })
          const result = { tenantId: ctx.tenantId, canEdit: true, data: { id: centerId, ...s, revision } }
          await remember(ctx, key, scope, intent, result)
          return result
        })
        return reply
          .code(method === "POST" ? 201 : 200)
          .header("etag", `"${(body.data as { revision: unknown }).revision}"`)
          .header("cache-control", "no-store")
          .send(body)
      },
    })
}
