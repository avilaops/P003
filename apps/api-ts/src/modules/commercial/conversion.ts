import { checkPriceCustomer } from "./price-origin.js"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { commandKey, replay, remember, record } from "../../platform/commands.js"
import { signed64 } from "../../platform/numbers.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, revisionValue, type Revision } from "../../platform/revision.js"
import { checkoutInputSchema, saveCheckout } from "../orders/checkout-save.js"
import { storeLines } from "../orders/prepare.js"
import { decimal, validateDate } from "../sales/fixed.js"
import { quoteLines, storeQuote } from "./quote-document.js"
import { customerSnapshotSql, validateFiscalCustomer } from "../sales/customer-fiscal.js"
import { negotiationInputSchema, type NegotiationInput } from "./negotiation-model.js"
import { prepareNegotiation } from "./prepare.js"
import { mixedInputSchema, type MixedInput } from "./mixed-model.js"
import { prepareMixed } from "./mixed-prepare.js"

const uuid = z.guid().transform(value => value.toLowerCase())
export const conversionInputSchema = z.strictObject({ simulation: negotiationInputSchema, digest: z.string(), customerId: uuid, dueDate: z.string(), opportunityId: uuid.nullable().default(null), opportunityRevision: signed64.nullable().default(null), checkout: checkoutInputSchema.nullable().default(null) })
const mixedConversionSchema = conversionInputSchema.extend({ simulation: mixedInputSchema }).strict()
async function linkOpportunity(context: AuthorizedContext, id: string, expected: Revision, customer: string, order: string) {
  const current = (await context.client.query("SELECT revision,customer_id,order_id,proposal_id,data->>'stage' AS stage FROM sales_opportunities WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])).rows[0]
  if (!current) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
  if (revisionValue(current.revision) !== expected) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
  if (current.order_id !== null || current.proposal_id || current.stage === "lost" || current.customer_id !== null && current.customer_id !== customer) throw new Problem(409, "domain_conflict", "Oportunidade já vinculada ou com cliente diferente")
  await context.client.query("UPDATE sales_opportunities SET customer_id=$3,order_id=$4,data=jsonb_set(data,'{stage}','\"won\"'),revision=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2", [context.tenantId, id, customer, order, nextRevision(expected)])
}

export function registerCommercialConversion(app: FastifyInstance, dependencies: AppDependencies) {
  for (const mixed of [false, true]) app.post(mixed ? "/api/v1/commercial/mixed/orders" : "/api/v1/commercial/orders", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "sales.orders.read"); requirePermission(context, "sales.orders.manage")
      const key = commandKey(request.headers["idempotency-key"]), parsed = (mixed ? mixedConversionSchema : conversionInputSchema).safeParse(request.body)
      if (!parsed.success) throw new Problem(422, "invalid_input", "Conversão inválida ou campos desconhecidos")
      const input = parsed.data
      const command = { simulation: input.simulation, digest: input.digest, customerId: input.customerId, dueDate: input.dueDate, opportunityId: input.opportunityId, opportunityRevision: input.opportunityRevision, ...(input.checkout === null ? {} : { checkout: input.checkout }) }
      if ((input.opportunityId === null) !== (input.opportunityRevision === null)) throw new Problem(422, "invalid_input", "Oportunidade exige sua revisão atual")
      const scope = mixed ? "mixed_negotiation.convert" : "negotiation.convert"
      const repeated = await replay(context, key, scope, command)
      if (repeated) return repeated
      await checkPriceCustomer(context,input.simulation,input.customerId)
      const prepared = mixed ? await prepareMixed(context, input.simulation as MixedInput) : await prepareNegotiation(context, input.simulation as NegotiationInput)
      if (prepared.digest !== input.digest) throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
      const due = validateDate(input.dueDate), { client, tenantId } = context
      const customer = (await client.query("SELECT legal_name,tax_id FROM parties WHERE tenant_id=$1 AND id=$2 AND is_customer AND status='active'", [tenantId, input.customerId])).rows[0]
      if (!customer) throw new Problem(409, "domain_conflict", "Selecione um cliente ativo desta empresa")
      const fiscalCustomer = (await client.query<{ data: Record<string, unknown> }>(customerSnapshotSql, [tenantId, input.customerId])).rows[0]?.data
      if (!fiscalCustomer) throw new Problem(409, "domain_conflict", "Selecione um cliente ativo desta empresa")
      validateFiscalCustomer(fiscalCustomer, input.simulation)
      const lines = await quoteLines(context,prepared)
      const order = randomUUID()
      await client.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,$4,$5,$6,$7,'draft')", [order, tenantId, input.customerId, customer.legal_name, customer.tax_id, due, prepared.sale.totalCents])
      await storeLines(context, order, lines)
      if (input.opportunityId !== null && input.opportunityRevision !== null) {
        await linkOpportunity(context, input.opportunityId, input.opportunityRevision, input.customerId, order)
        await record(context, request.headers, "sales_opportunity", input.opportunityId, "opportunity.order_linked", { orderId: order, stage:"won", revision: nextRevision(input.opportunityRevision) })
      }
      const {status,priceVersion} = await storeQuote(context,order,input.simulation,prepared)
      if (input.checkout !== null) await saveCheckout(context, order, input.customerId, BigInt(prepared.sale.totalCents), BigInt(prepared.sale.downPaymentCents), input.checkout)
      await record(context, request.headers, "sales_order", order, "order.created", { revision: 1, ...(prepared.kind === "single" ? { priceVersionId: priceVersion } : { priceVersions: prepared.policies.map(policy => policy.versionId) }), approvalStatus: status, amount: decimal(BigInt(prepared.sale.totalCents), 2) })
      const result = { tenantId, id: order, revision: 1, approvalStatus: status }
      await remember(context, key, scope, command, result)
      return result
    })
    return reply.code(201).header("cache-control", "no-store").header("etag", '"1"').send(body)
  })
}
