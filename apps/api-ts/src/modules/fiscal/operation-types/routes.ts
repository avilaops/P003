import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../../platform/access.js"
import { commandKey, record, remember, replay } from "../../../platform/commands.js"
import { Problem } from "../../../platform/problem.js"
import { nextRevision, parseRevision } from "../../../platform/revision.js"
import { fromRow, loadOperationType, operationPurposes, operationTypeColumns, operationTypeInput, taxScope, type OperationTypeInput } from "./model.js"

const base = "/api/v1/fiscal/operation-types"
const invalid = (message: string) => { throw new Problem(422, "invalid_input", message) }
const guid = (value: string) => { const parsed = z.guid().safeParse(value); if (!parsed.success) invalid("Identificador inválido"); return parsed.data!.toLowerCase() }
const parse = (body: unknown) => {
  const parsed = operationTypeInput.safeParse(body)
  if (!parsed.success) invalid(parsed.error.issues.find(i => i.code === "custom")?.message ?? "Confira o código, os CFOPs, os CSTs e os efeitos do tipo de operação")
  return parsed.data!
}
const listQuery = z.strictObject({ direction: z.enum(["incoming", "outgoing"]).optional(), purpose: z.enum(operationPurposes).optional(), active: z.enum(["true", "false"]).optional() })

function values(c: AuthorizedContext, id: string, v: OperationTypeInput) {
  return [c.tenantId, id, v.code, v.name, v.direction, v.purpose, v.nfePurpose, v.cfopInternal, v.cfopInterstate, v.cfopForeign, v.icmsCst, v.icmsCsosn, v.ipiCst,
    v.pisCst, v.cofinsCst, v.ibsCbsCst, v.ibsCbsClass, v.movesStock, v.generatesFinance, v.generatesCommission, v.requiresOrigin, v.financialCategoryId, v.isDefault, v.active]
}
async function checkCategory(c: AuthorizedContext, v: OperationTypeInput) {
  if (!v.financialCategoryId) return
  const direction = v.direction === "outgoing" ? "income" : "expense"
  const found = await c.client.query("SELECT 1 FROM financial_categories WHERE tenant_id=$1 AND id=$2 AND status='active' AND direction=$3", [c.tenantId, v.financialCategoryId, direction])
  if (!found.rows.length) invalid("A natureza financeira padrão precisa estar ativa e no mesmo sentido do tipo de operação")
}
// Um único padrão por finalidade: o novo padrão substitui o anterior na mesma transação.
async function releaseDefault(c: AuthorizedContext, id: string, v: OperationTypeInput) {
  if (v.isDefault && v.active) await c.client.query("UPDATE fiscal_operation_types SET is_default=false,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND direction=$2 AND purpose=$3 AND is_default AND id<>$4", [c.tenantId, v.direction, v.purpose, id])
}
const read = (c: AuthorizedContext) => requirePermission(c, "fiscal.operation_types.read")
const manage = (c: AuthorizedContext) => { read(c); requirePermission(c, "fiscal.operation_types.manage") }

export function registerOperationTypes(app: FastifyInstance, deps: AppDependencies) {
  app.get(base, async (request, reply) => authorizeRequest(request, deps, async c => {
    read(c)
    const query = listQuery.safeParse(request.query)
    if (!query.success) return invalid("Confira o sentido, a finalidade e a situação")
    const { direction, purpose, active } = query.data
    const scope = await taxScope(c)
    const rows = (await c.client.query(`SELECT ${operationTypeColumns} FROM fiscal_operation_types WHERE tenant_id=$1 AND ($2::text IS NULL OR direction=$2)
      AND ($3::text IS NULL OR purpose=$3) AND ($4::boolean IS NULL OR active=$4) ORDER BY code`, [c.tenantId, direction ?? null, purpose ?? null, active === undefined ? null : active === "true"])).rows
    return reply.header("cache-control", "no-store").send({ tenantId: c.tenantId, canEdit: c.permissions.includes("fiscal.operation_types.manage"), data: rows.map(row => fromRow(row, scope)) })
  }))
  // Sugestão por finalidade do documento: devolve o padrão ativo, ou nada. Nunca cria uma regra.
  app.get(base + "/suggestion", async (request, reply) => authorizeRequest(request, deps, async c => {
    read(c)
    const query = z.strictObject({ direction: z.enum(["incoming", "outgoing"]), purpose: z.enum(operationPurposes) }).safeParse(request.query)
    if (!query.success) return invalid("Informe o sentido e a finalidade do documento")
    const row = (await c.client.query(`SELECT ${operationTypeColumns} FROM fiscal_operation_types WHERE tenant_id=$1 AND direction=$2 AND purpose=$3 AND is_default AND active`, [c.tenantId, query.data.direction, query.data.purpose])).rows[0]
    return reply.header("cache-control", "no-store").send({ tenantId: c.tenantId, data: row ? fromRow(row, await taxScope(c)) : null })
  }))
  app.get<{ Params: { id: string } }>(base + "/:id", async (request, reply) => authorizeRequest(request, deps, async c => {
    read(c)
    const type = await loadOperationType(c, guid(request.params.id))
    return reply.header("cache-control", "no-store").header("etag", `"${type.revision}"`).send({ tenantId: c.tenantId, data: type })
  }))
  app.post(base, async (request, reply) => {
    const key = commandKey(request.headers["idempotency-key"]), input = parse(request.body)
    const saved = await authorizeRequest(request, deps, async c => {
      manage(c)
      const previous = await replay(c, key, "fiscal.operation_type.create", input)
      if (previous) return previous
      await checkCategory(c, input)
      const id = randomUUID()
      await releaseDefault(c, id, input)
      await c.client.query(`INSERT INTO fiscal_operation_types(tenant_id,id,code,name,direction,purpose,nfe_purpose,cfop_internal,cfop_interstate,cfop_foreign,icms_cst,icms_csosn,ipi_cst,
        pis_cst,cofins_cst,ibs_cbs_cst,ibs_cbs_class,moves_stock,generates_finance,generates_commission,requires_origin,financial_category_id,is_default,active)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`, values(c, id, input))
      await record(c, request.headers, "fiscal_operation_type", id, "fiscal.operation_type.created", { code: input.code, revision: 1 })
      const result = { tenantId: c.tenantId, data: await loadOperationType(c, id) }
      await remember(c, key, "fiscal.operation_type.create", input, result)
      return result
    })
    return reply.code(201).header("cache-control", "no-store").header("etag", `"${(saved.data as { revision: number }).revision}"`).send(saved)
  })
  app.put<{ Params: { id: string } }>(base + "/:id", async (request, reply) => {
    const id = guid(request.params.id), expected = parseRevision(request.headers["if-match"]), input = parse(request.body)
    const saved = await authorizeRequest(request, deps, async c => {
      manage(c)
      const current = (await c.client.query("SELECT revision,direction FROM fiscal_operation_types WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [c.tenantId, id])).rows[0]
      if (!current) throw new Problem(404, "not_found", "Tipo de operação não encontrado")
      if (String(current.revision) !== String(expected)) throw new Problem(412, "revision_conflict", "O tipo de operação foi alterado por outra pessoa")
      if (current.direction !== input.direction) throw new Problem(409, "domain_conflict", "O sentido de um tipo de operação não pode ser alterado; cadastre outro tipo")
      await checkCategory(c, input)
      await releaseDefault(c, id, input)
      const revision = nextRevision(expected)
      await c.client.query(`UPDATE fiscal_operation_types SET code=$3,name=$4,direction=$5,purpose=$6,nfe_purpose=$7,cfop_internal=$8,cfop_interstate=$9,cfop_foreign=$10,icms_cst=$11,
        icms_csosn=$12,ipi_cst=$13,pis_cst=$14,cofins_cst=$15,ibs_cbs_cst=$16,ibs_cbs_class=$17,moves_stock=$18,generates_finance=$19,generates_commission=$20,requires_origin=$21,
        financial_category_id=$22,is_default=$23,active=$24,revision=$25,updated_at=now() WHERE tenant_id=$1 AND id=$2`, [...values(c, id, input), revision])
      await record(c, request.headers, "fiscal_operation_type", id, "fiscal.operation_type.updated", { code: input.code, previousRevision: expected, revision })
      return { tenantId: c.tenantId, data: await loadOperationType(c, id) }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${saved.data.revision}"`).send(saved)
  })
  // Seletor no pedido: só em rascunho, porque confirmar o pedido já decide reserva e títulos pelo tipo escolhido.
  app.put<{ Params: { id: string } }>("/api/v1/orders/:id/operation-type", async (request, reply) => {
    const id = guid(request.params.id), expected = parseRevision(request.headers["if-match"])
    const body = z.strictObject({ operationTypeId: z.guid().nullable() }).safeParse(request.body)
    if (!body.success) return invalid("Informe o tipo de operação ou null para venda padrão")
    const saved = await authorizeRequest(request, deps, async c => {
      requirePermission(c, "sales.orders.read"); requirePermission(c, "sales.orders.manage"); requirePermission(c, "fiscal.operation_types.override")
      const order = (await c.client.query("SELECT status,revision FROM sales_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [c.tenantId, id])).rows[0]
      if (!order) throw new Problem(404, "not_found", "Pedido não encontrado")
      if (String(order.revision) !== String(expected)) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o pedido")
      if (order.status !== "draft") throw new Problem(409, "domain_conflict", "O tipo de operação só pode ser alterado em pedidos em rascunho")
      const typeId = body.data.operationTypeId?.toLowerCase() ?? null
      if (typeId) {
        const type = await loadOperationType(c, typeId)
        if (type.direction !== "outgoing" || !type.active) throw new Problem(409, "domain_conflict", "O pedido de venda exige um tipo de operação de saída ativo")
      }
      const revision = nextRevision(expected)
      await c.client.query("UPDATE sales_orders SET operation_type_id=$3,revision=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2", [c.tenantId, id, typeId, revision])
      await record(c, request.headers, "sales_order", id, "order.operation_type.changed", { operationTypeId: typeId, previousRevision: expected, revision })
      return { tenantId: c.tenantId, orderId: id, revision, operationTypeId: typeId }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${saved.revision}"`).send(saved)
  })
}
