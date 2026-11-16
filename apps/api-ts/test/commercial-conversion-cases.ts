import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"
import type { NegotiationInput } from "../src/modules/commercial/negotiation-model.js"

export async function verifyCommercialConversion(app: FastifyInstance, seed: Pool, tenant: string, input: NegotiationInput, digest: string, role: string) {
  const headers = { authorization: "Bearer operator", "x-tenant-id": tenant }, key = randomUUID(), opportunity = randomUUID()
  const method = (await seed.query("SELECT id FROM payment_methods WHERE tenant_id=$1 AND status='active' ORDER BY id LIMIT 1", [tenant])).rows[0].id
  await seed.query("INSERT INTO sales_opportunities(id,tenant_id,data,created_by) SELECT $1,$2,'{\"title\":\"Negociação\",\"stage\":\"negotiation\"}',id FROM identities WHERE auth_subject='operator'", [opportunity, tenant])
  const checkout = { entry: { paymentMethodId: method, dueOn: null }, installments: [{ paymentMethodId: method, dueOn: "2027-01-01", amountCents: 425893 }], manufacturingDays: 45, deliveryNotes: "  Entrega combinada  ", paymentNotes: "Entrada e saldo", notes: "", stateRegistration: " ISENTO " }
  const payload = { simulation: input, digest, customerId: tenant, dueDate: "2027-01-01", opportunityId: opportunity, opportunityRevision: 1, checkout }
  const counts = async () => (await seed.query("SELECT (SELECT count(*)::int FROM sales_orders WHERE tenant_id=$1) AS orders,(SELECT count(*)::int FROM commercial_order_quotes WHERE tenant_id=$1) AS quotes,(SELECT count(*)::int FROM sales_order_checkouts WHERE tenant_id=$1) AS checkouts", [tenant])).rows[0]
  const before = await counts()
  const convert = (value: unknown = payload, command = key, authorization = headers.authorization) => app.inject({ method: "POST", url: "/api/v1/commercial/orders", headers: { ...headers, authorization, "idempotency-key": command }, payload: value as object })
  assert.equal((await convert(payload, randomUUID(), "Bearer commercial-manager")).statusCode, 403)
  const missingRevision = await convert({ ...payload, opportunityRevision: null }, randomUUID())
  assert.equal(missingRevision.statusCode, 422, missingRevision.body)
  assert.equal((await convert({ ...payload, digest: "outdated" }, randomUUID())).statusCode, 412)
  assert.equal((await convert({ ...payload, opportunityRevision: 0 }, randomUUID())).statusCode, 412)
  assert.equal((await convert({ ...payload, checkout: { ...checkout, entry: {} } }, randomUUID())).statusCode, 422)
  const mismatched = await convert({ ...payload, checkout: { ...checkout, installments: [{ ...checkout.installments[0], amountCents: 1 }] } }, randomUUID())
  assert.equal(mismatched.statusCode, 422, mismatched.body)
  assert.equal((await seed.query("SELECT order_id FROM sales_opportunities WHERE id=$1", [opportunity])).rows[0].order_id, null)
  await seed.query(`REVOKE INSERT ON sales_order_checkouts FROM ${role}`)
  const failed = await convert()
  assert.equal(failed.statusCode, 500, failed.body)
  assert.equal((await seed.query("SELECT order_id FROM sales_opportunities WHERE id=$1", [opportunity])).rows[0].order_id, null)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM domain_commands WHERE command_key=$1", [key])).rows[0].count, 0)
  assert.deepEqual(await counts(), before, "Failed conversions must preserve no order, quote or checkout")
  await seed.query(`GRANT INSERT ON sales_order_checkouts TO ${role}`)
  const conversions = await Promise.all([convert(), convert()])
  for (const response of conversions) assert.equal(response.statusCode, 201, response.body)
  assert.deepEqual(conversions[0]!.json(), conversions[1]!.json())
  const order = conversions[0]!.json().id as string
  assert.equal(conversions[0]!.headers.etag, '"1"')
  const detail = await app.inject({ method: "GET", url: `/api/v1/orders/${order}`, headers })
  assert.equal(detail.statusCode, 200, detail.body)
  assert.equal(detail.json().data.amount, "14196.45")
  assert.equal(detail.json().items[0].unitPrice, "14196.45")
  assert.equal(detail.json().checkout.entry.amountCents, 993752)
  assert.equal(detail.json().checkout.installments[0].amountCents, 425893)
  assert.equal(detail.json().checkout.manufacturingDays, 45)
  assert.equal(detail.json().checkout.deliveryNotes, "Entrega combinada")
  assert.equal(detail.json().checkout.stateRegistration, "ISENTO")
  const linked = (await seed.query("SELECT order_id,revision FROM sales_opportunities WHERE id=$1", [opportunity])).rows[0]
  assert.equal(linked.order_id, order)
  assert.equal(linked.revision, "2")
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM receivables WHERE tenant_id=$1 AND order_id=$2", [tenant, order])).rows[0].count, 0, "Saving the checkout does not claim receipt or originate titles")
  const accepted = await app.inject({ method: "POST", url: `/api/v1/orders/${order}/accept`, headers: { ...headers, "if-match": '"1"', "idempotency-key": randomUUID() } })
  assert.equal(accepted.statusCode, 200, accepted.body)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM receivables WHERE tenant_id=$1 AND order_id=$2", [tenant, order])).rows[0].count, 2)
  const repeated = await convert()
  assert.equal(repeated.statusCode, 201, repeated.body)
  assert.deepEqual(repeated.json(), conversions[0]!.json())
  assert.equal((await convert({ ...payload, checkout: { ...checkout, notes: "Outro acordo" } })).statusCode, 409)
  const stored = (await seed.query("SELECT request FROM domain_commands WHERE command_key=$1", [key])).rows[0].request
  assert.equal(stored.checkout.stateRegistration, " ISENTO ")
  // Explicit zero entry is a commercial exception, kept pending until a decision.
  const zeroInput = { ...input, downPaymentCents: 0 }
  const zeroSimulation = await app.inject({ method: "POST", url: "/api/v1/commercial/simulate", headers, payload: zeroInput })
  assert.equal(zeroSimulation.statusCode, 200, zeroSimulation.body)
  const zeroCheckout = { entry: {}, installments: [{ paymentMethodId: method, dueOn: "2027-01-01", amountCents: 1419645 }], deliveryNotes: "", paymentNotes: "", notes: "" }
  const zero = await convert({ simulation: zeroInput, digest: zeroSimulation.json().digest, customerId: tenant, dueDate: "2027-01-01", checkout: zeroCheckout }, randomUUID())
  assert.equal(zero.statusCode, 201, zero.body)
  assert.equal(zero.json().approvalStatus, "pending")
  const zeroOrder = zero.json().id as string
  const acceptZero = (revision: number) => app.inject({ method: "POST", url: `/api/v1/orders/${zeroOrder}/accept`, headers: { ...headers, "if-match": `"${revision}"`, "idempotency-key": randomUUID() } })
  assert.equal((await acceptZero(1)).statusCode, 409)
  const approved = await app.inject({ method: "POST", url: `/api/v1/commercial/orders/${zeroOrder}/decision`, headers: { ...headers, "if-match": '"1"', "idempotency-key": randomUUID() }, payload: { approved: true, reason: "Entrada zero aprovada explicitamente" } })
  assert.equal(approved.statusCode, 200, approved.body)
  assert.equal((await acceptZero(2)).statusCode, 200)
  assert.equal((await seed.query("SELECT count(*)::int AS count FROM receivables WHERE tenant_id=$1 AND order_id=$2", [tenant, zeroOrder])).rows[0].count, 1)
}
