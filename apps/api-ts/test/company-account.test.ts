import assert from "node:assert/strict"
import test from "node:test"

import { platformContext } from "./platform-context.js"
import { FakeMercadoPago, companyPermissions, planPrice } from "./company-account-support.js"

const enabled = { skip: !process.env.API_TS_TEST_ADMIN_URL }
const problem = (response: { json(): unknown }) => response.json() as { type: string; status: number; title: string }

async function setup(payments: FakeMercadoPago | null = new FakeMercadoPago()) {
  const fixture = await platformContext({ adminPermissions: companyPermissions, readerPermissions: ["platform.company.read"], dependencies: { companyAccount: { payments, assistant: null, contractWebhook: null } } })
  return { ...fixture, payments }
}
const checkout = (f: Awaited<ReturnType<typeof setup>>, extra: Partial<Parameters<typeof f.call>[0]> = {}) =>
  f.call({ method: "POST", url: "/api/v1/company-account/checkout", body: { planId: "cobalto", payerEmail: "pagador@example.test" }, ...extra })

test("company-account: GET lista planos, assinaturas e uso; exige login e permissão", enabled, async () => {
  const f = await setup()
  try {
    const admin = await f.call({ method: "GET", url: "/api/v1/company-account" })
    assert.equal(admin.statusCode, 200)
    assert.equal(admin.headers["cache-control"], "no-store")
    const body = admin.json()
    assert.equal(body.tenantId, f.tenant)
    assert.equal(body.canEdit, true)
    assert.equal(body.providerConfigured, true)
    assert.equal(body.plans.length, 6)
    assert.equal(body.activeUsers, 2) // persona `user` e `denied` na empresa A
    assert.equal(body.productPhotoBytes, 0)
    assert.deepEqual(body.subscriptions, [])
    const reader = await f.call({ method: "GET", url: "/api/v1/company-account", token: "reader" })
    assert.equal(reader.statusCode, 200)
    assert.equal(reader.json().canEdit, false)
    assert.equal((await f.call({ method: "GET", url: "/api/v1/company-account", token: null })).statusCode, 401)
    assert.equal((await f.call({ method: "GET", url: "/api/v1/company-account", token: "visitor" })).statusCode, 403)
    assert.equal((await f.call({ method: "GET", url: "/api/v1/company-account", tenant: null })).statusCode, 400)
  } finally { await f.close() }
})

test("company-account: sem Mercado Pago configurado informa provedor desligado e bloqueia cobrança", enabled, async () => {
  const f = await setup(null)
  try {
    assert.equal((await f.call({ method: "GET", url: "/api/v1/company-account" })).json().providerConfigured, false)
    const response = await checkout(f)
    assert.equal(response.statusCode, 409)
    assert.match(problem(response).title, /Mercado Pago ainda não está configurado/)
  } finally { await f.close() }
})

test("company-account: checkout reserva, cria no provedor uma única vez e confirma", enabled, async () => {
  const f = await setup()
  try {
    const created = await checkout(f)
    assert.equal(created.statusCode, 200)
    const subscription = created.json()
    assert.equal(subscription.planId, "cobalto")
    assert.equal(subscription.status, "pending")
    assert.equal(subscription.providerId, undefined, "o id do provedor não sai pela API")
    assert.match(subscription.details.checkoutUrl, /^https:\/\/www\.mercadopago\.com\.br\/subscriptions\/checkout\?/)
    const audit = await f.seed.query("SELECT action FROM audit_log WHERE tenant_id=$1 AND entity_type='subscription'", [f.tenant])
    assert.deepEqual(audit.rows, [{ action: "subscription.checkout_requested" }])
    // Repetir a mesma intenção não cobra de novo: 409 e nenhuma segunda criação.
    const repeated = await checkout(f)
    assert.equal(repeated.statusCode, 409)
    assert.equal(f.payments!.calls.filter(call => call === "create").length, 1)
    assert.equal((await f.call({ method: "GET", url: "/api/v1/company-account" })).json().subscriptions.length, 1)
  } finally { await f.close() }
})

test("company-account: checkout valida entrada (422), login (401) e permissão (403)", enabled, async () => {
  const f = await setup()
  try {
    assert.equal((await checkout(f, { token: null })).statusCode, 401)
    assert.equal((await checkout(f, { token: "reader" })).statusCode, 403)
    assert.equal((await checkout(f, { token: "visitor" })).statusCode, 403)
    for (const body of [
      { planId: "elite", payerEmail: "a@b.co" }, { planId: "inexistente", payerEmail: "a@b.co" },
      { planId: "cobalto", payerEmail: "sem-arroba" }, { planId: "cobalto", payerEmail: "a b@c.co" }, { planId: "cobalto", payerEmail: "a@semponto" },
      { planId: "cobalto", payerEmail: "a@b@c.co" }, { planId: "cobalto", payerEmail: "a@b.co", tenantId: f.otherTenant }, { planId: "cobalto" },
    ]) assert.equal((await checkout(f, { body })).statusCode, 422, JSON.stringify(body))
    assert.equal((await f.call({ method: "POST", url: "/api/v1/company-account/checkout", body: [] })).statusCode, 422)
    assert.equal(f.payments!.calls.length, 0, "entrada inválida nunca chega ao provedor")
    const none = await f.seed.query("SELECT count(*)::int AS n FROM company_subscriptions")
    assert.equal(none.rows[0].n, 0)
  } finally { await f.close() }
})

test("company-account: recusa de criação libera nova tentativa; resposta adulterada fica reservada", enabled, async () => {
  const f = await setup()
  try {
    f.payments!.refuseCreation = true
    const refused = await checkout(f)
    assert.equal(refused.statusCode, 422)
    const rows = await f.seed.query("SELECT status,provider_id FROM company_subscriptions")
    assert.deepEqual(rows.rows, [{ status: "rejected", provider_id: null }])
    f.payments!.refuseCreation = false
    assert.equal((await checkout(f)).statusCode, 200)
    // Preço divergente do catálogo é tratado como falha do provedor (409), sem gravar o preço do provedor.
    const g = await setup()
    try {
      const original = g.payments!.create.bind(g.payments)
      g.payments!.create = async (reference, plan, email) => { const item = await original(reference, plan, email); item.auto_recurring.transaction_amount = 1; return item }
      const tampered = await checkout(g)
      assert.equal(tampered.statusCode, 409)
      assert.equal((await g.seed.query("SELECT status FROM company_subscriptions")).rows[0].status, "creating")
      assert.equal((await checkout(g)).statusCode, 409, "a reserva impede cobrança duplicada")
    } finally { await g.close() }
  } finally { await f.close() }
})

test("company-account: refresh confirma, localiza reserva sem provider_id e rejeita ambiguidade", enabled, async () => {
  const f = await setup()
  try {
    const created = (await checkout(f)).json()
    f.payments!.authorize("mp-1")
    const refresh = (subscriptionId: string, extra: Partial<Parameters<typeof f.call>[0]> = {}) => f.call({ method: "POST", url: "/api/v1/company-account/refresh", body: { subscriptionId }, ...extra })
    const ok = await refresh(created.id)
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.json().status, "authorized")
    assert.equal((await refresh(created.id, { token: null })).statusCode, 401)
    assert.equal((await refresh(created.id, { token: "reader" })).statusCode, 403)
    assert.equal((await f.call({ method: "POST", url: "/api/v1/company-account/refresh", body: { subscriptionId: "nao-uuid" } })).statusCode, 422)
    assert.equal((await f.call({ method: "POST", url: "/api/v1/company-account/refresh", body: { subscriptionId: created.id, extra: 1 } })).statusCode, 422)
    assert.equal((await refresh("99999999-9999-4999-8999-999999999999")).statusCode, 404)
    // Isolamento: a administradora da empresa B não enxerga nem atualiza a assinatura da empresa A.
    assert.equal((await refresh(created.id, { token: "other", tenant: f.otherTenant })).statusCode, 404)
    assert.equal((await refresh(created.id, { token: "other" })).statusCode, 403)
    const foreign = await f.call({ method: "GET", url: "/api/v1/company-account", token: "other", tenant: f.otherTenant })
    assert.deepEqual(foreign.json().subscriptions, [])
    // Reserva sem provider_id: encontrada por external_reference único.
    const lost = new FakeMercadoPago()
    const g = await setup(lost)
    try {
      lost.hideCreated = true
      const original = lost.create.bind(lost)
      lost.create = async (...args) => { await original(...args); throw new Error("resposta perdida") }
      assert.equal((await checkout(g)).statusCode, 500)
      const reserved = (await g.seed.query("SELECT id FROM company_subscriptions")).rows[0].id as string
      const none = await refresh2(g, reserved)
      assert.equal(none.statusCode, 409, "sem correspondência única a reserva é mantida")
      lost.hideCreated = false
      const found = await refresh2(g, reserved)
      assert.equal(found.statusCode, 200)
      assert.equal(found.json().status, "pending")
    } finally { await g.close() }
  } finally { await f.close() }
})
const refresh2 = (f: Awaited<ReturnType<typeof setup>>, subscriptionId: string) => f.call({ method: "POST", url: "/api/v1/company-account/refresh", body: { subscriptionId } })

test("company-account: change-plan e cancel exigem confirmação do provedor e confirmação do usuário", enabled, async () => {
  const f = await setup()
  try {
    const created = (await checkout(f)).json()
    const command = (action: "change-plan" | "cancel", body: unknown, extra: Partial<Parameters<typeof f.call>[0]> = {}) => f.call({ method: "POST", url: `/api/v1/company-account/${action}`, body, ...extra })
    assert.equal((await command("change-plan", { subscriptionId: created.id, planId: "diamante" })).statusCode, 409, "só assinatura autorizada muda de plano")
    f.payments!.authorize("mp-1")
    assert.equal((await command("change-plan", { subscriptionId: created.id, planId: "diamante" }, { token: null })).statusCode, 401)
    assert.equal((await command("change-plan", { subscriptionId: created.id, planId: "diamante" }, { token: "reader" })).statusCode, 403)
    for (const planId of ["elite", "inexistente", undefined]) assert.equal((await command("change-plan", { subscriptionId: created.id, planId })).statusCode, 422)
    assert.equal((await command("change-plan", { subscriptionId: "99999999-9999-4999-8999-999999999999", planId: "diamante" })).statusCode, 404)
    const changed = await command("change-plan", { subscriptionId: created.id, planId: "diamante" })
    assert.equal(changed.statusCode, 200)
    assert.equal(changed.json().planId, "diamante")
    assert.equal(f.payments!.items.get("mp-1").auto_recurring.transaction_amount, planPrice("diamante"))
    assert.equal((await command("cancel", { subscriptionId: created.id })).statusCode, 422)
    assert.equal((await command("cancel", { subscriptionId: created.id, confirmation: "cancelar" })).statusCode, 422)
    assert.equal((await command("cancel", { subscriptionId: created.id, confirmation: "CANCELAR" }, { token: "other", tenant: f.otherTenant })).statusCode, 404)
    const puts = () => f.payments!.calls.filter(call => call.startsWith("PUT")).length
    const cancelled = await command("cancel", { subscriptionId: created.id, confirmation: "CANCELAR" })
    assert.equal(cancelled.statusCode, 200)
    assert.equal(cancelled.json().status, "cancelled")
    const before = puts()
    // Repetir o cancelamento é idempotente: não envia outro PUT ao provedor.
    const again = await command("cancel", { subscriptionId: created.id, confirmation: "CANCELAR" })
    assert.equal(again.statusCode, 200)
    assert.equal(puts(), before)
    const actions = (await f.seed.query("SELECT action FROM audit_log WHERE entity_type='subscription' ORDER BY occurred_at,id")).rows.map(row => row.action)
    assert.deepEqual(actions, ["subscription.checkout_requested", "subscription.plan_changed", "subscription.cancelled", "subscription.cancelled"])
    // Após cancelar, a empresa pode contratar novamente.
    assert.equal((await checkout(f)).statusCode, 200)
  } finally { await f.close() }
})

test("company-account: invoices pagina a cobrança do provedor, valida a origem e isola empresas", enabled, async () => {
  const f = await setup()
  try {
    const created = (await checkout(f)).json()
    const invoices = (query: string, extra: Partial<Parameters<typeof f.call>[0]> = {}) => f.call({ method: "GET", url: `/api/v1/company-account/invoices?${query}`, ...extra })
    f.payments!.invoices = [{ id: 10, preapproval_id: "mp-1", reason: "Ávila ERP — Cobalto", transaction_amount: 60, currency_id: "BRL", debit_date: "2026-12-01", status: "scheduled", payment: { status: "approved" } }]
    const ok = await invoices(`subscriptionId=${created.id}`)
    assert.equal(ok.statusCode, 200)
    assert.deepEqual(ok.json(), { data: [{ id: 10, description: "Ávila ERP — Cobalto", amount: 60, currency: "BRL", dueDate: "2026-12-01", status: "scheduled", paymentStatus: "approved" }], total: 1, offset: 0 })
    assert.equal((await invoices(`subscriptionId=${created.id}`, { token: null })).statusCode, 401)
    assert.equal((await invoices(`subscriptionId=${created.id}`, { token: "visitor" })).statusCode, 403)
    assert.equal((await invoices(`subscriptionId=${created.id}`, { token: "reader" })).statusCode, 200, "leitura basta para consultar")
    for (const query of ["", "subscriptionId=x", `subscriptionId=${created.id}&offset=-1`, `subscriptionId=${created.id}&offset=100001`, `subscriptionId=${created.id}&extra=1`])
      assert.equal((await invoices(query)).statusCode, 422, query)
    assert.equal((await invoices("subscriptionId=99999999-9999-4999-8999-999999999999")).statusCode, 404)
    assert.equal((await invoices(`subscriptionId=${created.id}`, { token: "other", tenant: f.otherTenant })).statusCode, 404)
    // Fatura de outra assinatura devolvida pelo provedor é rejeitada.
    f.payments!.invoices = [{ id: 11, preapproval_id: "mp-outra" }]
    f.payments!.items.get("mp-1")
    const mixed = f.payments!.request.bind(f.payments)
    f.payments!.request = async (method, path, query, body) => path === "/authorized_payments/search" ? { results: [{ id: 11, preapproval_id: "mp-outra" }] } : mixed(method, path, query, body)
    assert.equal((await invoices(`subscriptionId=${created.id}`)).statusCode, 409)
    // Reserva ainda sem confirmação do provedor.
    await f.seed.query("UPDATE company_subscriptions SET provider_id=NULL")
    assert.equal((await invoices(`subscriptionId=${created.id}`)).statusCode, 409)
  } finally { await f.close() }
})
