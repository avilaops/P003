import { createHash, randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { authorizeRequest, requirePermission, type AccessDependencies, type AuthorizedContext } from "../../../platform/access.js"
import type { Revision } from "../../../platform/revision.js"
import { queryInteger, searchQuery } from "../../registrations/query.js"
import { movement } from "../../warranties/materials.js"
import { parameter } from "../parameters.js"
import type { ServicePorts } from "../ports.contract.js"
import { brazilToday, cents, command, conflict, id, invalid, micros, notFound, parse, permissions, quantity, readRoute, send, staleRevision, text } from "../shared.js"

const { ordersRead: read, ordersManage: manage } = permissions
const base = "/api/v1/service-orders"
const statuses = z.enum(["open", "scheduled", "in_progress", "completed", "cancelled"])
const when = z.iso.datetime({ offset: true })
const checklistItem = z.strictObject({ label: text(2, 160), required: z.boolean().default(true), done: z.boolean().default(false) })
const createInput = z.strictObject({
  customerId: id, title: text(3, 160), description: text(0, 4000).default(""), productId: id.nullish(), serialNumber: text(1, 120).nullish(),
  technicianId: id.nullish(), scheduledAt: when.nullish(), slaHours: z.number().int().min(1).max(8760).nullish(),
  warrantyCaseId: id.nullish(), checklist: z.array(checklistItem).max(60).default([]),
})
const scheduleInput = z.strictObject({ technicianId: id, scheduledAt: when })
const checklistInput = z.strictObject({ items: z.array(checklistItem).min(1).max(60) })
const hoursInput = z.strictObject({ minutes: z.number().int().min(1).max(1440), rateCents: cents, note: text(0, 300).default("") })
const partInput = z.strictObject({ productId: id, quantity, unitCents: cents, serialNumbers: z.array(text(1, 120)).min(1).max(1000).optional() })
const photoLimit = 6_000_000
const photoInput = z.strictObject({ filename: text(1, 160).regex(/^[^/\\\r\n]+$/), mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]), caption: text(0, 200).default(""), base64: z.base64().min(4).max(4 * Math.ceil(photoLimit / 3)) })
const closeInput = z.strictObject({ signerName: text(3, 120), signaturePng: z.base64().min(100).max(400_000), notes: text(0, 2000).default("") })
const cancelInput = z.strictObject({ reason: text(3, 500) })
const listQuery = z.strictObject({ q: searchQuery, status: statuses.optional(), technicianId: id.optional(), offset: queryInteger(0, 1_000_000).default(0), limit: queryInteger(1, 100).default(25) })
const equipmentQuery = z.strictObject({ serialNumber: text(1, 120) })

const projection = `o.id,o.number,o.title,o.description,o.customer_id AS "customerId",c.legal_name AS "customerName",o.product_id AS "productId",p.name AS "productName",
  o.serial_number AS "serialNumber",o.technician_id AS "technicianId",s.name AS "technicianName",o.warranty_case_id AS "warrantyCaseId",o.under_warranty AS "underWarranty",
  o.status,o.scheduled_at AS "scheduledAt",o.started_at AS "startedAt",o.completed_at AS "completedAt",o.sla_due_at AS "slaDueAt",o.checklist,
  (o.signature->>'signerName') AS "signedBy",o.labor_cents AS "laborCents",o.parts_cents AS "partsCents",o.charge_status AS "chargeStatus",o.charge_ref AS "chargeRef",
  o.charge_message AS "chargeMessage",o.revision,o.created_at AS "createdAt",o.updated_at AS "updatedAt"
  FROM service_orders o JOIN parties c ON (c.tenant_id,c.id)=(o.tenant_id,o.customer_id)
  LEFT JOIN products p ON (p.tenant_id,p.id)=(o.tenant_id,o.product_id) LEFT JOIN staff s ON (s.tenant_id,s.id)=(o.tenant_id,o.technician_id)`

async function load(ctx: AuthorizedContext, orderId: string) {
  const row = (await ctx.client.query("SELECT to_jsonb(t) AS data FROM (SELECT " + projection + " WHERE o.tenant_id=$1 AND o.id=$2) t", [ctx.tenantId, orderId])).rows[0]
  if (!row) return notFound("Ordem de serviço não encontrada")
  return row.data as Record<string, unknown> & { revision: Revision }
}
type Locked = { status: string; revision: Revision; customer_id: string; serial_number: string | null; under_warranty: boolean; checklist: { label: string; required: boolean; done: boolean }[]; labor_cents: string; parts_cents: string; number: string; charge_status: string }
async function lock(ctx: AuthorizedContext, orderId: string, expected: Revision) {
  const row = (await ctx.client.query<Locked>("SELECT status,revision,customer_id,serial_number,under_warranty,checklist,labor_cents::text,parts_cents::text,number,charge_status FROM service_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [ctx.tenantId, orderId])).rows[0]
  if (!row) return notFound("Ordem de serviço não encontrada")
  staleRevision(row.revision, expected)
  return row
}
const editable = (row: Locked) => { if (!["open", "scheduled", "in_progress"].includes(row.status)) conflict("A ordem de serviço já está encerrada") }
const touch = (ctx: AuthorizedContext, orderId: string, set = "") => ctx.client.query(`UPDATE service_orders SET ${set}revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [ctx.tenantId, orderId])
async function activeTechnician(ctx: AuthorizedContext, staffId: string) {
  if (!(await ctx.client.query("SELECT 1 FROM staff WHERE tenant_id=$1 AND id=$2 AND status='active' AND is_employee", [ctx.tenantId, staffId])).rows[0]) invalid("Selecione um técnico ativo desta empresa")
}

/** Cobrança do fechamento: título avulso pelo FI1 (#297); sem a porta fica pendente e pode ser repetida. */
async function charge(ctx: AuthorizedContext, orderId: string, ports: ServicePorts | undefined) {
  const row = (await ctx.client.query<{ number: string; customer_id: string; total: string; title: string }>("SELECT number,customer_id,(labor_cents+parts_cents)::text AS total,title FROM service_orders WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, orderId])).rows[0]!
  const amount = Number(row.total)
  if (amount <= 0) { await ctx.client.query("UPDATE service_orders SET charge_status='waived',charge_message='Sem valor a cobrar' WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, orderId]); return }
  const today = brazilToday(), due = new Date(today + "T00:00:00Z"); due.setUTCDate(due.getUTCDate() + parameter("services.orders.charge_due_days"))
  let status: "issued" | "pending" | "blocked" = "pending", reference: string | null = null, message: string | null = "Aguardando o título a receber avulso (Financeiro FI1)"
  if (ports?.receivables) {
    await ctx.client.query("SAVEPOINT service_order_charge")
    try {
      const result = await ports.receivables.open(ctx, { idempotencyKey: orderId, customerId: row.customer_id, amountCents: amount, issueOn: today, dueOn: due.toISOString().slice(0, 10), description: `${row.number} • ${row.title}`, origin: { type: "service_order", id: orderId } })
      await ctx.client.query("RELEASE SAVEPOINT service_order_charge")
      if (result.status === "issued") { status = "issued"; reference = result.reference; message = null } else { status = "blocked"; message = result.message.slice(0, 500) }
    } catch { await ctx.client.query("ROLLBACK TO SAVEPOINT service_order_charge"); message = "Falha temporária ao abrir o título; repita a cobrança" }
  }
  await ctx.client.query("UPDATE service_orders SET charge_status=$3,charge_ref=$4,charge_message=$5 WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, orderId, status, reference, message])
}

export function registerServiceOrders(app: FastifyInstance, deps: AccessDependencies & { services?: ServicePorts }) {
  app.get(base, async (request, reply) => send(reply, await readRoute(request, deps, read, manage, async ctx => {
    const f = parse(listQuery, request.query, "Filtros inválidos")
    const result = await ctx.client.query(`WITH matches AS (SELECT ${projection} WHERE o.tenant_id=$1 AND ($2::text IS NULL OR o.status=$2) AND ($3::uuid IS NULL OR o.technician_id=$3)
        AND ($4='' OR strpos(lower(concat_ws(' ',o.number,o.title,c.legal_name,o.serial_number,p.name)),lower($4))>0)),
      counts AS (SELECT status,count(*)::int AS n FROM matches GROUP BY status),
      page AS (SELECT * FROM matches ORDER BY "updatedAt" DESC,id DESC LIMIT $5 OFFSET $6)
      SELECT (SELECT count(*)::int FROM matches) AS total,coalesce((SELECT jsonb_object_agg(status,n) FROM counts),'{}') AS counts,
      coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "updatedAt" DESC,id DESC) FROM page),'[]') AS data`, [ctx.tenantId, f.status ?? null, f.technicianId ?? null, f.q, f.limit, f.offset])
    return { ...result.rows[0], limit: f.limit, offset: f.offset }
  })))

  app.get(base + "/equipment-history", async (request, reply) => send(reply, await readRoute(request, deps, read, manage, async ctx => {
    const f = parse(equipmentQuery, request.query, "Informe a série do equipamento")
    const rows = await ctx.client.query(`SELECT o.id,o.number,o.title,o.status,o.under_warranty AS "underWarranty",o.completed_at AS "completedAt",s.name AS "technicianName",
        (o.labor_cents+o.parts_cents)::double precision AS "totalCents",'service_order' AS source
      FROM service_orders o LEFT JOIN staff s ON (s.tenant_id,s.id)=(o.tenant_id,o.technician_id)
      WHERE o.tenant_id=$1 AND upper(trim(o.serial_number))=upper(trim($2)) ORDER BY o.created_at DESC,o.id LIMIT 200`, [ctx.tenantId, f.serialNumber])
    const warranty = await ctx.client.query(`SELECT wc.id,wc.protocol AS number,wc.title,wc.status,true AS "underWarranty",wc.updated_at AS "completedAt",NULL AS "technicianName",NULL::bigint AS "totalCents",'warranty_case' AS source
      FROM warranty_cases wc WHERE wc.tenant_id=$1 AND upper(trim(wc.serial_number))=upper(trim($2)) ORDER BY wc.created_at DESC LIMIT 200`, [ctx.tenantId, f.serialNumber])
    return { data: [...rows.rows, ...warranty.rows] }
  })))

  app.get<{ Params: { id: string } }>(base + "/:id", async (request, reply) => send(reply, await readRoute(request, deps, read, manage, async ctx => {
    const orderId = parse(id, request.params.id, "Identificador inválido")
    const data: Record<string, unknown> = await load(ctx, orderId)
    const child = async (sql: string) => (await ctx.client.query(sql, [ctx.tenantId, orderId])).rows
    data.hours = await child(`SELECT id,minutes,rate_cents AS "rateCents",note,created_at AS "createdAt" FROM service_order_hours WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at,id`)
    data.parts = await child(`SELECT id,product_id AS "productId",product_name AS "productName",sku,quantity_micros AS "quantityMicros",unit_cents AS "unitCents",created_at AS "createdAt" FROM service_order_parts WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at,id`)
    data.photos = await child(`SELECT id,filename,media_type AS "mediaType",caption,sha256,created_at AS "createdAt" FROM service_order_photos WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at,id`)
    return { data }
  })))

  app.get<{ Params: { id: string } }>("/api/v1/service-order-photos/:id/file", async (request, reply) => {
    const photo = await authorizeRequest(request, deps, async ctx => {
      requirePermission(ctx, read)
      const row = (await ctx.client.query<{ content: Buffer; media_type: string; filename: string }>("SELECT content,media_type,filename FROM service_order_photos WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, parse(id, request.params.id, "Identificador inválido")])).rows[0]
      return row ?? notFound("Foto não encontrada")
    })
    return reply.header("content-type", photo.media_type).header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(photo.filename)}`).send(photo.content)
  })

  command(app, deps, { path: base, schema: createInput, scope: "service.order.opened", entity: "service_order", read, manage, execute: async (ctx, input) => {
    if (!(await ctx.client.query("SELECT 1 FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer", [ctx.tenantId, input.customerId])).rows[0]) invalid("Selecione um cliente desta empresa")
    if (input.productId && !(await ctx.client.query("SELECT 1 FROM products WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, input.productId])).rows[0]) invalid("Selecione um produto desta empresa")
    if (input.technicianId) await activeTechnician(ctx, input.technicianId)
    let underWarranty = false
    if (input.warrantyCaseId) {
      const warranty = (await ctx.client.query<{ coverage_status: string; customer_id: string | null }>("SELECT coverage_status,customer_id FROM warranty_cases WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, input.warrantyCaseId])).rows[0]
      if (!warranty || warranty.customer_id && warranty.customer_id !== input.customerId) return invalid("A garantia informada não pertence a este cliente")
      underWarranty = warranty.coverage_status === "eligible"
    }
    const sequence = (await ctx.client.query<{ next: string }>("SELECT coalesce(max(substr(number,4)::bigint),0)+1 AS next FROM service_orders WHERE tenant_id=$1", [ctx.tenantId])).rows[0]!.next
    const orderId = randomUUID(), number = "OS-" + String(sequence).padStart(6, "0")
    const status = input.technicianId && input.scheduledAt ? "scheduled" : "open"
    const sla = input.slaHours ?? parameter("services.orders.default_sla_hours")
    await ctx.client.query(`INSERT INTO service_orders(id,tenant_id,number,customer_id,title,description,product_id,serial_number,technician_id,warranty_case_id,under_warranty,status,scheduled_at,sla_due_at,checklist)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,clock_timestamp()+make_interval(hours=>$14),$15)`,
      [orderId, ctx.tenantId, number, input.customerId, input.title, input.description, input.productId ?? null, input.serialNumber ?? null, input.technicianId ?? null, input.warrantyCaseId ?? null, underWarranty, status, input.scheduledAt ?? null, sla, JSON.stringify(input.checklist)])
    return { data: await load(ctx, orderId), aggregateId: orderId }
  } })

  command(app, deps, { path: base + "/:id/schedule", schema: scheduleInput, scope: "service.order.scheduled", entity: "service_order", read, manage, execute: async (ctx, input, orderId, expected) => {
    editable(await lock(ctx, orderId, expected))
    await activeTechnician(ctx, input.technicianId)
    await ctx.client.query("UPDATE service_orders SET technician_id=$3,scheduled_at=$4,status=CASE WHEN status='open' THEN 'scheduled' ELSE status END,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, orderId, input.technicianId, input.scheduledAt])
    return { data: await load(ctx, orderId), aggregateId: orderId }
  } })

  command(app, deps, { path: base + "/:id/start", schema: z.strictObject({}), scope: "service.order.started", entity: "service_order", read, manage, execute: async (ctx, _input, orderId, expected) => {
    const row = await lock(ctx, orderId, expected)
    if (!["open", "scheduled"].includes(row.status)) conflict("A ordem já foi iniciada ou encerrada")
    await touch(ctx, orderId, "status='in_progress',started_at=clock_timestamp(),")
    return { data: await load(ctx, orderId), aggregateId: orderId }
  } })

  command(app, deps, { path: base + "/:id/checklist", schema: checklistInput, scope: "service.order.checklist", entity: "service_order", read, manage, execute: async (ctx, input, orderId, expected) => {
    editable(await lock(ctx, orderId, expected))
    await ctx.client.query("UPDATE service_orders SET checklist=$3,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, orderId, JSON.stringify(input.items)])
    return { data: await load(ctx, orderId), aggregateId: orderId }
  } })

  command(app, deps, { path: base + "/:id/hours", schema: hoursInput, scope: "service.order.hours", entity: "service_order", read, manage, execute: async (ctx, input, orderId, expected) => {
    editable(await lock(ctx, orderId, expected))
    await ctx.client.query("INSERT INTO service_order_hours(id,tenant_id,order_id,minutes,rate_cents,note) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), ctx.tenantId, orderId, input.minutes, input.rateCents, input.note])
    await touch(ctx, orderId, `labor_cents=labor_cents+${Math.round(input.minutes * input.rateCents / 60)},`)
    return { data: await load(ctx, orderId), aggregateId: orderId }
  } })

  command(app, deps, { path: base + "/:id/parts", schema: partInput, scope: "service.order.part_consumed", entity: "service_order", read, manage, execute: async (ctx, input, orderId, expected) => {
    const row = await lock(ctx, orderId, expected)
    editable(row)
    const product = (await ctx.client.query<{ name: string; sku: string | null; tracked: boolean }>(`SELECT p.name,p.sku,EXISTS(SELECT 1 FROM stock_serial_products s WHERE (s.tenant_id,s.product_id)=(p.tenant_id,p.id)) AS tracked
      FROM products p WHERE p.tenant_id=$1 AND p.id=$2 AND p.status='active'`, [ctx.tenantId, input.productId])).rows[0]
    if (!product) invalid("Selecione um produto ativo da empresa")
    const amount = micros(input.quantity)
    const stock = await movement(ctx, input.productId, amount, "Peça aplicada na ordem de serviço " + row.number, null, { tracked: product!.tracked, numbers: input.serialNumbers ?? [] })
    await ctx.client.query("INSERT INTO service_order_parts(id,tenant_id,order_id,product_id,product_name,sku,quantity_micros,unit_cents,stock_movement_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [randomUUID(), ctx.tenantId, orderId, input.productId, product!.name, product!.sku, amount, input.unitCents, stock.id])
    await touch(ctx, orderId, `parts_cents=parts_cents+${(amount * BigInt(input.unitCents) + 500_000n) / 1_000_000n},`)
    return { data: await load(ctx, orderId), aggregateId: orderId }
  } })

  command(app, deps, { path: base + "/:id/photos", schema: photoInput, scope: "service.order.photo_added", entity: "service_order", read, manage, bodyLimit: 8_500_000,
    fingerprint: input => ({ filename: input.filename, mediaType: input.mediaType, caption: input.caption, sha256: createHash("sha256").update(input.base64).digest("hex") }),
    execute: async (ctx, input, orderId, expected) => {
      editable(await lock(ctx, orderId, expected))
      const content = Buffer.from(input.base64, "base64")
      if (content.length > photoLimit || content.length === 0) invalid("Foto vazia ou acima de 6 MB")
      const png = content.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), jpeg = content[0] === 0xff && content[1] === 0xd8, webp = content.subarray(8, 12).toString() === "WEBP"
      if (!(input.mediaType === "image/png" ? png : input.mediaType === "image/jpeg" ? jpeg : webp)) invalid("O conteúdo não corresponde ao tipo de imagem informado")
      await ctx.client.query("INSERT INTO service_order_photos(id,tenant_id,order_id,filename,media_type,content,sha256,caption) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [randomUUID(), ctx.tenantId, orderId, input.filename, input.mediaType, content, createHash("sha256").update(content).digest("hex"), input.caption])
      await touch(ctx, orderId)
      return { data: await load(ctx, orderId), aggregateId: orderId }
    } })

  command(app, deps, { path: base + "/:id/close", schema: closeInput, scope: "service.order.closed", entity: "service_order", read, manage, execute: async (ctx, input, orderId, expected) => {
    const row = await lock(ctx, orderId, expected)
    if (row.status !== "in_progress") conflict("Inicie a ordem de serviço antes de fechá-la")
    if (row.checklist.some(item => item.required && !item.done)) conflict("Conclua os itens obrigatórios do checklist antes de fechar")
    const image = Buffer.from(input.signaturePng, "base64")
    if (!image.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) invalid("A assinatura deve ser uma imagem PNG")
    const signature = { signerName: input.signerName, notes: input.notes, sha256: createHash("sha256").update(image).digest("hex"), png: input.signaturePng, signedAt: new Date().toISOString() }
    await ctx.client.query("UPDATE service_orders SET status='completed',completed_at=clock_timestamp(),signature=$3,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, orderId, JSON.stringify(signature)])
    if (row.under_warranty) await ctx.client.query("UPDATE service_orders SET charge_status='waived',charge_message='Coberto pela garantia' WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, orderId])
    else await charge(ctx, orderId, deps.services)
    return { data: await load(ctx, orderId), aggregateId: orderId }
  } })

  command(app, deps, { path: base + "/:id/charge", schema: z.strictObject({}), scope: "service.order.charged", entity: "service_order", read, manage, execute: async (ctx, _input, orderId, expected) => {
    const row = await lock(ctx, orderId, expected)
    if (row.status !== "completed" || row.under_warranty) conflict("Somente ordem concluída e fora da garantia gera cobrança")
    if (!["pending", "blocked"].includes(row.charge_status)) conflict("A cobrança desta ordem já foi resolvida")
    await charge(ctx, orderId, deps.services)
    await touch(ctx, orderId)
    return { data: await load(ctx, orderId), aggregateId: orderId }
  } })

  command(app, deps, { path: base + "/:id/cancel", schema: cancelInput, scope: "service.order.cancelled", entity: "service_order", read, manage, execute: async (ctx, _input, orderId, expected) => {
    const row = await lock(ctx, orderId, expected)
    editable(row)
    if ((await ctx.client.query("SELECT 1 FROM service_order_parts WHERE tenant_id=$1 AND order_id=$2 LIMIT 1", [ctx.tenantId, orderId])).rows[0]) conflict("A ordem tem peças baixadas do estoque e não pode ser cancelada")
    await touch(ctx, orderId, "status='cancelled',")
    return { data: await load(ctx, orderId), aggregateId: orderId }
  } })
}
