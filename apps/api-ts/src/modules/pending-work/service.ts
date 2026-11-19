import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { listReviews } from "../commercial/reviews.js"
import { portfolio } from "../finance-insights/portfolio.js"
import { recordWorkspace } from "../sales/record-workspace.js"
import { approvalQueues } from "./approvals.contract.js"
import { certificateWarningDays, expiringProposalDays } from "./parameters.js"

/**
 * Painel de pendências (G1): o que pede a atenção do usuário agora.
 *
 * Cada contagem reaproveita a mesma consulta da lista de destino (fila de
 * aprovações, lista de pedidos/propostas, carteira financeira). Assim o número
 * do painel é, por construção, o total que a lista mostra ao abrir o link.
 * Itens zerados não são devolvidos: resolvido o problema, o item some.
 */
export const pendingGroups = ["approvals", "sales", "finance", "setup"] as const

export const pendingItemSchema = z.object({
  key: z.string(),
  group: z.enum(pendingGroups),
  title: z.string(),
  count: z.number().int().positive(),
  amountCents: z.string().nullable(),
  href: z.string(),
  action: z.object({ label: z.string(), href: z.string() }).nullable(),
})
export const pendingWorkSchema = z.object({
  tenantId: z.guid(),
  asOf: z.string(),
  total: z.number().int(),
  items: z.array(pendingItemSchema),
})
export type PendingItem = z.infer<typeof pendingItemSchema>

type Context = AuthorizedContext
const can = (context: Context, ...permissions: string[]) => permissions.some(permission => context.permissions.includes(permission))
const query = (values: Record<string, string>) => new URLSearchParams(values).toString()

async function salesWorkspaceTotal(context: Context, kind: "orders" | "proposals", filters: Record<string, string>) {
  const page = await recordWorkspace(context, { view: "workspace", limit: "1", ...filters }, kind) as unknown as { total: number; totalAmount: string }
  return { count: Number(page.total), amountCents: centsFromDecimal(page.totalAmount) }
}

async function portfolioTotal(context: Context, side: "receivable" | "payable", to: string) {
  const result = await portfolio(context, { side, status: "open", to, limit: 1 })
  return { count: Number(result.total), amountCents: centsFromDecimal(side === "receivable" ? result.totals.receivable : result.totals.payable) }
}

function centsFromDecimal(value: string | null | undefined) {
  if (value == null) return null
  const negative = value.startsWith("-"), [integer = "0", fraction = ""] = value.replace("-", "").split(".")
  const cents = BigInt(integer) * 100n + BigInt((fraction + "00").slice(0, 2))
  return (negative ? -cents : cents).toString()
}

export async function pendingWork(context: Context) {
  const { client, tenantId } = context
  const dates = (await client.query<{ today: string; yesterday: string }>(
    "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today,((now() AT TIME ZONE 'America/Sao_Paulo')::date-1)::text AS yesterday")).rows[0]!
  const items: PendingItem[] = []
  const push = (item: Omit<PendingItem, "amountCents" | "action"> & { amountCents?: string | null; action?: PendingItem["action"] }) => {
    if (item.count > 0) items.push({ amountCents: null, action: null, ...item })
  }

  if (can(context, "sales.orders.read", "sales.proposals.read")) {
    const reviews = await listReviews(context)
    push({ key: "sales.approvals", group: "approvals", title: "Aprovações comerciais aguardando você", count: reviews.length,
      amountCents: reviews.reduce((sum, row) => sum + BigInt(row.amountCents), 0n).toString(), href: "/vendas/aprovacoes",
      action: { label: "Decidir", href: "/vendas/aprovacoes" } })
  }
  for (const queue of approvalQueues) {
    if (!can(context, ...queue.permissions)) continue
    const pending = await queue.pending(context)
    push({ key: queue.key, group: "approvals", title: queue.title, count: pending.count, amountCents: pending.amountCents.toString(), href: queue.href })
  }

  if (can(context, "sales.orders.read")) {
    const filters = { status: "draft", stale: "true" }
    push({ key: "sales.stale-orders", group: "sales", title: "Pedidos em rascunho parados há mais de 7 dias",
      ...await salesWorkspaceTotal(context, "orders", filters), href: "/vendas/pedidos?" + query(filters) })
  }
  if (can(context, "sales.proposals.read")) {
    const expired = { status: "expired" }, expiring = { validity: "expiring" }
    push({ key: "sales.expired-proposals", group: "sales", title: "Propostas enviadas vencidas",
      ...await salesWorkspaceTotal(context, "proposals", expired), href: "/vendas/propostas?" + query(expired) })
    push({ key: "sales.expiring-proposals", group: "sales", title: `Propostas vencendo em até ${expiringProposalDays} dias`,
      ...await salesWorkspaceTotal(context, "proposals", expiring), href: "/vendas/propostas?" + query(expiring) })
  }

  if (can(context, "finance.receivables.read")) {
    const filters = { side: "receivable", status: "open", to: dates.yesterday }
    push({ key: "finance.overdue-receivables", group: "finance", title: "Contas a receber vencidas",
      ...await portfolioTotal(context, "receivable", dates.yesterday), href: "/relatorios/financeiro?" + query(filters) })
  }
  if (can(context, "finance.payables.read")) {
    const filters = { side: "payable", status: "open", to: dates.today }
    push({ key: "finance.payables-due", group: "finance", title: "Contas a pagar vencidas ou vencendo hoje",
      ...await portfolioTotal(context, "payable", dates.today), href: "/relatorios/financeiro?" + query(filters) })
  }

  const setup = await client.query<{ accounts: number; categories: number; certificate_until: string | null; certificate_present: boolean }>(
    `SELECT (SELECT count(*)::int FROM financial_accounts WHERE tenant_id=$1 AND status='active') AS accounts,
            (SELECT count(*)::int FROM financial_categories WHERE tenant_id=$1 AND status='active') AS categories,
            (SELECT (metadata->>'validUntil') FROM fiscal_a1_certificates WHERE tenant_id=$1 AND ciphertext IS NOT NULL) AS certificate_until,
            EXISTS(SELECT FROM fiscal_a1_certificates WHERE tenant_id=$1 AND ciphertext IS NOT NULL) AS certificate_present`, [tenantId])
  const config = setup.rows[0]!
  if (can(context, "finance.accounts.read") && config.accounts === 0)
    push({ key: "setup.financial-account", group: "setup", title: "Nenhuma conta financeira ativa", count: 1, href: "/cadastros/contas-financeiras",
      action: can(context, "finance.accounts.manage") ? { label: "Cadastrar conta", href: "/cadastros/contas-financeiras" } : null })
  if (can(context, "finance.categories.read") && config.categories === 0)
    push({ key: "setup.financial-categories", group: "setup", title: "Nenhuma categoria financeira ativa", count: 1, href: "/cadastros/categorias-financeiras",
      action: can(context, "finance.categories.manage") ? { label: "Cadastrar categoria", href: "/cadastros/categorias-financeiras" } : null })
  if (can(context, "fiscal.config.read")) {
    const until = Number(config.certificate_until), limit = Date.now() / 1000 + certificateWarningDays * 86_400
    const title = !config.certificate_present ? "Certificado digital não instalado"
      : !Number.isFinite(until) || until <= Date.now() / 1000 ? "Certificado digital vencido"
      : until <= limit ? `Certificado digital vence em até ${certificateWarningDays} dias` : ""
    if (title) push({ key: "setup.certificate", group: "setup", title, count: 1, href: "/preferencias/certificado-digital",
      action: can(context, "fiscal.certificate.manage") ? { label: "Instalar certificado", href: "/preferencias/certificado-digital" } : null })
  }

  return { tenantId, asOf: new Date().toISOString(), total: items.reduce((sum, item) => sum + item.count, 0), items }
}
