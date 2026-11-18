import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, replay, remember, record } from "../../platform/commands.js"
import { parseRevision, revisionValue, nextRevision } from "../../platform/revision.js"
import { decimal, fixed, validateDate } from "../sales/fixed.js"
import { heldQuantity } from "../orders/fulfillment.js"
import { allocateOrderAdvances } from "../finance-insights/operations.js"
import { onPurchaseReceipt, onPurchaseReversal } from "../finance-management/accrual.js"
import { queryInteger } from "../registrations/query.js"
import { conflict, currentRevision, invalid, loadWallet, missing } from "./snapshot.js"
import { pathId, type Headers } from "./documents.js"
import { reverseWalletPayment } from "./settlements.js"

const summarySql = `SELECT r.id,r.order_id AS "orderId",r.reference,r.occurred_on::text AS "occurredOn",(r.amount_cents::numeric/100)::numeric(16,2)::text AS amount,
  p.id AS "payableId",x.id AS "reversalId",o.revision AS "orderRevision" FROM purchase_receipts r JOIN purchase_orders o ON (o.tenant_id,o.id)=(r.tenant_id,r.order_id)
  LEFT JOIN payables p ON (p.tenant_id,p.receipt_id)=(r.tenant_id,r.id) LEFT JOIN purchase_receipt_reversals x ON (x.tenant_id,x.receipt_id)=(r.tenant_id,r.id)`
export const purchaseSummary = `SELECT id,supplier_id AS "supplierId",supplier_name AS "supplierName",supplier_tax_id AS "supplierTaxId",due_date::text AS "dueDate",(amount_cents::numeric/100)::numeric(16,2)::text AS amount,status,revision FROM purchase_orders`
export async function purchaseOrder(ctx: AuthorizedContext, id: string) {
  const args = [ctx.tenantId, id],
    r = (await ctx.client.query(purchaseSummary + " WHERE tenant_id=$1 AND id=$2 FOR SHARE", args)).rows[0]
  if (!r) missing()
  const items = (
    await ctx.client.query(
      `SELECT product_id AS "productId",sku,name,unit,(quantity_micros::numeric/1000000)::numeric(19,6)::text AS quantity,(received_micros::numeric/1000000)::numeric(19,6)::text AS "receivedQuantity",(cost_cents::numeric/100)::numeric(16,2)::text AS "unitCost",(amount_cents::numeric/100)::numeric(16,2)::text AS amount FROM purchase_order_lines WHERE tenant_id=$1 AND order_id=$2 ORDER BY line_number`,
      args,
    )
  ).rows
  const receiptCount = Number(
    (await ctx.client.query("SELECT count(*) AS n FROM purchase_receipts WHERE tenant_id=$1 AND order_id=$2", args))
      .rows[0]!.n,
  )
  return {
    tenantId: ctx.tenantId,
    canEdit: ctx.permissions.includes("purchasing.orders.manage"),
    data: {
      ...r,
      revision: revisionValue(r.revision),
      status: String(r.status),
      supplierName: String(r.supplierName),
      dueDate: String(r.dueDate),
    },
    items,
    receiptCount,
  }
}
async function receipt(ctx: AuthorizedContext, id: string) {
  const args = [ctx.tenantId, id],
    row = (await ctx.client.query(summarySql + " WHERE r.tenant_id=$1 AND r.id=$2", args)).rows[0]
  if (!row) missing()
  const items = (
    await ctx.client.query(
      `SELECT product_id AS "productId",unit,(quantity_micros::numeric/1000000)::numeric(19,6)::text AS quantity,(amount_cents::numeric/100)::numeric(16,2)::text AS amount FROM purchase_receipt_lines WHERE tenant_id=$1 AND receipt_id=$2 ORDER BY product_id`,
      args,
    )
  ).rows
  return {
    tenantId: ctx.tenantId,
    data: {
      ...row,
      id,
      orderId: String(row.orderId),
      orderRevision: revisionValue(row.orderRevision),
      occurredOn: String(row.occurredOn),
      payableId: row.payableId ? String(row.payableId) : null,
      reversalId: row.reversalId,
      amount: String(row.amount),
    },
    items,
  }
}
// Indexed and legacy distribution documents are both immutable. A legacy cancellation must match its authorized response.
export async function fiscalOrigin(ctx: AuthorizedContext, orderId: string) {
  const origin = (
    await ctx.client.query(
      "SELECT n.access_key,n.environment FROM fiscal_received_purchase_links l JOIN fiscal_received_nfes n ON (n.tenant_id,n.id)=(l.tenant_id,l.received_nfe_id) WHERE l.tenant_id=$1 AND l.purchase_order_id=$2",
      [ctx.tenantId, orderId],
    )
  ).rows[0]
  if (Number(origin?.environment) !== 1) return origin
  const args = [ctx.tenantId, origin!.access_key]
  if (
    (
      await ctx.client.query(
        "SELECT id FROM fiscal_monitor_documents WHERE tenant_id=$1 AND access_key=$2 AND (situation IN ('2','3') OR situation LIKE 'event:110111:%') LIMIT 1",
        args,
      )
    ).rows.length
  )
    conflict("NF-e cancelada ou denegada")
  const candidates = (
    await ctx.client.query(
      "SELECT 1 FROM fiscal_monitor_documents WHERE tenant_id=$1 AND kind='event' AND access_key IS NULL AND strpos(xml,$2)>0 LIMIT 1",
      args,
    )
  ).rows.length
  if (candidates) {
    const cancelled = (
      await ctx.client.query(
        `SELECT 1 FROM fiscal_monitor_documents d JOIN tenants t ON t.id=d.tenant_id
      CROSS JOIN LATERAL XMLTABLE(XMLNAMESPACES('http://www.portalfiscal.inf.br/nfe' AS n),'/n:procEventoNFe'
        PASSING CASE WHEN octet_length(d.xml)<=10485760 AND strpos(upper(d.xml),'<!DOCTYPE')=0 AND xml_is_well_formed_document(d.xml) THEN xmlparse(document d.xml) ELSE NULL END
        COLUMNS key text PATH 'n:evento/n:infEvento/n:chNFe', event text PATH 'n:evento/n:infEvento/n:tpEvento', env text PATH 'n:evento/n:infEvento/n:tpAmb',
        seq text PATH 'n:evento/n:infEvento/n:nSeqEvento', identity text PATH 'n:evento/n:infEvento/@Id', cnpj text PATH 'n:evento/n:infEvento/n:CNPJ', cpf text PATH 'n:evento/n:infEvento/n:CPF',
        resultkey text PATH 'n:retEvento/n:infEvento/n:chNFe', resultenv text PATH 'n:retEvento/n:infEvento/n:tpAmb',resultevent text PATH 'n:retEvento/n:infEvento/n:tpEvento',
        resultseq text PATH 'n:retEvento/n:infEvento/n:nSeqEvento',code text PATH 'n:retEvento/n:infEvento/n:cStat',protocol text PATH 'n:retEvento/n:infEvento/n:nProt',dest text PATH 'n:retEvento/n:infEvento/n:CNPJDest') e
      WHERE d.tenant_id=$1 AND d.kind='event' AND d.access_key IS NULL AND strpos(d.xml,$2)>0 AND e.key=$2 AND e.resultkey=e.key AND e.env='1' AND e.resultenv=e.env
        AND e.event='110111' AND e.resultevent=e.event AND e.seq='1' AND e.resultseq=e.seq AND e.identity='ID110111'||e.key||'01' AND num_nonnulls(e.cnpj,e.cpf)=1
        AND coalesce(e.cnpj,e.cpf) ~ '^([0-9]{11}|[0-9]{14})$' AND lpad(coalesce(e.cnpj,e.cpf),14,'0')=substr(e.key,7,14) AND (e.dest IS NULL OR e.dest=t.tax_id)
        AND e.code IN ('135','155') AND e.protocol ~ '^[0-9]{15}$' LIMIT 1`,
        args,
      )
    ).rows.length
    if (cancelled) conflict("NF-e com cancelamento autorizado")
  }
  return origin
}
const purchaseReceipt = z.strictObject({
  reference: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .refine((v) => !/\p{Cc}/u.test(v)),
  occurredOn: z.string().transform(validateDate),
  items: z
    .array(
      z.strictObject({
        productId: z.guid().transform((v) => v.toLowerCase()),
        quantity: z.string().refine((v) => fixed(v, 6) > 0n),
      }),
    )
    .min(1)
    .max(100),
})
const buyValue = (quantity: bigint, cost: bigint) => (quantity * cost + 500000n) / 1000000n
async function receive(
  ctx: AuthorizedContext,
  headers: Headers,
  orderId: string,
  expected: ReturnType<typeof parseRevision>,
  input: z.infer<typeof purchaseReceipt>,
) {
  const order = await purchaseOrder(ctx, orderId),
    t = ctx.tenantId
  currentRevision(order.data.revision, expected)
  if (!["confirmed", "partially_received"].includes(order.data.status))
    conflict("Recebimento exige compra confirmada e saldo pendente")
  if (new Set(input.items.map((i) => i.productId)).size !== input.items.length)
    invalid("Agrupe a quantidade de cada produto")
  if (
    (
      await ctx.client.query("SELECT id FROM purchase_receipts WHERE tenant_id=$1 AND order_id=$2 AND reference=$3", [
        t,
        orderId,
        input.reference,
      ])
    ).rows.length
  )
    conflict("Referência já recebida neste pedido")
  const fiscal = await fiscalOrigin(ctx, orderId),
    lines = []
  let total = 0n
  for (const item of input.items) {
    const saved = order.items.find((row) => row.productId === item.productId)
    if (!saved) conflict("Produto não pertence à compra")
    const prod = (
      await ctx.client.query("SELECT unit,status FROM products WHERE tenant_id=$1 AND id=$2", [t, item.productId])
    ).rows[0]
    if (!prod || prod.status !== "active" || prod.unit !== saved.unit) conflict("Produto inativo ou unidade alterada")
    const quantity = fixed(item.quantity, 6),
      received = fixed(String(saved.receivedQuantity), 6),
      cumulative = received + quantity,
      cost = fixed(String(saved.unitCost), 2)
    if (cumulative > fixed(String(saved.quantity), 6)) conflict("Quantidade excede o saldo pendente")
    if (
      fiscal &&
      !(
        await ctx.client.query(
          "SELECT 1 FROM fiscal_received_item_costs WHERE tenant_id=$1 AND purchase_order_id=$2 AND product_id=$3 AND quantity_micros>=$4",
          [t, orderId, item.productId, cumulative],
        )
      ).rows.length
    )
      conflict("Recebimento excede a quantidade fiscal vinculada")
    const amount = buyValue(cumulative, cost) - buyValue(received, cost)
    total += amount
    lines.push({ id: item.productId, unit: saved.unit, quantity, cumulative, amount })
  }
  const receiptId = randomUUID(),
    revision = nextRevision(expected)
  await ctx.client.query(
    "INSERT INTO purchase_receipts(id,tenant_id,order_id,reference,occurred_on,amount_cents) VALUES($1,$2,$3,$4,$5,$6)",
    [receiptId, t, orderId, input.reference, input.occurredOn, total],
  )
  for (const line of lines) {
    await ctx.client.query(
      "INSERT INTO purchase_receipt_lines(tenant_id,receipt_id,product_id,unit,quantity_micros,amount_cents) VALUES($1,$2,$3,$4,$5,$6)",
      [t, receiptId, line.id, line.unit, line.quantity, line.amount],
    )
    const balance = (
      await ctx.client.query(
        `INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,$3)
      ON CONFLICT(tenant_id,product_id) DO UPDATE SET quantity_micros=stock_balances.quantity_micros+excluded.quantity_micros WHERE stock_balances.quantity_micros<=999999999999999999-excluded.quantity_micros RETURNING quantity_micros`,
        [t, line.id, line.quantity],
      )
    ).rows[0]
    if (!balance) conflict("Saldo de estoque excede o limite")
    const movement = randomUUID(),
      after = BigInt(String(balance.quantity_micros))
    await ctx.client.query(
      "INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,source_purchase_receipt_id) VALUES($1,$2,$3,'receipt',$4,$5,$6,$7)",
      [movement, t, line.id, line.quantity, after, "Recebimento de compra " + receiptId, receiptId],
    )
    await record(ctx, headers, "stock_movement", movement, "stock.moved", {
      sourcePurchaseReceiptId: receiptId,
      productId: line.id,
      direction: "receipt",
      quantity: decimal(line.quantity, 6),
      balanceAfter: decimal(after, 6),
    })
    await ctx.client.query(
      "UPDATE purchase_order_lines SET received_micros=$4 WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3",
      [t, orderId, line.id, line.cumulative],
    )
  }
  const payableId = total ? randomUUID() : null
  if (payableId) {
    await ctx.client.query(
      "INSERT INTO payables(id,tenant_id,receipt_id,supplier_name,due_date,amount_cents,competence_on) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [payableId, t, receiptId, order.data.supplierName, order.data.dueDate, total, input.occurredOn],
    )
    await record(ctx, headers, "payable", payableId, "payable.created", {
      receiptId,
      amount: decimal(total, 2),
      revision: 1,
    })
  }
  const partial =
      (
        await ctx.client.query(
          "SELECT 1 FROM purchase_order_lines WHERE tenant_id=$1 AND order_id=$2 AND received_micros<quantity_micros LIMIT 1",
          [t, orderId],
        )
      ).rows.length > 0,
    status = partial ? "partially_received" : "received"
  await ctx.client.query(
    "UPDATE purchase_orders SET status=$3,revision=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2",
    [t, orderId, status, revision],
  )
  await onPurchaseReceipt(ctx, headers, receiptId)
  if(payableId) await allocateOrderAdvances(ctx,headers,orderId,{titleId:payableId,occurredOn:input.occurredOn})
  await record(ctx, headers, "purchase_receipt", receiptId, "purchase.received", {
    orderId,
    payableId,
    amount: decimal(total, 2),
    orderRevision: revision,
  })
  await record(ctx, headers, "purchase_order", orderId, "purchase.receipt_applied", {
    receiptId,
    previousRevision: expected,
    revision,
    status,
  })
  return { order: await purchaseOrder(ctx, orderId), receipt: await receipt(ctx, receiptId), payableId }
}
export function registerPurchaseReceipts(app: FastifyInstance, deps: AppDependencies) {
  const read = "purchasing.orders.read",
    url = "/api/v1/purchase-orders/:id/receipts",
    detail = "/api/v1/purchase-receipts/:id"
  app.get<{ Params: { id: string } }>(url, async (req, reply) => {
    const body = await authorizeRequest(req, deps, async (ctx) => {
      requirePermission(ctx, read)
      const id = pathId(req.params.id),
        q = z
          .object({ limit: queryInteger(1, 100).default(25), offset: queryInteger(0, 100000).default(0) })
          .safeParse(req.query)
      if (!q.success) invalid("Paginação inválida")
      const order = await purchaseOrder(ctx, id)
      const data = (
        await ctx.client.query(
          summarySql + " WHERE r.tenant_id=$1 AND r.order_id=$2 ORDER BY r.created_at,r.id LIMIT $3 OFFSET $4",
          [ctx.tenantId, id, q.data.limit, q.data.offset],
        )
      ).rows.map((r) => ({ ...r, orderRevision: revisionValue(r.orderRevision) }))
      return { tenantId: ctx.tenantId, data, total: order.receiptCount, ...q.data }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  app.get<{ Params: { id: string } }>(detail, async (req, reply) => {
    const body = await authorizeRequest(req, deps, (ctx) => {
      requirePermission(ctx, read)
      return receipt(ctx, pathId(req.params.id))
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  app.post<{ Params: { id: string } }>(url, async (req, reply) => {
    const key = commandKey(req.headers["idempotency-key"]),
      revision = parseRevision(req.headers["if-match"])
    const result = await authorizeRequest(req, deps, async (ctx) => {
      for (const p of [read, "purchasing.receipts.create", "inventory.stock.manage", "finance.payables.originate"])
        requirePermission(ctx, p)
      const id = pathId(req.params.id),
        parsed = purchaseReceipt.safeParse(req.body)
      if (!parsed.success) invalid("Recebimento inválido")
      const intent = { id, revision, input: parsed.data },
        prev = await replay(ctx, key, "purchase.receive", intent)
      if (prev) return prev
      const body = await receive(ctx, req.headers, id, revision, parsed.data)
      await remember(ctx, key, "purchase.receive", intent, body)
      return body
    })
    return reply
      .code(201)
      .header("etag", '"' + (result.order as { data: { revision: unknown } }).data.revision + '"')
      .header("cache-control", "no-store")
      .send(result)
  })
  app.get<{ Params: { id: string } }>(detail + "/reversals", async (req, reply) => {
    const body = await authorizeRequest(req, deps, async (ctx) => {
      requirePermission(ctx, read)
      const id = pathId(req.params.id)
      await receipt(ctx, id)
      const rows = (
        await ctx.client.query(
          "SELECT summary FROM purchase_receipt_reversals WHERE tenant_id=$1 AND receipt_id=$2 ORDER BY created_at,id",
          [ctx.tenantId, id],
        )
      ).rows
      return { tenantId: ctx.tenantId, data: rows.map((row) => row.summary) }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  app.post<{ Params: { id: string } }>(detail + "/reverse", async (req, reply) => {
    const key = commandKey(req.headers["idempotency-key"]),
      expected = parseRevision(req.headers["if-match"])
    const body = await authorizeRequest(req, deps, async (ctx) => {
      for (const p of [read, "purchasing.orders.manage", "inventory.stock.manage", "finance.payables.manage"])
        requirePermission(ctx, p)
      const id = pathId(req.params.id),
        parsed = z
          .strictObject({
            reason: z
              .string()
              .max(200)
              .refine((v) => v.trim().length >= 15 && !/\p{Cc}/u.test(v)),
            occurredOn: z.string().transform(validateDate),
          })
          .safeParse(req.body)
      if (!parsed.success) invalid("Informe a data e um motivo com 15 a 200 caracteres")
      const { reason, occurredOn } = parsed.data,
        intent = {
          id,
          revision: expected,
          bodySha256: createHash("sha256").update(JSON.stringify({ reason, occurredOn })).digest("hex"),
          input: parsed.data,
        },
        scope = "purchase.receipt.reversed"
      const prev = await replay(ctx, key, scope, intent)
      if (prev) return prev
      const original = await receipt(ctx, id),
        orderId = original.data.orderId,
        order = await purchaseOrder(ctx, orderId)
      currentRevision(order.data.revision, expected)
      if (original.data.reversalId || !["received", "partially_received", "closed"].includes(order.data.status))
        conflict("Recebimento não está ativo")
      if (occurredOn < original.data.occurredOn) invalid("Estorno não pode anteceder o recebimento")
      const rounding = (
        await ctx.client.query(
          `SELECT 1 FROM purchase_receipt_lines selected JOIN purchase_order_lines o ON (o.tenant_id,o.order_id,o.product_id)=(selected.tenant_id,$3::uuid,selected.product_id)
        WHERE selected.tenant_id=$1 AND selected.receipt_id=$2 AND (o.received_micros<selected.quantity_micros OR floor(((o.received_micros-selected.quantity_micros)::numeric*o.cost_cents+500000)/1000000) <>
          (SELECT coalesce(sum(l.amount_cents),0) FROM purchase_receipt_lines l JOIN purchase_receipts r ON (r.tenant_id,r.id)=(l.tenant_id,l.receipt_id)
           WHERE l.tenant_id=$1 AND r.order_id=$3 AND l.product_id=selected.product_id AND l.receipt_id<>$2 AND NOT EXISTS(SELECT 1 FROM purchase_receipt_reversals x WHERE (x.tenant_id,x.receipt_id)=(r.tenant_id,r.id))))`,
          [ctx.tenantId, id, orderId],
        )
      ).rows
      if (rounding.length) conflict("Desfaça os recebimentos posteriores para preservar o custo")
      const stockMovementIds: string[] = [],
        paymentReversalIds: string[] = []
      for (const line of original.items) {
        const product = line.productId,
          quantity = fixed(String(line.quantity), 6)
        const movement = (
          await ctx.client.query(
            "SELECT m.id,m.quantity_micros,b.quantity_micros AS balance FROM stock_movements m JOIN stock_balances b ON (b.tenant_id,b.product_id)=(m.tenant_id,m.product_id) WHERE m.tenant_id=$1 AND m.source_purchase_receipt_id=$2 AND m.product_id=$3 AND m.direction='receipt' AND NOT EXISTS(SELECT 1 FROM stock_movements x WHERE x.tenant_id=$1 AND x.reverses_id=m.id) FOR UPDATE OF b",
            [ctx.tenantId, id, product],
          )
        ).rows[0]
        if (!movement || BigInt(String(movement.quantity_micros)) !== quantity)
          conflict("Movimentos de estoque divergentes")
        const after = BigInt(String(movement.balance)) - quantity
        if (after < (await heldQuantity(ctx, product))) conflict("Saldo disponível insuficiente para o estorno")
        const inverse = randomUUID()
        await ctx.client.query("UPDATE stock_balances SET quantity_micros=$3 WHERE tenant_id=$1 AND product_id=$2", [
          ctx.tenantId,
          product,
          after,
        ])
        await ctx.client.query(
          "INSERT INTO stock_movements(id,tenant_id,product_id,direction,quantity_micros,balance_after_micros,reason,reverses_id) VALUES($1,$2,$3,'issue',$4,$5,$6,$7)",
          [inverse, ctx.tenantId, product, quantity, after, reason.trim(), movement.id],
        )
        await record(ctx, req.headers, "stock_movement", inverse, "stock.moved", {
          sourceId: id,
          productId: product,
          direction: "issue",
          quantity: decimal(quantity, 6),
          balanceAfter: decimal(after, 6),
          reversesId: movement.id,
          reason: reason.trim(),
        })
        stockMovementIds.push(inverse)
      }
      const payableId = original.data.payableId
      if (!payableId && fixed(original.data.amount, 2) > 0n)
        conflict("Recebimento sem título financeiro correspondente")
      if (payableId) {
        let title = await loadWallet(ctx, "payables", payableId)
        if (title.data.status === "cancelled") conflict("Título já cancelado")
        for (const p of title.payments.filter(
          (p) => p.kind === "payment" && !title.payments.some((x) => x.reversesId === p.id),
        )) {
          title = await reverseWalletPayment(ctx, req.headers, "payables", payableId, title.data.revision, {
            paymentId: p.id,
            reason: reason.trim(),
            occurredOn,
          })
          paymentReversalIds.push(title.payments.find((x) => x.reversesId === p.id)!.id)
        }
        await ctx.client.query(
          "UPDATE payables SET status='cancelled',payment_id=NULL,revision=revision+1 WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, payableId],
        )
        await record(ctx, req.headers, "payable", payableId, "payable.cancelled", {
          receiptId: id,
          previousRevision: title.data.revision,
          revision: nextRevision(title.data.revision),
        })
      }
      await ctx.client.query(
        "UPDATE purchase_order_lines o SET received_micros=o.received_micros-l.quantity_micros FROM purchase_receipt_lines l WHERE o.tenant_id=$1 AND o.order_id=$2 AND (l.tenant_id,l.product_id)=(o.tenant_id,o.product_id) AND l.receipt_id=$3",
        [ctx.tenantId, orderId, id],
      )
      const remaining =
        (
          await ctx.client.query(
            "SELECT 1 FROM purchase_order_lines WHERE tenant_id=$1 AND order_id=$2 AND received_micros>0 LIMIT 1",
            [ctx.tenantId, orderId],
          )
        ).rows.length > 0
      const revision = nextRevision(expected),
        status = order.data.status === "closed" ? "closed" : remaining ? "partially_received" : "confirmed",
        inverse = randomUUID()
      const data = {
        id: inverse,
        kind: "purchase_receipt_reversal",
        sourceId: id,
        receiptId: id,
        orderId,
        revision,
        orderStatus: status,
        reason: reason.trim(),
        occurredOn,
        payableId,
        stockMovementIds,
        paymentReversalIds,
      }
      await ctx.client.query(
        "INSERT INTO purchase_receipt_reversals(id,tenant_id,receipt_id,order_id,reason,occurred_on,order_revision,summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [inverse, ctx.tenantId, id, orderId, data.reason, occurredOn, revision, data],
      )
      await ctx.client.query(
        "UPDATE purchase_orders SET status=$3,revision=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId, orderId, status, revision],
      )
      await onPurchaseReversal(ctx, req.headers, inverse)
      await record(ctx, req.headers, "purchase_order", orderId, "purchase.receipt_reversed", data)
      await record(ctx, req.headers, "purchase_receipt", id, scope, data)
      const result = { tenantId: ctx.tenantId, data }
      await remember(ctx, key, scope, intent, result)
      return result
    })
    return reply
      .header("etag", '"' + (body.data as { revision: unknown }).revision + '"')
      .header("cache-control", "no-store")
      .send(body)
  })
}
