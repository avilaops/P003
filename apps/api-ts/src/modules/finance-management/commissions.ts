import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { reloadTenantPermissions } from "../../platform/database.js"
import { queryInteger } from "../registrations/query.js"
import { fixed } from "../sales/fixed.js"
import { consumeInvoices } from "./accrual.js"
import { book, list, orderTerms, unallocated } from "./commission-book.js"
import { capture } from "./journal.js"
import {
  bumpSeller,
  checkRevision,
  command,
  commissionManage,
  commissionRead,
  conflict,
  date,
  day,
  dueDate,
  invalid,
  lockSeller,
  missing,
  money,
  month,
  parse,
  percent,
  reason,
  response,
  seller,
  type Context,
} from "./shared.js"

const writes = [commissionRead, commissionManage]
const orderSchema = z.strictObject({
  sellerStaffId: z.guid(),
  commissionRate: percent,
  ipiRate: percent,
  paymentDay: day,
  usePolicies: z.boolean().optional(),
})
const adjustSchema = z.strictObject({
  amount: z.string().regex(/^-?(0|[1-9]\d{0,11})\.\d{2}$/),
  competence: month,
  paymentDay: day,
  reason,
  orderNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^(PV-)?\d{1,19}$/)
    .optional(),
})
const paySchema = z.strictObject({ throughCompetence: month, occurredOn: date, reference: reason })
const closeSchema = z.strictObject({ competence: month, dueDate: date, reason })
const policySchema = z.strictObject({
  productId: z.guid().nullable().optional(),
  productLine: z.enum(["national", "imported"]).nullable().optional(),
  trigger: z.enum(["invoice", "receipt"]),
  commissionRate: percent,
})
const pagination = z.strictObject({
  offset: queryInteger(0, 100000).default(0),
  limit: queryInteger(1, 100).default(25),
})
async function available(context: Context, id: string, through: string) {
  const rows = (
    await context.client.query(
      `SELECT e.id,e.amount_cents,COALESCE(e.source_date,p.occurred_on,e.competence)::text AS day
    FROM commission_entries e LEFT JOIN receivable_payments p ON p.tenant_id=e.tenant_id AND p.id=COALESCE(e.receipt_id,e.reversal_id)
    WHERE e.tenant_id=$1 AND e.seller_staff_id=$2 AND e.competence<=$3 AND ${unallocated} ORDER BY e.competence,e.id`,
      [context.tenantId, id, through + "-01"],
    )
  ).rows
  const total = rows.reduce((sum, row) => sum + BigInt(String(row.amount_cents)), 0n)
  if (total <= 0n || total > 99999999999999n)
    conflict("O saldo líquido até a competência precisa ser positivo e dentro do limite")
  return {
    total,
    ids: rows.map((row) => row.id),
    lastSource: rows.reduce((max, row) => (String(row.day) > max ? String(row.day) : max), ""),
  }
}
export function registerCommissions(app: FastifyInstance, deps: AppDependencies) {
  app.get("/api/v1/commissions", async (req, reply) => {
    const { offset, limit } = parse(pagination, req.query)
    return response(
      reply,
      await authorizeRequest(req, deps, async (c) => {
        requirePermission(c, commissionRead)
        return list(c, offset, limit)
      }),
    )
  })
  for (const [url, load] of [
    ["/api/v1/commissions/:id", book],
    ["/api/v1/orders/:id/commission", orderTerms],
  ] as const)
    app.get<{ Params: { id: string } }>(url, async (req, reply) =>
      response(
        reply,
        await authorizeRequest(req, deps, async (c) => {
          requirePermission(c, commissionRead)
          if (load === book) {
            await c.client.query("SELECT id FROM tenants WHERE id=$1 FOR SHARE", [c.tenantId])
            await reloadTenantPermissions(c)
            requirePermission(c, commissionRead)
          }
          return load(c, parse(z.guid(), req.params.id))
        }),
      ),
    )
  app.put<{ Params: { id: string } }>("/api/v1/orders/:id/commission", async (req, reply) => {
    const id = parse(z.guid(), req.params.id)
    const body = await command(
      req,
      deps,
      "commission.configure",
      id,
      [...writes, "sales.orders.manage"],
      orderSchema,
      async (c, input, rev) => {
        const row = (
          await c.client.query(
            `SELECT o.status,o.revision,EXISTS(SELECT 1 FROM receivables r JOIN receivable_payments p ON p.tenant_id=r.tenant_id AND p.receivable_id=r.id
        WHERE r.tenant_id=o.tenant_id AND r.order_id=o.id) AS received FROM sales_orders o WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
            [c.tenantId, id],
          )
        ).rows[0]
        if (!row) missing()
        checkRevision(row.revision, rev)
        if (row.status !== "draft" || row.received)
          conflict("Configure a comissão antes do aceite e do primeiro recebimento")
        const name = await seller(c, input.sellerStaffId, true)
        await c.client.query(
          `INSERT INTO order_commission_terms(tenant_id,order_id,seller_staff_id,seller_name,commission_rate,ipi_rate,payment_day,use_policies)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,order_id) DO UPDATE SET seller_staff_id=EXCLUDED.seller_staff_id,seller_name=EXCLUDED.seller_name,
        commission_rate=EXCLUDED.commission_rate,ipi_rate=EXCLUDED.ipi_rate,payment_day=EXCLUDED.payment_day,use_policies=EXCLUDED.use_policies`,
          [
            c.tenantId,
            id,
            input.sellerStaffId,
            name,
            fixed(input.commissionRate, 4),
            fixed(input.ipiRate, 4),
            input.paymentDay,
            input.usePolicies ?? false,
          ],
        )
        await lockSeller(c, input.sellerStaffId)
        await c.client.query(
          "UPDATE sales_orders SET revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [c.tenantId, id],
        )
        await record(c, req.headers, "sales_order", id, "commission.configured", { ...input, previousRevision: rev })
        return orderTerms(c, id)
      },
    )
    return response(reply, body)
  })
  app.post<{ Params: { id: string } }>("/api/v1/commissions/:id/adjustments", async (req, reply) => {
    const id = parse(z.guid(), req.params.id)
    const body = await command(req, deps, "commission.adjust", id, writes, adjustSchema, async (c, input, rev) => {
      const name = await seller(c, id, true)
      checkRevision(await lockSeller(c, id), rev)
      const amount = BigInt(input.amount.replace(".", ""))
      if (!amount) invalid("Informe um ajuste diferente de zero")
      const competence = input.competence + "-01"
      const sealed = (
        await c.client.query(
          "SELECT 1 FROM commission_closings WHERE tenant_id=$1 AND seller_staff_id=$2 AND competence>=$3 LIMIT 1",
          [c.tenantId, id, competence],
        )
      ).rows[0]
      if (sealed) conflict("Lance o ajuste em competência posterior ao último fechamento")
      let order = null
      if (input.orderNumber) {
        const number = BigInt(input.orderNumber.replace(/^PV-/, ""))
        if (number <= 0n || number > 9223372036854775807n) invalid("Número de pedido inválido")
        const found = (
          await c.client.query(
            "SELECT o.id FROM sales_orders o JOIN order_commission_terms t ON t.tenant_id=o.tenant_id AND t.order_id=o.id WHERE o.tenant_id=$1 AND o.number=$2 AND t.seller_staff_id=$3",
            [c.tenantId, number, id],
          )
        ).rows[0]
        if (!found) invalid("Pedido sem comissão deste vendedor")
        order = found.id
      }
      const entry = randomUUID()
      await c.client.query(
        `INSERT INTO commission_entries(id,tenant_id,seller_staff_id,seller_name,kind,competence,payment_due,base_cents,payment_day,amount_cents,reason,order_id)
        VALUES($1,$2,$3,$4,'adjustment',$5,$6,0,$7,$8,$9,$10)`,
        [
          entry,
          c.tenantId,
          id,
          name,
          competence,
          dueDate(competence, input.paymentDay),
          input.paymentDay,
          amount,
          input.reason,
          order,
        ],
      )
      await bumpSeller(c, id)
      await record(c, req.headers, "commission", entry, "commission.adjusted", {
        sellerStaffId: id,
        orderId: order,
        ...input,
        previousRevision: rev,
      })
      return book(c, id)
    })
    return response(reply, body, 201)
  })
  app.post<{ Params: { id: string } }>("/api/v1/commissions/:id/payments", async (req, reply) => {
    const id = parse(z.guid(), req.params.id)
    const body = await command(req, deps, "commission.pay", id, writes, paySchema, async (c, input, rev) => {
      await seller(c, id)
      checkRevision(await lockSeller(c, id), rev)
      if (input.occurredOn < input.throughCompetence + "-01")
        invalid("O pagamento deve ocorrer a partir da competência")
      const { total, ids, lastSource } = await available(c, id, input.throughCompetence)
      if (input.occurredOn < lastSource) invalid("O pagamento precisa ser posterior ou igual às datas dos lançamentos")
      const payment = randomUUID()
      await c.client.query(
        `INSERT INTO commission_payments(id,tenant_id,seller_staff_id,through_competence,amount_cents,occurred_on,reference)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [payment, c.tenantId, id, input.throughCompetence + "-01", total, input.occurredOn, input.reference],
      )
      await c.client.query(
        "INSERT INTO commission_payment_entries(tenant_id,seller_staff_id,payment_id,entry_id) SELECT $1,$2,$3,unnest($4::uuid[])",
        [c.tenantId, id, payment, ids],
      )
      await bumpSeller(c, id)
      await record(c, req.headers, "commission_payment", payment, "commission.paid", {
        sellerStaffId: id,
        amount: money(total),
        entryIds: ids,
        source: "manual_declaration",
        ...input,
      })
      return book(c, id)
    })
    return response(reply, body)
  })
  app.post<{ Params: { id: string } }>("/api/v1/commissions/:id/policies", async (req, reply) => {
    const id = parse(z.guid(), req.params.id)
    const body = await command(req, deps, "commission.policy", id, writes, policySchema, async (c, input, rev) => {
      await seller(c, id, true)
      checkRevision(await lockSeller(c, id), rev)
      if (input.productId && input.productLine) invalid("Escolha produto ou linha para a política")
      if (
        input.productId &&
        !(await c.client.query("SELECT id FROM products WHERE tenant_id=$1 AND id=$2", [c.tenantId, input.productId]))
          .rows.length
      )
        missing()
      const parameters = [c.tenantId, id, input.productId ?? null, input.productLine ?? null]
      const existing = (
        await c.client.query(
          `SELECT id FROM commission_policies WHERE tenant_id=$1 AND seller_staff_id=$2
        AND product_id IS NOT DISTINCT FROM $3 AND product_line IS NOT DISTINCT FROM $4`,
          parameters,
        )
      ).rows[0]
      const policyId = String(existing?.id ?? randomUUID()),
        rate = fixed(input.commissionRate, 4)
      await c.client.query(
        `INSERT INTO commission_policies(tenant_id,seller_staff_id,product_id,product_line,id,trigger_event,commission_rate)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,id) DO UPDATE SET trigger_event=EXCLUDED.trigger_event,commission_rate=EXCLUDED.commission_rate`,
        [...parameters, policyId, input.trigger, rate],
      )
      await bumpSeller(c, id)
      await record(c, req.headers, "commission_policy", policyId, "commission.policy_configured", {
        sellerStaffId: id,
        ...input,
      })
      return book(c, id)
    })
    return response(reply, body)
  })
  app.post<{ Params: { id: string } }>("/api/v1/commissions/:id/closings", async (req, reply) => {
    const id = parse(z.guid(), req.params.id)
    const body = await command(
      req,
      deps,
      "commission.close",
      id,
      [...writes, "finance.payables.originate"],
      closeSchema,
      async (c, input, rev) => {
        const name = await seller(c, id)
        checkRevision(await lockSeller(c, id), rev)
        const competence = input.competence + "-01"
        if (input.dueDate < competence) invalid("O vencimento deve ocorrer a partir da competência")
        await consumeInvoices(c, req.headers)
        const prior = (
          await c.client.query(
            "SELECT 1 FROM commission_closings WHERE tenant_id=$1 AND seller_staff_id=$2 AND competence>=$3 LIMIT 1",
            [c.tenantId, id, competence],
          )
        ).rows[0]
        if (prior) conflict("A competência já está incluída em um fechamento")
        const { total, ids, lastSource } = await available(c, id, input.competence)
        if (input.dueDate < lastSource) invalid("O vencimento não pode anteceder os lançamentos")
        const closing = randomUUID(),
          payable = randomUUID()
        await c.client.query(
          `INSERT INTO commission_closings(tenant_id,id,seller_staff_id,competence,due_date,amount_cents,reason,approved_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [c.tenantId, closing, id, competence, input.dueDate, total, input.reason, c.authSubject],
        )
        await c.client.query(
          "INSERT INTO commission_closing_entries(tenant_id,seller_staff_id,closing_id,entry_id) SELECT $1,$2,$3,unnest($4::uuid[])",
          [c.tenantId, id, closing, ids],
        )
        await c.client.query(
          "INSERT INTO payables(id,tenant_id,commission_closing_id,supplier_name,due_date,amount_cents,competence_on,category_id) VALUES($1,$2,$3,$4,$5,$6,$7,finance_default_category($2,'payroll'))",
          [payable, c.tenantId, closing, name, input.dueDate, total, competence],
        )
        await capture(c, req.headers, "commission.closing", closing, "payable", payable, competence, total)
        await record(c, req.headers, "payable", payable, "payable.created", {
          commissionClosingId: closing,
          sellerStaffId: id,
          amount: money(total),
          dueDate: input.dueDate,
        })
        await bumpSeller(c, id)
        await record(c, req.headers, "commission_closing", closing, "commission.closed", {
          sellerStaffId: id,
          payableId: payable,
          entryIds: ids,
          ...input,
        })
        return book(c, id)
      },
    )
    return response(reply, body, 201)
  })
}
