import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { z } from "zod"

import type { AccessDependencies, AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { databaseId } from "../../platform/database-id.js"
import { authorizedDomain, conflict, invalid, notFound, staleRevision } from "../../platform/domain.js"
import { signed64 } from "../../platform/numbers.js"
import { nextRevision, parseRevision, revisionValue, type Revision } from "../../platform/revision.js"
import { CHECKOUT_MANAGE, CHECKOUT_READ, exact, hasControl, parseBody, reply, validId } from "./shared.js"

// Porte de `apps/api/src/domains/logistics_checkout.rs`: conferência do pedido, volumes e conclusão.
export const startInputSchema = z.strictObject({ orderId: databaseId.transform(value => value.toLowerCase()) })
export const checkInputSchema = z.strictObject({ checkedQuantityMicros: signed64 })
export const packageInputSchema = z.strictObject({
  weightGrams: z.number().int().min(1).max(999_999_999),
  lengthMm: z.number().int().min(1).max(99_999),
  widthMm: z.number().int().min(1).max(99_999),
  heightMm: z.number().int().min(1).max(99_999),
  labelCode: z.string().transform(value => value.trim()).refine(value => [...value].length <= 60 && !hasControl(value)).nullish().transform(value => value || null),
})
export const packageStatusSchema = z.strictObject({ status: z.enum(["labelled", "packed"]) })
const completeInputSchema = z.union([z.undefined(), z.null(), z.strictObject({})])
const packageTransitions: Record<string, string> = { prepared: "labelled", labelled: "packed" }

const header = (row: Record<string, unknown>) => ({
  id: row.id, orderId: row.order_id, status: row.status, revision: revisionValue(row.revision), startedAt: row.started_at, completedAt: row.completed_at,
})
const validLine = (raw: string) => /^[0-9]{1,3}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 100

/** Trava a conferência aberta e confere a revisão, na mesma ordem do Rust (situação antes da revisão). */
async function lockOpen(context: AuthorizedContext, id: string, expected: Revision) {
  const row = (await context.client.query<{ order_id: string; status: string; revision: string }>("SELECT order_id,status,revision FROM logistics_checkouts WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [context.tenantId, id])).rows[0]
  if (!row) throw notFound()
  if (row.status !== "counting") throw conflict("Checkout não está aberto")
  if (revisionValue(row.revision) !== expected) throw staleRevision()
  return row
}
async function bump(context: AuthorizedContext, id: string, revision: Revision) {
  await context.client.query("UPDATE logistics_checkouts SET revision=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, revision])
}

export function registerCheckouts(app: FastifyInstance, dependencies: AccessDependencies) {
  app.get("/api/v1/logistics/checkouts", { config: { openapi: { summary: "Listar conferências de pedidos" } } }, async (request, response) => {
    const body = await authorizedDomain(request, dependencies, CHECKOUT_READ, CHECKOUT_MANAGE, false, async (context, canEdit) => {
      const rows = await context.client.query("SELECT id,order_id,status,revision,started_at,completed_at FROM logistics_checkouts WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100", [context.tenantId])
      return { tenantId: context.tenantId, canEdit, data: rows.rows.map(header) }
    })
    return reply(response, 200, body)
  })

  app.get<{ Params: { id: string } }>("/api/v1/logistics/checkouts/:id", { config: { openapi: { summary: "Detalhar conferência com itens e volumes" } } }, async (request, response) => {
    if (!validId(request.params.id)) throw notFound()
    const id = request.params.id
    const body = await authorizedDomain(request, dependencies, CHECKOUT_READ, CHECKOUT_MANAGE, false, async (context, canEdit) => {
      const checkout = (await context.client.query("SELECT id,order_id,status,revision,started_at,completed_at FROM logistics_checkouts WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])).rows[0]
      if (!checkout) throw notFound()
      const lines = await context.client.query("SELECT line_number,product_id,sku,name,expected_quantity_micros,checked_quantity_micros FROM logistics_checkout_lines WHERE tenant_id=$1 AND checkout_id=$2 ORDER BY line_number", [context.tenantId, id])
      const packages = await context.client.query("SELECT id,package_number,weight_grams,length_mm,width_mm,height_mm,label_code,status FROM logistics_checkout_packages WHERE tenant_id=$1 AND checkout_id=$2 ORDER BY package_number", [context.tenantId, id])
      const data = {
        ...header(checkout),
        lines: lines.rows.map(row => ({ lineNumber: row.line_number, productId: row.product_id, sku: row.sku, name: row.name, expectedQuantityMicros: exact(row.expected_quantity_micros), checkedQuantityMicros: exact(row.checked_quantity_micros) })),
        packages: packages.rows.map(row => ({ id: row.id, packageNumber: row.package_number, weightGrams: exact(row.weight_grams), lengthMm: row.length_mm, widthMm: row.width_mm, heightMm: row.height_mm, labelCode: row.label_code, status: row.status })),
      }
      return { tenantId: context.tenantId, canEdit, data }
    })
    return reply(response, 200, body, body.data.revision)
  })

  app.post("/api/v1/logistics/checkouts", { config: { openapi: { summary: "Iniciar conferência de um pedido confirmado (Idempotency-Key)", body: startInputSchema, successStatus: 201 } } }, async (request, response) => {
    const key = commandKey(request.headers["idempotency-key"])
    const result = await authorizedDomain(request, dependencies, CHECKOUT_READ, CHECKOUT_MANAGE, true, async context => {
      const input = parseBody(startInputSchema, request.body, "Entrada inválida")
      const previous = await replay(context, key, "logistics.checkout.start", input)
      if (previous) return { created: false, body: previous }
      const order = (await context.client.query<{ id: string }>("SELECT id FROM sales_orders WHERE tenant_id=$1 AND id=$2 AND status IN ('confirmed','completed') FOR UPDATE", [context.tenantId, input.orderId])).rows[0]
      if (!order) throw notFound()
      const existing = (await context.client.query("SELECT id,status,revision FROM logistics_checkouts WHERE tenant_id=$1 AND order_id=$2", [context.tenantId, order.id])).rows[0]
      if (existing) {
        // Uma conferência por pedido: iniciar de novo devolve a existente (200), como no Rust.
        const body = { tenantId: context.tenantId, data: { id: existing.id, orderId: order.id, status: existing.status, revision: revisionValue(existing.revision) } }
        await remember(context, key, "logistics.checkout.start", input, body)
        return { created: false, body }
      }
      const lines = await context.client.query("SELECT line_number,product_id,sku,name,quantity_micros FROM sales_order_lines WHERE tenant_id=$1 AND order_id=$2 ORDER BY line_number", [context.tenantId, order.id])
      if (!lines.rows.length) throw conflict("Pedido sem itens para conferência")
      const id = randomUUID()
      await context.client.query("INSERT INTO logistics_checkouts(id,tenant_id,order_id) VALUES($1,$2,$3)", [id, context.tenantId, order.id])
      for (const line of lines.rows) {
        await context.client.query("INSERT INTO logistics_checkout_lines(tenant_id,checkout_id,line_number,product_id,sku,name,expected_quantity_micros) VALUES($1,$2,$3,$4,$5,$6,$7)", [context.tenantId, id, line.line_number, line.product_id, line.sku, line.name, line.quantity_micros])
      }
      const body = { tenantId: context.tenantId, data: { id, orderId: order.id, status: "counting", revision: 1 } }
      await record(context, request.headers, "logistics_checkout", id, "logistics.checkout.started", body)
      await remember(context, key, "logistics.checkout.start", input, body)
      return { created: true, body }
    })
    return result.created ? reply(response, 201, result.body, 1) : reply(response, 200, result.body)
  })

  app.post<{ Params: { id: string; line: string } }>("/api/v1/logistics/checkouts/:id/lines/:line/check", { config: { openapi: { summary: "Conferir quantidade de um item (If-Match e Idempotency-Key)", body: checkInputSchema } } }, async (request, response) => {
    const key = commandKey(request.headers["idempotency-key"])
    const expected = parseRevision(request.headers["if-match"])
    const { id, line: rawLine } = request.params
    if (!validId(id) || !validLine(rawLine)) throw notFound()
    const line = Number(rawLine)
    const result = await authorizedDomain(request, dependencies, CHECKOUT_READ, CHECKOUT_MANAGE, true, async context => {
      const input = parseBody(checkInputSchema, request.body, "Quantidade conferida inválida")
      if (BigInt(input.checkedQuantityMicros) < 0n) throw invalid("Quantidade conferida inválida")
      const commandRequest = { id, line, checkedQuantityMicros: input.checkedQuantityMicros, revision: expected }
      const previous = await replay(context, key, "logistics.checkout.check", commandRequest)
      if (previous) return { body: previous, revision: undefined }
      await lockOpen(context, id, expected)
      const current = (await context.client.query<{ expected_quantity_micros: string }>("SELECT expected_quantity_micros FROM logistics_checkout_lines WHERE tenant_id=$1 AND checkout_id=$2 AND line_number=$3", [context.tenantId, id, line])).rows[0]
      if (!current) throw notFound()
      if (BigInt(input.checkedQuantityMicros) > BigInt(current.expected_quantity_micros)) throw invalid("Quantidade conferida maior que a esperada")
      const revision = nextRevision(expected)
      await context.client.query("UPDATE logistics_checkout_lines SET checked_quantity_micros=$4 WHERE tenant_id=$1 AND checkout_id=$2 AND line_number=$3", [context.tenantId, id, line, String(input.checkedQuantityMicros)])
      await bump(context, id, revision)
      const body = { tenantId: context.tenantId, data: { id, lineNumber: line, checkedQuantityMicros: input.checkedQuantityMicros, revision } }
      await record(context, request.headers, "logistics_checkout", id, "logistics.checkout.line_checked", body)
      await remember(context, key, "logistics.checkout.check", commandRequest, body)
      return { body, revision }
    })
    return reply(response, 200, result.body, result.revision)
  })

  app.post<{ Params: { id: string } }>("/api/v1/logistics/checkouts/:id/packages", { config: { openapi: { summary: "Registrar volume da conferência (If-Match e Idempotency-Key)", body: packageInputSchema, successStatus: 201 } } }, async (request, response) => {
    const key = commandKey(request.headers["idempotency-key"])
    const expected = parseRevision(request.headers["if-match"])
    if (!validId(request.params.id)) throw notFound()
    const id = request.params.id
    const result = await authorizedDomain(request, dependencies, CHECKOUT_READ, CHECKOUT_MANAGE, true, async context => {
      const input = parseBody(packageInputSchema, request.body, "Dimensões e peso do volume são obrigatórios")
      const commandRequest = { id, revision: expected, input }
      const previous = await replay(context, key, "logistics.checkout.package", commandRequest)
      if (previous) return { replayed: true, body: previous, revision: undefined }
      await lockOpen(context, id, expected)
      const number = Number((await context.client.query<{ next: string }>("SELECT COALESCE(MAX(package_number),0)+1 AS next FROM logistics_checkout_packages WHERE tenant_id=$1 AND checkout_id=$2", [context.tenantId, id])).rows[0]!.next)
      if (number > 999) throw conflict("Limite de volumes da conferência atingido")
      const packageId = randomUUID()
      await context.client.query("INSERT INTO logistics_checkout_packages(id,tenant_id,checkout_id,package_number,weight_grams,length_mm,width_mm,height_mm,label_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [packageId, context.tenantId, id, number, input.weightGrams, input.lengthMm, input.widthMm, input.heightMm, input.labelCode])
      const revision = nextRevision(expected)
      await bump(context, id, revision)
      const body = { tenantId: context.tenantId, data: { id: packageId, checkoutId: id, packageNumber: number, ...input, status: "prepared", revision } }
      await record(context, request.headers, "logistics_checkout", id, "logistics.checkout.package_added", body)
      await remember(context, key, "logistics.checkout.package", commandRequest, body)
      return { replayed: false, body, revision }
    })
    return result.replayed ? reply(response, 200, result.body) : reply(response, 201, result.body, result.revision)
  })

  app.post<{ Params: { id: string; package_id: string } }>("/api/v1/logistics/checkouts/:id/packages/:package_id/status", { config: { openapi: { summary: "Avançar volume: etiquetado → embalado (If-Match e Idempotency-Key)", body: packageStatusSchema } } }, async (request, response) => {
    const key = commandKey(request.headers["idempotency-key"])
    const expected = parseRevision(request.headers["if-match"])
    const { id, package_id: packageId } = request.params
    if (!validId(id) || !validId(packageId)) throw notFound()
    const result = await authorizedDomain(request, dependencies, CHECKOUT_READ, CHECKOUT_MANAGE, true, async context => {
      const { status } = parseBody(packageStatusSchema, request.body, "Status de volume inválido")
      const commandRequest = { id, packageId, status, revision: expected }
      const previous = await replay(context, key, "logistics.checkout.package.status", commandRequest)
      if (previous) return { body: previous, revision: undefined }
      await lockOpen(context, id, expected)
      const current = (await context.client.query<{ package_number: number; status: string }>("SELECT package_number,status FROM logistics_checkout_packages WHERE tenant_id=$1 AND checkout_id=$2 AND id=$3 FOR UPDATE", [context.tenantId, id, packageId])).rows[0]
      if (!current) throw notFound()
      if (packageTransitions[current.status] !== status) throw conflict("Transição de volume inválida")
      await context.client.query("UPDATE logistics_checkout_packages SET status=$4 WHERE tenant_id=$1 AND checkout_id=$2 AND id=$3", [context.tenantId, id, packageId, status])
      const revision = nextRevision(expected)
      await bump(context, id, revision)
      const body = { tenantId: context.tenantId, data: { id: packageId, checkoutId: id, packageNumber: current.package_number, status, revision } }
      await record(context, request.headers, "logistics_checkout", packageId, "logistics.checkout.package_status_changed", body)
      await remember(context, key, "logistics.checkout.package.status", commandRequest, body)
      return { body, revision }
    })
    return reply(response, 200, result.body, result.revision)
  })

  app.post<{ Params: { id: string } }>("/api/v1/logistics/checkouts/:id/complete", { config: { openapi: { summary: "Concluir conferência com todos os itens conferidos (If-Match e Idempotency-Key)" } } }, async (request, response) => {
    const key = commandKey(request.headers["idempotency-key"])
    const expected = parseRevision(request.headers["if-match"])
    if (!validId(request.params.id)) throw notFound()
    const id = request.params.id
    const result = await authorizedDomain(request, dependencies, CHECKOUT_READ, CHECKOUT_MANAGE, true, async context => {
      parseBody(completeInputSchema, request.body, "Entrada inválida")
      const commandRequest = { id, revision: expected }
      const previous = await replay(context, key, "logistics.checkout.complete", commandRequest)
      if (previous) return { body: previous, revision: undefined }
      const checkout = await lockOpen(context, id, expected)
      const pending = (await context.client.query<{ pending: string }>("SELECT count(*)::text AS pending FROM logistics_checkout_lines WHERE tenant_id=$1 AND checkout_id=$2 AND checked_quantity_micros<>expected_quantity_micros", [context.tenantId, id])).rows[0]!.pending
      if (pending !== "0") throw conflict("Ainda existem itens não conferidos")
      const revision = nextRevision(expected)
      await context.client.query("UPDATE logistics_checkouts SET status='completed',revision=$3,completed_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, revision])
      const body = { tenantId: context.tenantId, data: { id, orderId: checkout.order_id, status: "completed", revision } }
      await record(context, request.headers, "logistics_checkout", id, "logistics.checkout.completed", body)
      await remember(context, key, "logistics.checkout.complete", commandRequest, body)
      return { body, revision }
    })
    return reply(response, 200, result.body, result.revision)
  })
}
