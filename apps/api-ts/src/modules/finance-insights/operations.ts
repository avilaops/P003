import { postOperation } from "../finance-management/operation-postings.js"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue } from "../../platform/revision.js"
import { applyWalletPayment } from "../finance-wallets/settlements.js"
import { decimal, sides, validate } from "./portfolio.js"
import { registerOperationReversals } from "./reversals.js"
import { writableAccount } from "../finance-treasury/ledger.js"

const amount = z
  .string()
  .regex(/^\d{1,12}(?:\.\d{1,2})?$/)
  .refine((x) => cents(x) > 0n)
const side = z.enum(["receivable", "payable"])
const details = { partyId: z.guid(), side, occurredOn: z.iso.date(), reason: z.string().trim().min(3).max(200) }
const targets = z
  .array(z.object({ id: z.guid(), side, revision: z.string().regex(/^[1-9]\d{0,18}$/), amount }).strict())
  .min(1)
  .max(100)
const schedule = z
  .array(z.object({ dueOn: z.iso.date(), amount }).strict())
  .min(1)
  .max(120)
const operation = z.discriminatedUnion("kind", [
  z.object({ ...details, kind: z.literal("advance"), accountId: z.guid(), amount, orderId: z.guid().optional() }).strict(),
  z.object({ ...details, kind: z.literal("allocation"), advanceId: z.guid(), targets }).strict(),
  z.object({ ...details, kind: z.literal("offset"), targets }).strict(),
  z
    .object({
      ...details,
      kind: z.literal("restructure"),
      targets,
      schedule,
      interest: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/),
    })
    .strict(),
  z.object({ ...details, kind: z.literal("billing_group"), targets, dueOn: z.iso.date() }).strict(),
])
function cents(s: string) {
  const [a, b = ""] = s.split(".")
  return BigInt(a!) * 100n + BigInt(b.padEnd(2, "0"))
}
function money(c: bigint) {
  return (c / 100n).toString() + "." + (c % 100n).toString().padStart(2, "0")
}
function conflict(text: string): never {
  throw new Problem(409, "domain_conflict", text)
}
type Headers = Record<string, string | string[] | undefined>
type Target = z.infer<typeof targets>[number]
type Input = z.infer<typeof operation>

async function loadTitle(context: AuthorizedContext, target: Target, partyId: string, linkedAdvance = false) {
  if (!linkedAdvance) {
    requirePermission(context, "finance." + target.side + "s.read")
    requirePermission(context, "finance." + target.side + "s.manage")
  }
  const row = (
    await context.client.query("SELECT * FROM finance_portfolio WHERE tenant_id=$1 AND id=$2 AND side=$3", [
      context.tenantId,
      target.id,
      target.side,
    ])
  ).rows[0]
  if (!row || row.party_id !== partyId)
    throw new Problem(422, "invalid_input", "O título precisa pertencer ao parceiro selecionado")
  if (String(row.revision) !== target.revision) throw new Problem(412, "revision_conflict", "O título mudou. Atualize a carteira")
  if (row.status !== "open" || cents(target.amount) > BigInt(String(row.open_cents)))
    conflict("O valor informado excede o saldo disponível")
  return row
}

async function createOperation(context: AuthorizedContext, headers: Headers, input: Input, linkedAdvance = false) {
  const { client, tenantId } = context
  if (!linkedAdvance) requirePermission(context, "finance." + input.side + "s.manage")
  if (input.kind === "offset") {
    requirePermission(context, "finance.receivables.manage")
    requirePermission(context, "finance.payables.manage")
  }
  const party = (
    await client.query(
      "SELECT id,legal_name,is_customer,is_supplier FROM parties WHERE tenant_id=$1 AND id=$2 AND status='active'",
      [tenantId, input.partyId],
    )
  ).rows[0]
  if (!party || !(input.side === "receivable" ? party.is_customer : party.is_supplier))
    conflict("Selecione um parceiro ativo da carteira")
  const id = randomUUID()
  const selection = input.kind === "advance" ? [] : input.targets
  if (new Set(selection.map((t) => t.side + t.id)).size !== selection.length) conflict("Título repetido na seleção")
  const rows = []
  for (const target of selection) rows.push(await loadTitle(context, target, input.partyId, linkedAdvance))
  let principal =
    input.kind === "advance"
      ? cents(input.amount)
      : selection.filter((t) => t.side === input.side).reduce((s, t) => s + cents(t.amount), 0n)
  let entryId: string | null = null
  if (input.kind === "advance") {
    requirePermission(context, "finance.account_entries.manage")
    await writableAccount(context, input.accountId, input.occurredOn)
    if (input.orderId) {
      const order = await client.query(
        input.side === "receivable"
          ? "SELECT id FROM sales_orders WHERE tenant_id=$1 AND id=$2 AND customer_id=$3 AND status IN ('draft','accepted','confirmed')"
          : "SELECT id FROM purchase_orders WHERE tenant_id=$1 AND id=$2 AND supplier_id=$3 AND status IN ('draft','confirmed','partially_received')",
        [tenantId, input.orderId, input.partyId],
      )
      if (!order.rows.length) conflict("Pedido incompatível com a antecipação")
    }
    entryId = randomUUID()
    await client.query(
      "INSERT INTO financial_account_entries(id,tenant_id,account_id,direction,amount_cents,occurred_on,description,reference,category_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,finance_ledger_nature($2,'advance',$4))",
      [
        entryId,
        tenantId,
        input.accountId,
        input.side === "receivable" ? "credit" : "debit",
        String(principal),
        input.occurredOn,
        input.reason,
        id,
      ],
    )
  } else if (input.kind === "offset") {
    const counter = selection.filter((t) => t.side !== input.side).reduce((s, t) => s + cents(t.amount), 0n)
    if (principal === 0n || principal !== counter) conflict("Os dois lados da compensação precisam somar o mesmo valor")
  } else {
    if (selection.some((t) => t.side !== input.side)) conflict("Selecione títulos de uma única carteira")
    if (input.kind === "allocation") {
      const advance = (
        await client.query(
          "SELECT a.order_id,a.purchase_order_id,a.principal_cents-coalesce((SELECT sum(principal_cents) FROM finance_active_operations WHERE tenant_id=a.tenant_id AND advance_id=a.id),0) AS remaining FROM finance_active_operations a WHERE a.tenant_id=$1 AND a.id=$2 AND a.kind='advance' AND a.side=$3 AND a.party_id=$4 AND a.occurred_on<=$5",
          [tenantId, input.advanceId, input.side, input.partyId, input.occurredOn],
        )
      ).rows[0]
      if (!advance || BigInt(String(advance.remaining)) < principal)
        conflict("Saldo de adiantamento insuficiente na data selecionada")
      if (advance.order_id && rows.some((r) => r.order_id !== advance.order_id))
        conflict("O adiantamento pertence a outro pedido de venda")
      if (advance.purchase_order_id) {
        const matching = await client.query(
          "SELECT p.id FROM payables p JOIN purchase_receipts r ON (r.tenant_id,r.id)=(p.tenant_id,p.receipt_id) WHERE p.tenant_id=$1 AND r.order_id=$2 AND p.id=ANY($3::uuid[])",
          [tenantId, advance.purchase_order_id, selection.map((t) => t.id)],
        )
        if (matching.rows.length !== selection.length) conflict("O adiantamento pertence a outro pedido de compra")
      }
    }
    if (input.kind === "billing_group") {
      if (
        input.side !== "receivable" ||
        input.dueOn < input.occurredOn ||
        rows.some((r) => !r.order_id) ||
        new Set(rows.map((r) => r.order_id)).size < 2
      )
        conflict("Selecione títulos de pelo menos dois pedidos do mesmo cliente e um vencimento válido")
      if (rows.some((r, i) => BigInt(String(r.open_cents)) !== cents(selection[i]!.amount)))
        conflict("O agrupamento deve incluir o saldo integral de cada parcela")
      const existing = await client.query(
        "SELECT 1 FROM finance_operation_items i JOIN finance_active_operations o ON (o.tenant_id,o.id)=(i.tenant_id,i.operation_id) WHERE i.tenant_id=$1 AND i.receivable_id=ANY($2::uuid[]) AND o.kind='billing_group' LIMIT 1",
        [tenantId, selection.map((t) => t.id)],
      )
      if (existing.rows.length) conflict("Uma parcela já integra outra cobrança agrupada")
      const charged = await client.query(
        `SELECT FROM finance_collection_items WHERE tenant_id=$1 AND receivable_id=ANY($2::uuid[])
         UNION ALL SELECT FROM finance_collection_batch_items WHERE tenant_id=$1 AND receivable_id=ANY($2::uuid[]) AND released_at IS NULL LIMIT 1`,
        [tenantId, selection.map((item) => item.id)],
      )
      if (charged.rows.length) conflict("Uma parcela já possui cobrança bancária ou integra um borderô ativo")
    }
    if (input.kind === "restructure") {
      if (
        input.schedule.some((item) => item.dueOn < input.occurredOn) ||
        input.schedule.reduce((a, t) => a + cents(t.amount), 0n) !== principal + cents(input.interest)
      )
        conflict("As novas parcelas devem conciliar principal e juros e vencer a partir da renegociação")
    }
  }
  await client.query(
    "INSERT INTO finance_operations(id,tenant_id,kind,side,party_id,occurred_on,due_on,reason,principal_cents,interest_cents,advance_id,entry_id,order_id,purchase_order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
    [
      id,
      tenantId,
      input.kind,
      input.side,
      input.partyId,
      input.occurredOn,
      input.kind === "billing_group" ? input.dueOn : null,
      input.reason,
      String(principal),
      input.kind === "restructure" ? String(cents(input.interest)) : "0",
      input.kind === "allocation" ? input.advanceId : null,
      entryId,
      input.kind === "advance" && input.side === "receivable" ? (input.orderId ?? null) : null,
      input.kind === "advance" && input.side === "payable" ? (input.orderId ?? null) : null,
    ],
  )
  for (const item of selection) {
    const incoming = item.side === "receivable"
    let paymentId: unknown = null
    if (input.kind !== "billing_group") {
      await applyWalletPayment(
        context,
        headers,
        incoming ? "receivables" : "financial-payables",
        item.id,
        revisionValue(item.revision),
        {
          amount: money(cents(item.amount)),
          method: "other",
          reference: id,
          occurredOn: input.occurredOn,
          financialEffect: "non_cash",
          interestAmount: "0.00",
          penaltyAmount: "0.00",
          surchargeAmount: "0.00",
          discountAmount: "0.00",
        },
        true,
      )
      const table = incoming ? "receivable_payments" : "payable_payments",
        key = incoming ? "receivable_id" : "payable_id"
      const payment = (
        await client.query(`SELECT id FROM ${table} WHERE tenant_id=$1 AND ${key}=$2 AND reference=$3 AND kind<>'reversal'`, [
          tenantId,
          item.id,
          id,
        ])
      ).rows[0]
      if (!payment) throw new Error("Baixa de compensação sem registro")
      paymentId = payment.id
    }
    await client.query(
      "INSERT INTO finance_operation_items(id,tenant_id,operation_id,receivable_id,payable_id,receipt_payment_id,payable_payment_id,principal_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        randomUUID(),
        tenantId,
        id,
        incoming ? item.id : null,
        incoming ? null : item.id,
        incoming ? paymentId : null,
        incoming ? null : paymentId,
        String(cents(item.amount)),
      ],
    )
  }
  if (input.kind === "restructure") {
    const incoming = input.side === "receivable",
      table = incoming ? "receivables" : "payables",
      name = incoming ? "customer_name" : "supplier_name"
    // A category or center shared by all original titles can be carried forward.
    const category = new Set(rows.map((r) => r.category_id)).size === 1 ? rows[0]?.category_id : null
    const center = new Set(rows.map((r) => r.cost_center_id)).size === 1 ? rows[0]?.cost_center_id : null
    for (const item of input.schedule)
      await client.query(
        `INSERT INTO ${table}(id,tenant_id,${name},due_date,amount_cents,status,finance_operation_id,category_id,cost_center_id,competence_on) VALUES($1,$2,$3,$4,$5,'open',$6,$7,$8,$9)`,
        [
          randomUUID(),
          tenantId,
          party.legal_name,
          item.dueOn,
          String(cents(item.amount)),
          id,
          category,
          center,
          input.occurredOn,
        ],
      )
  }
  if (input.kind === "advance" || input.kind === "restructure") await postOperation(context, headers, id)
  await record(context, headers, "finance_operation", id, "finance." + input.kind + ".created", {
    partyId: input.partyId,
    side: input.side,
    principal: money(principal),
    entryId,
  })
  return { tenantId, data: { id, kind: input.kind, amount: money(principal), revision: 1 } }
}

// The finance operator selects the order when recording the advance. At completion
// only that advance and that order's open installments may be discharged.
export async function allocateOrderAdvances(
  context: AuthorizedContext,
  headers: Headers,
  orderId: string,
  purchase?: { titleId: string; occurredOn: string },
) {
  const side = purchase ? "payable" : "receivable"
  const advances = (
    await context.client.query(
      `SELECT a.id,a.party_id,a.principal_cents-coalesce(sum(used.principal_cents),0) AS balance,
    coalesce($3::date,(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date)::text AS day
    FROM finance_active_operations a LEFT JOIN finance_active_operations used ON (a.tenant_id,a.id)=(used.tenant_id,used.advance_id)
    WHERE a.tenant_id=$1 AND ${purchase ? "a.purchase_order_id" : "a.order_id"}=$2 AND a.kind='advance' AND a.side=$4
      AND a.occurred_on<=coalesce($3::date,(current_timestamp AT TIME ZONE 'America/Sao_Paulo')::date)
    GROUP BY a.id,a.party_id,a.principal_cents,a.occurred_on HAVING a.principal_cents>coalesce(sum(used.principal_cents),0) ORDER BY a.occurred_on,a.id`,
      [context.tenantId, orderId, purchase?.occurredOn ?? null, side],
    )
  ).rows
  for (const advance of advances) {
    let remaining = BigInt(String(advance.balance))
    const titles = (
      await context.client.query(
        `SELECT id,revision,open_cents FROM finance_portfolio WHERE tenant_id=$1 AND party_id=$2 AND ${purchase ? "id" : "order_id"}=$3 AND side=$4 AND status='open' ORDER BY due_date,id`,
        [context.tenantId, advance.party_id, purchase?.titleId ?? orderId, side],
      )
    ).rows
    const items: Target[] = []
    for (const title of titles) {
      if (!remaining) break
      const open = BigInt(String(title.open_cents))
      const applied = open < remaining ? open : remaining
      if (applied > 0n) items.push({ id: String(title.id), revision: String(title.revision), side, amount: money(applied) })
      remaining -= applied
    }
    if (items.length)
      await createOperation(
        context,
        headers,
        {
          kind: "allocation",
          side,
          partyId: String(advance.party_id),
          occurredOn: String(advance.day),
          reason: purchase
            ? "Compensação de adiantamento no recebimento da compra"
            : "Compensação do adiantamento no faturamento do pedido",
          advanceId: String(advance.id),
          targets: items,
        },
        true,
      )
  }
}

export function registerOperationRoutes(app: FastifyInstance, deps: AppDependencies) {
  registerOperationReversals(app, deps)
  app.post("/api/v1/finance/operations", async (request, reply) => {
    const input = validate(operation, request.body),
      key = commandKey(request.headers["idempotency-key"])
    const data = await authorizeRequest(request, deps, async (context) => {
      const requiredSides = input.kind === "offset" ? ["receivable", "payable"] : [input.side]
      for (const side of requiredSides) {
        requirePermission(context, "finance." + side + "s.read")
        requirePermission(context, "finance." + side + "s.manage")
      }
      if (input.kind === "advance") requirePermission(context, "finance.account_entries.manage")
      const prior = await replay(context, key, "finance.operation", input)
      if (prior) return prior
      if (input.kind === "restructure") {
        const ceiling = (
          await context.client.query(
            "SELECT restructure_approval_limit_cents AS ceiling FROM financial_wallet_settings WHERE tenant_id=$1",
            [context.tenantId],
          )
        ).rows[0]?.ceiling
        const principal = input.targets.reduce((sum, t) => sum + cents(t.amount), 0n)
        if (ceiling != null && principal + cents(input.interest) > BigInt(String(ceiling))) {
          if (
            new Set(input.targets.map((t) => t.id)).size !== input.targets.length ||
            input.targets.some((t) => t.side !== input.side)
          )
            conflict("Selecione títulos distintos de uma única carteira")
          if (
            input.schedule.some((i) => i.dueOn < input.occurredOn) ||
            input.schedule.reduce((a, t) => a + cents(t.amount), 0n) !== principal + cents(input.interest)
          )
            conflict("Confira as parcelas e os juros antes de solicitar aprovação")
          for (const target of input.targets) await loadTitle(context, target, input.partyId)
          const id = randomUUID()
          await context.client.query(
            "INSERT INTO finance_operation_reviews(id,tenant_id,party_id,side,request,requested_by) VALUES($1,$2,$3,$4,$5,$6)",
            [id, context.tenantId, input.partyId, input.side, input, context.authSubject],
          )
          await record(context, request.headers, "finance_operation_review", id, "finance.restructure.requested", {
            partyId: input.partyId,
            principal: money(principal),
          })
          const pending = { tenantId: context.tenantId, data: { id, kind: input.kind, status: "pending", revision: 1 } }
          await remember(context, key, "finance.operation", input, pending)
          return pending
        }
      }
      const value = await createOperation(context, request.headers, input)
      await remember(context, key, "finance.operation", input, value)
      return value
    })
    return reply.code(201).header("etag", '"1"').header("cache-control", "no-store").send(data)
  })
  app.post("/api/v1/finance/operation-decisions", async (request, reply) => {
    const input = validate(
      z.object({ id: z.guid(), decision: z.enum(["approved", "rejected"]), reason: z.string().trim().min(3).max(200) }).strict(),
      request.body,
    )
    const key = commandKey(request.headers["idempotency-key"])
    const result = await authorizeRequest(request, deps, async (ctx) => {
      requirePermission(ctx, "finance.settlements.approve")
      const review = (
        await ctx.client.query("SELECT * FROM finance_operation_reviews WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
          ctx.tenantId,
          input.id,
        ])
      ).rows[0]
      if (!review) throw new Problem(404, "not_found", "Solicitação não encontrada")
      requirePermission(ctx, "finance." + review.side + "s.read")
      requirePermission(ctx, "finance." + review.side + "s.manage")
      const prior = await replay(ctx, key, "finance.operation.decision", input)
      if (prior) return prior
      if (review.requested_by === ctx.authSubject) throw new Problem(403, "forbidden", "A aprovação exige outro operador")
      if (review.status !== "pending") conflict("Solicitação já decidida")
      const resolved =
        input.decision === "approved" ? await createOperation(ctx, request.headers, validate(operation, review.request)) : null
      await ctx.client.query(
        "UPDATE finance_operation_reviews SET decided_by=$3,decided_at=now(),decision_reason=$4,status=$5,operation_id=$6 WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId, input.id, ctx.authSubject, input.reason, input.decision, resolved?.data.id ?? null],
      )
      await record(ctx, request.headers, "finance_operation_review", input.id, "finance.restructure." + input.decision, {
        operationId: resolved?.data.id ?? null,
        reason: input.reason,
      })
      const value = { tenantId: ctx.tenantId, data: { id: input.id, status: input.decision, revision: 2 } }
      await remember(ctx, key, "finance.operation.decision", input, value)
      return value
    })
    return reply.header("etag", '"2"').send(result)
  })
  app.get("/api/v1/finance/operations", async (request, reply) => {
    const input = validate(z.object({ partyId: z.guid(), side: side.optional() }).strict(), request.query)
    const result = await authorizeRequest(request, deps, async (context) => {
      const allowed = sides(context)
      const rows = await context.client.query(
        `SELECT o.id,o.kind,o.side,o.reason,o.occurred_on::text AS "occurredOn",o.due_on::text AS "dueOn",
        ${decimal("o.principal_cents")} AS amount,r.occurred_on::text AS "reversedOn",r.reason AS "reversalReason", ${decimal("CASE WHEN r.operation_id IS NOT NULL THEN 0 ELSE o.principal_cents-coalesce((SELECT sum(v.principal_cents) FROM finance_active_operations v WHERE v.tenant_id=o.tenant_id AND v.advance_id=o.id),0) END")} AS available,
        coalesce((SELECT jsonb_agg(jsonb_build_object('id',coalesce(i.receivable_id,i.payable_id),'side',CASE WHEN i.receivable_id IS NULL THEN 'payable' ELSE 'receivable' END,'amount',${decimal("i.principal_cents")})) FROM finance_operation_items i WHERE i.tenant_id=o.tenant_id AND i.operation_id=o.id),'[]') AS items
        FROM finance_operations o LEFT JOIN finance_operation_reversals r ON (r.tenant_id,r.operation_id)=(o.tenant_id,o.id) WHERE o.tenant_id=$1 AND o.party_id=$2 AND o.side=ANY($3::text[]) AND (o.kind<>'offset' OR $4) ORDER BY o.occurred_on DESC,o.created_at DESC,o.id`,
        [context.tenantId, input.partyId, input.side ? allowed.filter((s) => s === input.side) : allowed, allowed.length === 2],
      )
      const reviews = await context.client.query(
        `SELECT id,side,status,requested_at::text AS "requestedAt",request->>'reason' AS reason,
        request->'schedule' AS schedule,requested_by<>$3 AND status='pending' AND $4 AND side=ANY($6::text[]) AS "mayDecide"
        FROM finance_operation_reviews WHERE tenant_id=$1 AND party_id=$2 AND side=ANY($5::text[]) ORDER BY requested_at DESC`,
        [
          context.tenantId,
          input.partyId,
          context.authSubject,
          context.permissions.includes("finance.settlements.approve"),
          input.side ? allowed.filter((s) => s === input.side) : allowed,
          allowed.filter((s) => context.permissions.includes("finance." + s + "s.manage")),
        ],
      )
      return { tenantId: context.tenantId, data: rows.rows, reviews: reviews.rows }
    })
    return reply.header("cache-control", "no-store").send(result)
  })
}
