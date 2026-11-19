import { randomUUID } from "node:crypto"
import type { AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { decimal } from "../sales/fixed.js"

/**
 * Motor genérico de aprovação por alçada (dono: D04/C3).
 *
 * Os módulos de documento (compra, solicitação, entrada, venda, desconto) chamam
 * `submitForApproval` quando o documento quer seguir; se alguma regra ativa se
 * aplica, nasce um pedido de aprovação com uma etapa por regra, decidida por quem
 * tem o papel aprovador. Quando a última etapa é aprovada (ou qualquer uma é
 * recusada), o handler registrado para o tipo de documento roda na mesma transação.
 */
export const documentTypes = ["purchase", "purchase_request", "purchase_entry", "sale", "discount"] as const
export type DocumentType = (typeof documentTypes)[number]
export type Headers = Record<string, string | string[] | undefined>
type Context = AuthorizedContext

export type ApprovalSubject = {
  documentType: DocumentType
  documentId: string
  amountCents: bigint
  costCenterId?: string | null
  categoryId?: string | null
  /** Texto curto exibido na lista de pendências ("Compra de Fornecedor X"). */
  summary: string
}
export type ApprovalRequest = {
  id: string
  documentType: DocumentType
  documentId: string
  amount: string
  costCenterId: string | null
  categoryId: string | null
  summary: string
  status: "pending" | "approved" | "rejected" | "cancelled"
  requestedBy: string
  createdAt: string
  decidedAt: string | null
  steps: {
    ruleId: string
    ruleName: string
    threshold: string
    approverRoleId: string
    approverRoleName: string
    status: string
    decidedBy: string | null
    reason: string | null
    decidedAt: string | null
  }[]
}
export type ApprovalOutcome = { status: "not_required" | "pending" | "approved"; request: ApprovalRequest | null }
export type DecisionHandler = (ctx: Context, headers: Headers, request: ApprovalRequest) => Promise<void>

const handlers = new Map<DocumentType, DecisionHandler>()
/** O módulo dono do documento reage à decisão final (aprovada ou recusada). */
export function onApprovalDecided(type: DocumentType, handler: DecisionHandler) {
  handlers.set(type, handler)
}

export async function currentIdentity(ctx: Context) {
  const row = (await ctx.client.query<{ id: string }>("SELECT id FROM identities WHERE auth_subject=$1", [ctx.authSubject])).rows[0]
  if (!row) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
  return row.id
}

/** Papéis do usuário na empresa ativa. */
export async function currentRoles(ctx: Context) {
  return (
    await ctx.client.query<{ role_id: string }>(
      `SELECT mr.role_id FROM tenant_memberships m JOIN identities i ON i.id=m.identity_id
       JOIN membership_roles mr ON mr.membership_id=m.id JOIN roles r ON r.id=mr.role_id AND r.tenant_id=m.tenant_id
       WHERE m.tenant_id=$1 AND i.auth_subject=$2 AND m.status='active'`,
      [ctx.tenantId, ctx.authSubject],
    )
  ).rows.map(row => row.role_id)
}

const requestSql = `SELECT id,document_type AS "documentType",document_id AS "documentId",amount_cents,cost_center_id AS "costCenterId",
  category_id AS "categoryId",summary,status,requested_by AS "requestedBy",created_at AS "createdAt",decided_at AS "decidedAt" FROM approval_requests`

async function hydrate(ctx: Context, rows: Record<string, unknown>[]): Promise<ApprovalRequest[]> {
  if (!rows.length) return []
  const steps = (
    await ctx.client.query(
      `SELECT s.request_id,s.rule_id AS "ruleId",s.rule_name AS "ruleName",s.threshold_cents,s.approver_role_id AS "approverRoleId",
         r.name AS "approverRoleName",s.status,s.decided_by AS "decidedBy",s.reason,s.decided_at AS "decidedAt"
       FROM approval_steps s JOIN roles r ON r.id=s.approver_role_id
       WHERE s.tenant_id=$1 AND s.request_id=ANY($2::uuid[]) ORDER BY s.threshold_cents,s.rule_name`,
      [ctx.tenantId, rows.map(row => row.id)],
    )
  ).rows
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value == null ? null : String(value))
  return rows.map(row => ({
    id: String(row.id),
    documentType: row.documentType as DocumentType,
    documentId: String(row.documentId),
    amount: decimal(BigInt(String(row.amount_cents)), 2),
    costCenterId: (row.costCenterId as string | null) ?? null,
    categoryId: (row.categoryId as string | null) ?? null,
    summary: String(row.summary),
    status: row.status as ApprovalRequest["status"],
    requestedBy: String(row.requestedBy),
    createdAt: iso(row.createdAt)!,
    decidedAt: iso(row.decidedAt),
    steps: steps
      .filter(step => step.request_id === row.id)
      .map(step => ({
        ruleId: String(step.ruleId),
        ruleName: String(step.ruleName),
        threshold: decimal(BigInt(String(step.threshold_cents)), 2),
        approverRoleId: String(step.approverRoleId),
        approverRoleName: String(step.approverRoleName),
        status: String(step.status),
        decidedBy: (step.decidedBy as string | null) ?? null,
        reason: (step.reason as string | null) ?? null,
        decidedAt: iso(step.decidedAt),
      })),
  }))
}

export async function loadRequest(ctx: Context, id: string, lock = false) {
  const row = (await ctx.client.query(requestSql + " WHERE tenant_id=$1 AND id=$2" + (lock ? " FOR UPDATE" : ""), [ctx.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Aprovação não encontrada nesta empresa")
  return (await hydrate(ctx, [row]))[0]!
}

export async function listRequests(ctx: Context, where: string, args: unknown[], limit = 50, offset = 0) {
  const rows = (
    await ctx.client.query(requestSql + ` WHERE tenant_id=$1 ${where} ORDER BY created_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`, [ctx.tenantId, ...args])
  ).rows
  return hydrate(ctx, rows)
}

/** Histórico de aprovações de um documento, da mais recente para a mais antiga. */
export function documentHistory(ctx: Context, type: DocumentType, documentId: string) {
  return listRequests(ctx, "AND document_type=$2 AND document_id=$3", [type, documentId])
}

/** Regras ativas que exigem aprovação para o valor/centro de custo/categoria. */
export async function applicableRules(ctx: Context, subject: Omit<ApprovalSubject, "documentId" | "summary">) {
  return (
    await ctx.client.query<{ id: string; name: string; threshold_cents: string; approver_role_id: string }>(
      `SELECT id,name,threshold_cents,approver_role_id FROM approval_rules
       WHERE tenant_id=$1 AND active AND document_type=$2 AND $3::bigint>threshold_cents
         AND (cost_center_id IS NULL OR cost_center_id=$4) AND (category_id IS NULL OR category_id=$5)
       ORDER BY threshold_cents,name`,
      [ctx.tenantId, subject.documentType, subject.amountCents, subject.costCenterId ?? null, subject.categoryId ?? null],
    )
  ).rows
}

/**
 * Pede passagem para o documento. Resultado:
 * - `not_required`: nenhuma regra se aplica; o documento segue.
 * - `approved`: já existe aprovação concluída para o mesmo valor (ou maior) e mesmas dimensões.
 * - `pending`: um pedido de aprovação está aberto; o documento deve aguardar.
 */
export async function submitForApproval(ctx: Context, headers: Headers, subject: ApprovalSubject): Promise<ApprovalOutcome> {
  const [latest] = await documentHistory(ctx, subject.documentType, subject.documentId)
  if (latest?.status === "pending") return { status: "pending", request: latest }
  if (
    latest?.status === "approved" &&
    BigInt(latest.amount.replace(".", "")) >= subject.amountCents &&
    latest.costCenterId === (subject.costCenterId ?? null) &&
    latest.categoryId === (subject.categoryId ?? null)
  )
    return { status: "approved", request: latest }
  const rules = await applicableRules(ctx, subject)
  if (!rules.length) return { status: "not_required", request: null }
  const id = randomUUID(),
    requester = await currentIdentity(ctx)
  await ctx.client.query(
    `INSERT INTO approval_requests(id,tenant_id,document_type,document_id,amount_cents,cost_center_id,category_id,summary,requested_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, ctx.tenantId, subject.documentType, subject.documentId, subject.amountCents, subject.costCenterId ?? null, subject.categoryId ?? null, subject.summary.slice(0, 300), requester],
  )
  for (const rule of rules)
    await ctx.client.query(
      "INSERT INTO approval_steps(tenant_id,request_id,rule_id,rule_name,threshold_cents,approver_role_id) VALUES($1,$2,$3,$4,$5,$6)",
      [ctx.tenantId, id, rule.id, rule.name, rule.threshold_cents, rule.approver_role_id],
    )
  await record(ctx, headers, "approval_request", id, "approval.requested", {
    documentType: subject.documentType,
    documentId: subject.documentId,
    amount: decimal(subject.amountCents, 2),
    rules: rules.map(rule => rule.id),
  })
  return { status: "pending", request: await loadRequest(ctx, id) }
}

/** Cancela o pedido pendente (documento editado, cancelado ou devolvido ao rascunho). */
export async function cancelPendingApproval(ctx: Context, headers: Headers, type: DocumentType, documentId: string) {
  const row = (
    await ctx.client.query<{ id: string }>(
      "UPDATE approval_requests SET status='cancelled',decided_at=clock_timestamp() WHERE tenant_id=$1 AND document_type=$2 AND document_id=$3 AND status='pending' RETURNING id",
      [ctx.tenantId, type, documentId],
    )
  ).rows[0]
  if (!row) return
  await ctx.client.query("UPDATE approval_steps SET status='cancelled' WHERE tenant_id=$1 AND request_id=$2 AND status='pending'", [ctx.tenantId, row.id])
  await record(ctx, headers, "approval_request", row.id, "approval.cancelled", { documentType: type, documentId })
}

/** Registra a decisão do usuário nas etapas pendentes da sua alçada. */
export async function decide(ctx: Context, headers: Headers, id: string, decision: "approved" | "rejected", reason: string | null) {
  const request = await loadRequest(ctx, id, true)
  if (request.status !== "pending") throw new Problem(409, "domain_conflict", "Esta aprovação já foi concluída")
  const me = await currentIdentity(ctx)
  if (request.requestedBy === me) throw new Problem(409, "domain_conflict", "Quem pediu a aprovação não pode decidi-la")
  const roles = new Set(await currentRoles(ctx))
  const mine = request.steps.filter(step => step.status === "pending" && roles.has(step.approverRoleId))
  if (!mine.length) throw new Problem(403, "forbidden", "Esta aprovação não está na sua alçada")
  if (decision === "rejected" && !reason) throw new Problem(422, "invalid_input", "Informe o motivo da recusa")
  for (const step of mine)
    await ctx.client.query(
      "UPDATE approval_steps SET status=$4,decided_by=$5,reason=$6,decided_at=clock_timestamp() WHERE tenant_id=$1 AND request_id=$2 AND rule_id=$3",
      [ctx.tenantId, id, step.ruleId, decision, me, reason],
    )
  const remaining = request.steps.filter(step => step.status === "pending" && !roles.has(step.approverRoleId)).length
  const final = decision === "rejected" ? "rejected" : remaining ? null : "approved"
  if (final) {
    await ctx.client.query("UPDATE approval_requests SET status=$3,decided_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, id, final])
    if (final === "rejected")
      await ctx.client.query("UPDATE approval_steps SET status='cancelled' WHERE tenant_id=$1 AND request_id=$2 AND status='pending'", [ctx.tenantId, id])
  }
  await record(ctx, headers, "approval_request", id, final ? "approval." + final : "approval.step_approved", {
    documentType: request.documentType,
    documentId: request.documentId,
    rules: mine.map(step => step.ruleId),
    reason,
  })
  const updated = await loadRequest(ctx, id)
  if (final) await handlers.get(request.documentType)?.(ctx, headers, updated)
  return updated
}
