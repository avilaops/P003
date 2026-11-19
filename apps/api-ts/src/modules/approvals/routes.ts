import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, parseRevision, revisionValue } from "../../platform/revision.js"
import { queryInteger } from "../registrations/query.js"
import { decimal, fixed } from "../sales/fixed.js"
import { currentRoles, decide, documentHistory, documentTypes, listRequests, loadRequest } from "./engine.js"

const manage = "approvals.rules.manage",
  decider = "approvals.decide"
function invalid(title: string): never {
  throw new Problem(422, "invalid_input", title)
}
function missing(): never {
  throw new Problem(404, "not_found", "Regra de alçada não encontrada nesta empresa")
}
const id = (value: unknown) => {
  const parsed = normalizedDatabaseId.safeParse(value)
  return parsed.success ? parsed.data : missing()
}

export const ruleInput = z.strictObject({
  documentType: z.enum(documentTypes),
  name: z.string().trim().min(3).max(120),
  threshold: z.string().regex(/^(0|[1-9]\d{0,11})\.\d{2}$/),
  costCenterId: z.guid().nullish(),
  categoryId: z.guid().nullish(),
  approverRoleId: z.guid(),
  active: z.boolean().default(true),
})
export const decisionInput = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(3).max(500).nullish(),
})
const ruleQuery = z.strictObject({ documentType: z.enum(documentTypes).optional() })
const historyQuery = z.strictObject({
  documentType: z.enum(documentTypes),
  documentId: z.string().min(1).max(80),
})
const pendingQuery = z.strictObject({
  limit: queryInteger(1, 100).default(50),
  offset: queryInteger(0, 100000).default(0),
})

const ruleSql = `SELECT r.id,r.document_type AS "documentType",r.name,r.threshold_cents,r.cost_center_id AS "costCenterId",r.category_id AS "categoryId",
  r.approver_role_id AS "approverRoleId",role.name AS "approverRoleName",r.active,r.revision FROM approval_rules r JOIN roles role ON role.id=r.approver_role_id`
const shape = (row: Record<string, unknown>) => ({
  id: String(row.id),
  documentType: String(row.documentType),
  name: String(row.name),
  threshold: decimal(BigInt(String(row.threshold_cents)), 2),
  costCenterId: (row.costCenterId as string | null) ?? null,
  categoryId: (row.categoryId as string | null) ?? null,
  approverRoleId: String(row.approverRoleId),
  approverRoleName: String(row.approverRoleName),
  active: Boolean(row.active),
  revision: revisionValue(row.revision),
})
async function rule(ctx: AuthorizedContext, ruleId: string) {
  const row = (await ctx.client.query(ruleSql + " WHERE r.tenant_id=$1 AND r.id=$2", [ctx.tenantId, ruleId])).rows[0]
  return row ? shape(row) : missing()
}
async function checkReferences(ctx: AuthorizedContext, input: z.infer<typeof ruleInput>) {
  const role = await ctx.client.query("SELECT 1 FROM roles WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, input.approverRoleId])
  if (!role.rows.length) throw new Problem(409, "domain_conflict", "Selecione um papel aprovador desta empresa")
  if (input.costCenterId) {
    const found = await ctx.client.query("SELECT 1 FROM financial_cost_centers WHERE tenant_id=$1 AND id=$2 AND status='active'", [ctx.tenantId, input.costCenterId])
    if (!found.rows.length) throw new Problem(409, "domain_conflict", "Selecione um centro de custo ativo desta empresa")
  }
  if (input.categoryId) {
    const found = await ctx.client.query("SELECT 1 FROM financial_categories WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, input.categoryId])
    if (!found.rows.length) throw new Problem(409, "domain_conflict", "Selecione uma categoria desta empresa")
  }
}

export function registerApprovals(app: FastifyInstance, deps: AppDependencies) {
  const rules = "/api/v1/approval-rules"
  app.get(rules, { config: { openapi: { summary: "Regras de alçada de aprovação", query: ruleQuery } } }, async (req, reply) => {
    const body = await authorizeRequest(req, deps, async ctx => {
      requirePermission(ctx, manage)
      const q = ruleQuery.safeParse(req.query ?? {})
      if (!q.success) invalid("Tipo de documento inválido")
      const data = (
        await ctx.client.query(ruleSql + " WHERE r.tenant_id=$1 AND ($2::text IS NULL OR r.document_type=$2) ORDER BY r.document_type,r.threshold_cents,r.name", [
          ctx.tenantId,
          q.data.documentType ?? null,
        ])
      ).rows.map(shape)
      return { tenantId: ctx.tenantId, data }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  for (const method of ["POST", "PUT"] as const)
    app.route<{ Params: { id?: string } }>({
      method,
      url: method === "POST" ? rules : rules + "/:id",
      config: { openapi: { summary: method === "POST" ? "Cria regra de alçada" : "Altera regra de alçada", body: ruleInput, ...(method === "POST" ? { successStatus: 201 } : {}) } },
      handler: async (req, reply) => {
        const creating = method === "POST",
          expected = creating ? 1 : parseRevision(req.headers["if-match"]),
          key = commandKey(req.headers["idempotency-key"]),
          scope = creating ? "approval.rule.create" : "approval.rule.update"
        const body = await authorizeRequest(req, deps, async ctx => {
          requirePermission(ctx, manage)
          const parsed = ruleInput.safeParse(req.body)
          if (!parsed.success) invalid("Informe tipo de documento, nome, limite e papel aprovador")
          const input = parsed.data,
            ruleId = creating ? randomUUID() : id(req.params.id),
            intent = { id: creating ? null : ruleId, revision: expected, input }
          const saved = await replay(ctx, key, scope, intent)
          if (saved) return saved
          await checkReferences(ctx, input)
          const threshold = fixed(input.threshold, 2),
            args = [ctx.tenantId, ruleId, input.documentType, input.name, threshold, input.costCenterId ?? null, input.categoryId ?? null, input.approverRoleId, input.active]
          if (creating)
            await ctx.client.query(
              "INSERT INTO approval_rules(tenant_id,id,document_type,name,threshold_cents,cost_center_id,category_id,approver_role_id,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
              args,
            )
          else {
            const old = await rule(ctx, ruleId)
            if (String(old.revision) !== String(expected)) throw new Problem(412, "revision_conflict", "A regra mudou. Atualize a página")
            await ctx.client.query(
              "UPDATE approval_rules SET document_type=$3,name=$4,threshold_cents=$5,cost_center_id=$6,category_id=$7,approver_role_id=$8,active=$9,revision=$10,updated_at=now() WHERE tenant_id=$1 AND id=$2",
              [...args, nextRevision(expected)],
            )
          }
          await record(ctx, req.headers, "approval_rule", ruleId, creating ? "approval.rule_created" : "approval.rule_updated", { ...input, revision: creating ? 1 : nextRevision(expected) })
          const result = { tenantId: ctx.tenantId, data: await rule(ctx, ruleId) }
          await remember(ctx, key, scope, intent, result)
          return result
        })
        return reply
          .code(creating ? 201 : 200)
          .header("cache-control", "no-store")
          .header("etag", '"' + (body.data as { revision: unknown }).revision + '"')
          .send(body)
      },
    })

  const base = "/api/v1/approvals"
  app.get(base + "/pending", { config: { openapi: { summary: "Aprovações pendentes na alçada do usuário", query: pendingQuery } } }, async (req, reply) => {
    const body = await authorizeRequest(req, deps, async ctx => {
      requirePermission(ctx, decider)
      const q = pendingQuery.safeParse(req.query ?? {})
      if (!q.success) invalid("Paginação inválida")
      const roles = await currentRoles(ctx)
      const where = `AND status='pending' AND EXISTS(SELECT 1 FROM approval_steps s WHERE s.tenant_id=approval_requests.tenant_id AND s.request_id=approval_requests.id AND s.status='pending' AND s.approver_role_id=ANY($2::uuid[]))
        AND requested_by<>(SELECT id FROM identities WHERE auth_subject=$3)`
      const data = await listRequests(ctx, where, [roles, ctx.authSubject], q.data.limit, q.data.offset)
      const total = Number(
        (
          await ctx.client.query(
            "SELECT count(*) AS total FROM approval_requests WHERE tenant_id=$1 " + where,
            [ctx.tenantId, roles, ctx.authSubject],
          )
        ).rows[0]!.total,
      )
      return { tenantId: ctx.tenantId, data, total, offset: q.data.offset, limit: q.data.limit }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  app.get(base, { config: { openapi: { summary: "Histórico de aprovações de um documento", query: historyQuery } } }, async (req, reply) => {
    const body = await authorizeRequest(req, deps, async ctx => {
      requirePermission(ctx, decider)
      const q = historyQuery.safeParse(req.query ?? {})
      if (!q.success) invalid("Informe o tipo e o identificador do documento")
      return { tenantId: ctx.tenantId, data: await documentHistory(ctx, q.data.documentType, q.data.documentId) }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  app.get<{ Params: { id: string } }>(base + "/:id", { config: { openapi: { summary: "Detalhe de uma aprovação" } } }, async (req, reply) => {
    const body = await authorizeRequest(req, deps, async ctx => {
      requirePermission(ctx, decider)
      const roles = new Set(await currentRoles(ctx))
      const data = await loadRequest(ctx, id(req.params.id))
      return { tenantId: ctx.tenantId, data, canDecide: data.status === "pending" && data.steps.some(step => step.status === "pending" && roles.has(step.approverRoleId)) }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  app.post<{ Params: { id: string } }>(base + "/:id/decision", { config: { openapi: { summary: "Aprova ou recusa na alçada do usuário", body: decisionInput } } }, async (req, reply) => {
    const key = commandKey(req.headers["idempotency-key"])
    const body = await authorizeRequest(req, deps, async ctx => {
      requirePermission(ctx, decider)
      const parsed = decisionInput.safeParse(req.body)
      if (!parsed.success) invalid("Informe a decisão e, para recusar, o motivo")
      const requestId = id(req.params.id),
        intent = { id: requestId, ...parsed.data },
        scope = "approval.decision"
      const saved = await replay(ctx, key, scope, intent)
      if (saved) return saved
      const result = { tenantId: ctx.tenantId, data: await decide(ctx, req.headers, requestId, parsed.data.decision, parsed.data.reason ?? null) }
      await remember(ctx, key, scope, intent, result)
      return result
    })
    return reply.header("cache-control", "no-store").send(body)
  })
}
