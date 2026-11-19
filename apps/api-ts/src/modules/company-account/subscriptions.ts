import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply } from "fastify"
import { z } from "zod"

import { authorizeRequest, type AccessDependencies, type AuthorizedContext } from "../../platform/access.js"
import { authorizedDomain, conflict, invalid, notFound } from "../../platform/domain.js"
import { findPlan, plans, type Plan } from "./catalog.js"
import { checkoutUrl, providerError, validProviderId, type PaymentProvider } from "./mercado-pago.js"

const READ = "platform.company.read", MANAGE = "platform.company.manage"
type Row = { id: string; plan_id: string; status: string; provider_id: string | null; details: unknown }
const present = (row: Row) => ({ id: row.id, planId: row.plan_id, status: row.status, details: row.details })
const columns = "id,plan_id,status,provider_id,details"
const bad = () => invalid("Confira os dados da solicitação")
const numeric = (value: unknown) => typeof value === "number" ? value : typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : undefined

const checkoutSchema = z.strictObject({ planId: z.string(), payerEmail: z.string() })
const commandSchema = z.strictObject({ subscriptionId: z.guid(), planId: z.string().nullish(), confirmation: z.string().nullish() })
const invoiceSchema = z.strictObject({ subscriptionId: z.guid(), offset: z.string().regex(/^\d{1,10}$/).optional() })

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw bad()
  return result.data
}

async function load(context: AuthorizedContext, id: string) {
  const { rows } = await context.client.query<Row>(`SELECT ${columns} FROM company_subscriptions WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [context.tenantId, id])
  if (!rows[0]) throw notFound()
  return rows[0]
}

/**
 * Só uma projeção pequena e não sensível da resposta do provedor é gravada.
 * Cada leitura é conferida com a referência do servidor e o catálogo de preços.
 */
function verified(row: Row, value: any) {
  const id = value?.id
  if (!validProviderId(id)) throw providerError()
  if ((row.provider_id !== null && row.provider_id !== id) || value.external_reference !== row.id) throw providerError()
  const recurring = value.auto_recurring ?? {}
  const amount = numeric(recurring.transaction_amount)
  if (amount === undefined) throw providerError()
  const plan = plans.find(item => !item.customQuote && Math.abs(amount * 100 - item.monthlyCents) < 0.001)
  if (!plan) throw providerError()
  if (recurring.currency_id !== "BRL" || recurring.frequency !== 1 || recurring.frequency_type !== "months") throw providerError()
  const status = ["pending", "authorized", "paused", "cancelled"].find(item => item === value.status)
  if (!status) throw providerError()
  const text = (field: unknown) => typeof field === "string" ? field : null
  const details = { checkoutUrl: checkoutUrl(value), paymentMethod: text(value.payment_method_id), nextPaymentDate: text(value.next_payment_date), startedAt: text(value.date_created), checkedAt: new Date().toISOString() }
  return { planId: plan.id, status, id, details }
}

async function persist(context: AuthorizedContext, row: Row, value: unknown) {
  const confirmed = verified(row, value)
  await context.client.query("UPDATE company_subscriptions SET provider_id=$3,plan_id=$4,status=$5,details=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2",
    [context.tenantId, row.id, confirmed.id, confirmed.planId, confirmed.status, confirmed.details])
}

async function audit(context: AuthorizedContext, id: string, action: string) {
  await context.client.query("INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,entity_id,details) SELECT $1,id,$3,'subscription',$4,'{}'::jsonb FROM identities WHERE auth_subject=$2",
    [context.tenantId, context.identity.subject, action, id])
}

export function registerSubscriptionRoutes(app: FastifyInstance, dependencies: AccessDependencies, payments: PaymentProvider | undefined) {
  const provider = () => {
    if (!payments) throw conflict("O Mercado Pago ainda não está configurado para cobrar assinaturas do ERP.")
    return payments
  }
  const send = (reply: FastifyReply) => reply.header("cache-control", "no-store")

  app.get("/api/v1/company-account", async (request, reply) => {
    const body = await authorizedDomain(request, dependencies, READ, MANAGE, false, async (context, canEdit) => {
      const subscriptions = await context.client.query<Row>(`SELECT ${columns} FROM company_subscriptions WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50`, [context.tenantId])
      const users = await context.client.query<{ total: string }>("SELECT count(*)::text AS total FROM tenant_memberships WHERE tenant_id=$1 AND status='active'", [context.tenantId])
      const photos = await context.client.query<{ total: string }>("SELECT COALESCE(sum(octet_length(photo_data_url)),0)::text AS total FROM products WHERE tenant_id=$1", [context.tenantId])
      return { tenantId: context.tenantId, canEdit, providerConfigured: payments !== undefined, plans, subscriptions: subscriptions.rows.map(present),
        activeUsers: Number(users.rows[0]?.total ?? 0), productPhotoBytes: Number(photos.rows[0]?.total ?? 0) }
    })
    return send(reply).send(body)
  })

  app.post("/api/v1/company-account/checkout", async (request, reply) => {
    // Fase 1: reserva confirmada antes de chamar o provedor; nenhuma repetição automática do POST.
    const reserved = await authorizedDomain(request, dependencies, READ, MANAGE, true, async context => {
      const gateway = provider()
      const data = parse(checkoutSchema, request.body)
      const plan = findPlan(data.planId)
      if (!plan || plan.customQuote) throw invalid("Plano inválido ou sujeito a proposta comercial")
      const email = data.payerEmail.trim()
      const [local, domain] = email.split(/@(.*)/s, 2)
      if (email.length > 254 || /\s/u.test(email) || !local || !domain || !domain.includes(".") || domain.includes("@")) throw invalid("Informe um e-mail válido para o pagador")
      const existing = await context.client.query("SELECT 1 FROM company_subscriptions WHERE tenant_id=$1 AND status NOT IN ('cancelled','rejected') LIMIT 1", [context.tenantId])
      if (existing.rows.length) throw conflict("Já existe uma assinatura ou contratação pendente. Atualize a assinatura para continuar.")
      const id = randomUUID()
      await context.client.query("INSERT INTO company_subscriptions(id,tenant_id,plan_id) VALUES($1,$2,$3)", [id, context.tenantId, plan.id])
      await audit(context, id, "subscription.checkout_requested")
      return { gateway, plan, email, id }
    })
    let result: unknown
    try { result = await reserved.gateway.create(reserved.id, reserved.plan, reserved.email) }
    catch (error) {
      if (error instanceof Error && "status" in error && error.status === 422) {
        await authorizeRequest(request, dependencies, async context => {
          await context.client.query("UPDATE company_subscriptions SET status='rejected',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='creating' AND provider_id IS NULL", [context.tenantId, reserved.id])
          await audit(context, reserved.id, "subscription.checkout_rejected")
        }, true)
      }
      throw error
    }
    const data = await authorizeRequest(request, dependencies, async context => {
      const row = await load(context, reserved.id)
      if (verified(row, result).planId !== reserved.plan.id) throw providerError()
      await persist(context, row, result)
      return present(await load(context, reserved.id))
    }, true)
    return send(reply).send(data)
  })

  app.post("/api/v1/company-account/refresh", async (request, reply) => {
    const data = await authorizedDomain(request, dependencies, READ, MANAGE, true, async context => {
      const input = parse(commandSchema, request.body)
      const row = await load(context, input.subscriptionId)
      const gateway = provider()
      let value: unknown
      if (row.provider_id) value = await gateway.request("GET", `/preapproval/${row.provider_id}`)
      else {
        const found: any = await gateway.request("GET", "/preapproval/search", { q: row.id, limit: "100" })
        if (!Array.isArray(found?.results)) throw providerError()
        const matches = found.results.filter((item: any) => item?.external_reference === row.id)
        if (matches.length !== 1) throw conflict("Contratação ainda sem confirmação única no Mercado Pago. A reserva foi mantida para impedir cobranças duplicadas; solicite a conferência pelo administrador.")
        value = matches[0]
      }
      await persist(context, row, value)
      return present(await load(context, row.id))
    })
    return send(reply).send(data)
  })

  async function mutate(request: Parameters<typeof authorizedDomain>[0], cancelling: boolean) {
    return authorizedDomain(request, dependencies, READ, MANAGE, true, async context => {
      const gateway = provider()
      const input = parse(commandSchema, (request as { body?: unknown }).body)
      const row = await load(context, input.subscriptionId)
      if (!row.provider_id) throw conflict("Atualize a contratação pendente antes de alterar a assinatura")
      const path = `/preapproval/${row.provider_id}`
      const remote = await gateway.request("GET", path)
      const { status } = verified(row, remote)
      let body: unknown, plan: Plan | undefined
      if (cancelling) {
        if (input.confirmation !== "CANCELAR") throw invalid("Confirme o cancelamento da assinatura")
        body = { status: "cancelled" }
      } else {
        if (status !== "authorized") throw conflict("Somente uma assinatura autorizada pode mudar de plano")
        plan = findPlan(input.planId)
        if (!plan || plan.customQuote) throw invalid("Selecione um plano válido")
        body = { reason: `Ávila ERP — ${plan.name}`, auto_recurring: { transaction_amount: Math.trunc(plan.monthlyCents / 100), currency_id: "BRL" } }
      }
      // PUT define estado/preço e pode ser conferido por GET após resposta incerta.
      const value = cancelling && status === "cancelled" ? remote : await gateway.request("PUT", path, {}, body)
      const confirmed = verified(row, value)
      if (cancelling ? confirmed.status !== "cancelled" : input.planId !== confirmed.planId) throw providerError()
      await persist(context, row, value)
      await audit(context, row.id, cancelling ? "subscription.cancelled" : "subscription.plan_changed")
      return present(await load(context, row.id))
    })
  }
  app.post("/api/v1/company-account/change-plan", async (request, reply) => send(reply).send(await mutate(request, false)))
  app.post("/api/v1/company-account/cancel", async (request, reply) => send(reply).send(await mutate(request, true)))

  app.get("/api/v1/company-account/invoices", async (request, reply) => {
    const query = parse(invoiceSchema, request.query)
    const row = await authorizedDomain(request, dependencies, READ, MANAGE, false, context => load(context, query.subscriptionId))
    if (!row.provider_id) throw conflict("Assinatura ainda não confirmada")
    const offset = Number(query.offset ?? 0)
    if (offset > 100000) throw invalid("Página inválida")
    const value: any = await provider().request("GET", "/authorized_payments/search", { preapproval_id: row.provider_id, offset: String(offset), limit: "10" })
    if (!Array.isArray(value?.results) || value.results.some((item: any) => item?.preapproval_id !== row.provider_id)) throw providerError()
    const data = value.results.map((item: any) => ({ id: item.id ?? null, description: item.reason ?? null, amount: item.transaction_amount ?? null, currency: item.currency_id ?? null, dueDate: item.debit_date ?? null, status: item.status ?? null, paymentStatus: item.payment?.status ?? null }))
    return send(reply).send({ data, total: value.paging?.total ?? null, offset })
  })
}
