import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { parseRevision, nextRevision, revisionValue } from "../../platform/revision.js"
import { validateDate } from "../sales/fixed.js"
import { queryInteger } from "../registrations/query.js"
import { fileLimit, pathId, registerDocumentRoutes } from "./documents.js"
import { checkClassification, registerWalletSettings, walletSettings } from "./settings.js"
import {
  applyWalletPayment,
  approvalIntent,
  parsePayment,
  paymentIntent,
  preparePayment,
  reverseWalletPayment,
  reversalSchema,
} from "./settlements.js"
import {
  conflict,
  currentRevision,
  invalid,
  listWallet,
  loadWallet,
  missing,
  orderFinance,
  walletDefinition,
  wallets,
} from "./snapshot.js"

const listQuery = z.object({ offset: queryInteger(0, 100000).default(0), limit: queryInteger(1, 100).default(25) })
const classification = z.strictObject({
  natureId: z.guid(),
  costCenterId: z.guid().nullable(),
  competenceOn: z.string(),
  forecastAccountId: z.guid().nullish(),
})
const credential = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  reason: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .refine((s) => !/\p{Cc}/u.test(s)),
})
const approvalColumns = `id,title_revision::text AS "titleRevision",status,intent,reasons,requested_by AS "requestedBy",requested_at::text AS "requestedAt",decided_by AS "decidedBy",decided_at::text AS "decidedAt",reason`
import { registerPurchaseOrders } from "./purchase-orders.js"
import { registerPayroll } from "./payroll.js"
import { registerPurchaseReceipts } from "./purchase-receipts.js"

export function registerFinanceWalletRoutes(app: FastifyInstance, deps: AppDependencies) {
  registerPurchaseOrders(app, deps)
  registerPayroll(app, deps)
  registerPurchaseReceipts(app, deps)
  registerDocumentRoutes(app, deps)
  registerWalletSettings(app, deps)
  for (const method of ["GET", "PUT"] as const)
    app.route({
      url: "/api/v1/financial-settings",
      method,
      handler: async (req, reply) => {
        const body = await authorizeRequest(req, deps, async (ctx) => {
          const canEdit = ctx.permissions.includes("platform.company.manage")
          if (method === "PUT") requirePermission(ctx, "platform.company.manage")
          else if (
            !["platform.company.read", "finance.receivables.read", "finance.payables.read"].some((p) =>
              ctx.permissions.includes(p),
            )
          )
            requirePermission(ctx, "platform.company.read")
          const row = (
            await ctx.client.query(
              "SELECT revision,default_payment_method FROM financial_settings WHERE tenant_id=$1",
              [ctx.tenantId],
            )
          ).rows[0]
          let revision = revisionValue(row?.revision ?? 1),
            defaultPaymentMethod = String(row?.default_payment_method ?? "bank_transfer")
          if (method === "PUT") {
            const expected = parseRevision(req.headers["if-match"]),
              input = z
                .strictObject({ defaultPaymentMethod: z.enum(["bank_transfer", "cash", "card", "other"]) })
                .safeParse(req.body)
            if (!input.success) invalid("Meio declarado inválido")
            currentRevision(revision, expected)
            const previousMethod = defaultPaymentMethod
            revision = nextRevision(revision)
            defaultPaymentMethod = input.data.defaultPaymentMethod
            await ctx.client.query(
              "INSERT INTO financial_settings(tenant_id,default_payment_method,revision) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET default_payment_method=$2,revision=$3,updated_at=now()",
              [ctx.tenantId, defaultPaymentMethod, revision],
            )
            await ctx.client.query(
              "INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,details) SELECT $1,id,'financial_settings.updated','financial_settings',$3 FROM identities WHERE auth_subject=$2",
              [
                ctx.tenantId,
                ctx.authSubject,
                { previousRevision: expected, revision, previousMethod, defaultPaymentMethod },
              ],
            )
          }
          return { tenantId: ctx.tenantId, revision, canEdit, data: { defaultPaymentMethod } }
        })
        return reply.header("etag", `"${body.revision}"`).header("cache-control", "no-store").send(body)
      },
    })
  app.get<{ Params: { id: string } }>("/api/v1/orders/:id/finance", async (req, reply) => {
    const body = await authorizeRequest(req, deps, (ctx) => {
      requirePermission(ctx, "finance.receivables.read")
      return orderFinance(ctx, pathId(req.params.id))
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  for (const wallet of wallets) {
    const d = walletDefinition(wallet),
      url = "/api/v1/" + wallet,
      detail = url + "/:id"
    app.get(url, async (req, reply) => {
      const q = listQuery.safeParse(req.query)
      if (!q.success) invalid("Paginação inválida")
      const body = await authorizeRequest(req, deps, (ctx) => {
        requirePermission(ctx, d.permission + ".read")
        return listWallet(ctx, wallet, q.data.offset, q.data.limit)
      })
      return reply.header("cache-control", "no-store").send(body)
    })
    app.post(url + "/payment-batches", { bodyLimit: fileLimit }, async (req, reply) => {
      const key = commandKey(req.headers["idempotency-key"])
      const body = await authorizeRequest(req, deps, async (ctx) => {
        requirePermission(ctx, d.permission + ".read")
        requirePermission(ctx, d.permission + ".manage")
        const parsed = z
          .strictObject({
            items: z
              .array(
                z.strictObject({
                  id: z.guid(),
                  revision: z.union([z.string().regex(/^[1-9][0-9]{0,18}$/), z.number().int().positive().safe()]),
                  payment: z.unknown(),
                }),
              )
              .min(1)
              .max(100),
          })
          .safeParse(req.body)
        if (!parsed.success) invalid("Informe de um a cem títulos, cada um com revisão e baixa")
        const items = parsed.data.items.map((item) => ({
          id: pathId(item.id),
          revision: parseRevision('"' + item.revision + '"'),
          payment: parsePayment(item.payment),
        }))
        if (new Set(items.map((item) => item.id)).size !== items.length)
          invalid("Cada título só pode aparecer uma vez no lote")
        const intent = { items: items.map((item) => ({ ...item, payment: paymentIntent(item.payment) })) },
          scope = d.scope + ".batch"
        const previous = await replay(ctx, key, scope, intent)
        if (previous) return previous
        const data = []
        for (const item of items) {
          const saved = await applyWalletPayment(ctx, req.headers, wallet, item.id, item.revision, item.payment)
          data.push({
            id: item.id,
            revision: saved.data.revision,
            paymentId: saved.payments.at(-1)!.id,
            outstandingAmount: saved.data.outstandingAmount,
          })
        }
        const result = { tenantId: ctx.tenantId, id: key, data }
        await record(ctx, req.headers, "financial_payment_batch", key, "finance.batch_recorded", {
          wallet,
          items: data,
        })
        await remember(ctx, key, scope, intent, result)
        return result
      })
      return reply
        .header("etag", '"' + key + '"')
        .header("cache-control", "no-store")
        .send(body)
    })
    app.get<{ Params: { id: string } }>(detail, async (req, reply) => {
      const body = await authorizeRequest(req, deps, (ctx) => {
        requirePermission(ctx, d.permission + ".read")
        return loadWallet(ctx, wallet, pathId(req.params.id))
      })
      return reply.header("etag", `"${body.data.revision}"`).header("cache-control", "no-store").send(body)
    })
    for (const action of ["payments", "reverse-payment", "classification"] as const)
      app.route<{ Params: { id: string } }>({
        url: detail + "/" + action,
        method: action === "classification" ? "PUT" : "POST",
        bodyLimit: action === "payments" ? fileLimit : 65536,
        handler: async (req, reply) => {
          const expected = parseRevision(req.headers["if-match"]),
            key = commandKey(req.headers["idempotency-key"])
          const body = await authorizeRequest(req, deps, async (ctx) => {
            requirePermission(ctx, d.permission + ".read")
            requirePermission(ctx, d.permission + ".manage")
            const id = pathId(req.params.id),
              scope =
                d.scope + "." + { payments: "pay", "reverse-payment": "reverse", classification: "classify" }[action]
            const pay = action === "payments" ? parsePayment(req.body) : null
            const rev = action === "reverse-payment" ? reversalSchema.safeParse(req.body) : null
            const cls = action === "classification" ? classification.safeParse(req.body) : null
            if ((rev && !rev.success) || (cls && !cls.success)) invalid("Dados inválidos")
            const intent = { id, revision: expected, input: pay ? paymentIntent(pay) : (rev?.data ?? cls?.data) }
            const previous = await replay(ctx, key, scope, intent)
            if (previous) return previous
            let result
            if (pay) result = await applyWalletPayment(ctx, req.headers, wallet, id, expected, pay)
            else if (rev?.data) result = await reverseWalletPayment(ctx, req.headers, wallet, id, expected, rev.data)
            else {
              const title = await loadWallet(ctx, wallet, id),
                s = cls!.data!
              currentRevision(title.data.revision, expected)
              await checkClassification(
                ctx,
                s.natureId,
                s.costCenterId,
                d.receipt ? "income" : "expense",
                (await walletSettings(ctx)).data.requireCostCenter,
              )
              const forecast = s.forecastAccountId === undefined ? title.data.forecastAccountId : s.forecastAccountId
              if (
                forecast &&
                !(
                  await ctx.client.query(
                    "SELECT id FROM financial_accounts WHERE tenant_id=$1 AND id=$2 AND status='active'",
                    [ctx.tenantId, forecast],
                  )
                ).rows.length
              )
                invalid("Escolha uma conta prevista ativa")
              await ctx.client.query(
                `UPDATE ${d.titles} SET category_id=$3,cost_center_id=$4,competence_on=$5,revision=$6,forecast_account_id=$7 WHERE tenant_id=$1 AND id=$2`,
                [
                  ctx.tenantId,
                  id,
                  s.natureId,
                  s.costCenterId,
                  validateDate(s.competenceOn),
                  nextRevision(expected),
                  forecast,
                ],
              )
              await record(ctx, req.headers, d.entity, id, d.entity + ".classified", {
                ...s,
                previousRevision: expected,
                revision: nextRevision(expected),
              })
              result = await loadWallet(ctx, wallet, id)
            }
            await remember(ctx, key, scope, intent, result)
            return result
          })
          return reply
            .header("etag", `"${(body.data as { revision: unknown }).revision}"`)
            .header("cache-control", "no-store")
            .send(body)
        },
      })
    app.get<{ Params: { id: string } }>(detail + "/approvals", async (req, reply) => {
      const body = await authorizeRequest(req, deps, async (ctx) => {
        requirePermission(ctx, d.permission + ".read")
        const id = pathId(req.params.id)
        await loadWallet(ctx, wallet, id)
        const data = (
          await ctx.client.query(
            `SELECT ${approvalColumns} FROM financial_settlement_approvals WHERE tenant_id=$1 AND ${d.foreign}=$2 ORDER BY requested_at DESC,id`,
            [ctx.tenantId, id],
          )
        ).rows
        return {
          tenantId: ctx.tenantId,
          data: data.map((row) => ({
            ...row,
            canDecide:
              row.status === "pending" &&
              row.requestedBy !== ctx.authSubject &&
              (row.reasons as string[]).every((r) =>
                ctx.permissions.includes(
                  r === "discount" ? "finance.discounts.approve" : "finance.settlements.approve",
                ),
              ),
          })),
        }
      })
      return reply.header("cache-control", "no-store").send(body)
    })
    for (const decision of [false, true])
      app.post<{ Params: { id: string; approvalId?: string } }>(
        detail + "/approvals" + (decision ? "/:approvalId/decision" : ""),
        { bodyLimit: decision ? 65536 : fileLimit },
        async (req, reply) => {
          const key = commandKey(req.headers["idempotency-key"]),
            expected = parseRevision(req.headers["if-match"])
          const body = await authorizeRequest(req, deps, async (ctx) => {
            requirePermission(ctx, d.permission + ".read")
            if (!decision) requirePermission(ctx, d.permission + ".manage")
            const id = pathId(req.params.id),
              decisionId = decision ? pathId(req.params.approvalId!) : null
            const choice = decision ? credential.safeParse(req.body) : null
            if (choice && !choice.success) invalid("Informe a decisão e sua justificativa")
            const payment = decision ? null : parsePayment(req.body)
            const intent = {
              id,
              revision: expected,
              decisionId,
              input: payment ? paymentIntent(payment) : choice!.data,
            }
            const scope = d.scope + (decision ? ".approve" : ".request_approval"),
              previous = await replay(ctx, key, scope, intent)
            if (previous) return previous
            const title = await loadWallet(ctx, wallet, id)
            currentRevision(title.data.revision, expected)
            const approvalId = decisionId ?? randomUUID()
            if (payment) {
              const values = await preparePayment(ctx, wallet, title, payment)
              if (!values.reasons.length) invalid("Os valores informados estão dentro da alçada")
              await ctx.client.query(
                `INSERT INTO financial_settlement_approvals(id,tenant_id,${d.foreign},title_revision,intent,reasons,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
                [
                  approvalId,
                  ctx.tenantId,
                  id,
                  expected,
                  approvalIntent(payment, values),
                  values.reasons,
                  ctx.authSubject,
                ],
              )
            } else {
              const existing = (
                await ctx.client.query(
                  `SELECT * FROM financial_settlement_approvals WHERE tenant_id=$1 AND ${d.foreign}=$2 AND id=$3`,
                  [ctx.tenantId, id, approvalId],
                )
              ).rows[0]
              if (!existing) missing()
              for (const reason of existing.reasons as string[])
                requirePermission(
                  ctx,
                  reason === "discount" ? "finance.discounts.approve" : "finance.settlements.approve",
                )
              if (
                existing.status !== "pending" ||
                existing.requested_by === ctx.authSubject ||
                BigInt(String(existing.title_revision)) !== BigInt(expected)
              )
                conflict("A aprovação exige outra pessoa e uma solicitação pendente na revisão atual")
              await ctx.client.query(
                "UPDATE financial_settlement_approvals SET status=$3,decided_by=$4,decided_at=clock_timestamp(),reason=$5 WHERE tenant_id=$1 AND id=$2",
                [ctx.tenantId, approvalId, choice!.data!.decision, ctx.authSubject, choice!.data!.reason],
              )
            }
            const data = (
              await ctx.client.query(
                `SELECT ${approvalColumns} FROM financial_settlement_approvals WHERE tenant_id=$1 AND id=$2`,
                [ctx.tenantId, approvalId],
              )
            ).rows[0]!
            await record(
              ctx,
              req.headers,
              "settlement_approval",
              approvalId,
              "finance.approval_" + String(data.status),
              { titleId: id, revision: expected, reasons: data.reasons },
            )
            const result = { tenantId: ctx.tenantId, data }
            await remember(ctx, key, scope, intent, result)
            return result
          })
          return reply
            .code(decision ? 200 : 201)
            .header("etag", `"${expected}"`)
            .header("cache-control", "no-store")
            .send(body)
        },
      )
  }
}
