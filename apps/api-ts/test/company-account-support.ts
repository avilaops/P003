import { plans, type Plan } from "../src/modules/company-account/catalog.js"
import { creationRefused, providerError, type PaymentProvider } from "../src/modules/company-account/mercado-pago.js"

/** Mercado Pago falso em memória: nenhum teste chama a API real. */
export class FakeMercadoPago implements PaymentProvider {
  items = new Map<string, any>()
  calls: string[] = []
  refuseCreation = false
  failNext = false
  invoices: any[] = []
  /** Quando verdadeiro, a criação não fica visível para busca (simula resposta perdida). */
  hideCreated = false
  private counter = 0
  async create(reference: string, plan: Plan, email: string) {
    this.calls.push("create")
    if (this.refuseCreation) throw creationRefused()
    const id = `mp-${++this.counter}`
    const item = { id, external_reference: reference, status: "pending", payer_email: email, payment_method_id: "visa", date_created: "2026-11-19T10:00:00.000-03:00",
      init_point: `https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=${id}`, auto_recurring: { currency_id: "BRL", frequency: 1, frequency_type: "months", transaction_amount: plan.monthlyCents / 100 } }
    this.items.set(id, item)
    return structuredClone(item)
  }
  async request(method: "GET" | "POST" | "PUT", path: string, query: Record<string, string> = {}, body?: any) {
    this.calls.push(`${method} ${path}`)
    if (this.failNext) { this.failNext = false; throw providerError() }
    if (method === "GET" && path === "/preapproval/search") return { results: this.hideCreated ? [] : [...this.items.values()].filter(item => item.external_reference === query.q).map(item => structuredClone(item)) }
    if (method === "GET" && path === "/authorized_payments/search")
      return { results: this.invoices.filter(item => item.preapproval_id === query.preapproval_id), paging: { total: this.invoices.length } }
    const item = this.items.get(path.replace("/preapproval/", ""))
    if (!item) throw providerError()
    if (method === "PUT") {
      if (body.status) item.status = body.status
      if (body.auto_recurring) item.auto_recurring = { ...item.auto_recurring, ...body.auto_recurring }
    }
    return structuredClone(item)
  }
  authorize(id: string) { this.items.get(id).status = "authorized" }
}

export const planPrice = (id: string) => plans.find(plan => plan.id === id)!.monthlyCents / 100
export const companyPermissions = ["platform.company.read", "platform.company.manage"]
