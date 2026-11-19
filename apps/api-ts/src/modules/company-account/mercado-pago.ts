import { Problem } from "../../platform/problem.js"
import type { Plan } from "./catalog.js"

/** Interface do provedor de cobrança. O código das rotas só conhece esta interface. */
export interface PaymentProvider {
  request(method: "GET" | "POST" | "PUT", path: string, query?: Record<string, string>, body?: unknown): Promise<any>
  create(reference: string, plan: Plan, email: string): Promise<any>
}

export const providerError = () => new Problem(409, "domain_conflict", "Não foi possível confirmar a operação no Mercado Pago. Atualize a assinatura antes de tentar novamente.")
export const creationRefused = () => new Problem(422, "invalid_input", "O Mercado Pago recusou a criação. Confira o e-mail do pagador e a configuração da integração antes de tentar novamente.")

export const validProviderId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id)

/** Só aceita o checkout hospedado do Mercado Pago, sem credenciais, porta ou caminho alheio. */
export function checkoutUrl(value: any): string | null {
  const raw = value?.init_point
  if (typeof raw !== "string") return null
  try {
    const url = new URL(raw)
    return url.protocol === "https:" && url.hostname === "www.mercadopago.com.br" && !url.username && !url.password && !url.port && url.pathname === "/subscriptions/checkout" ? raw : null
  } catch { return null }
}

export type MercadoPagoOptions = { token: string; returnUrl: string; origin?: string; http?: typeof fetch }

export class MercadoPago implements PaymentProvider {
  private readonly origin: string
  private readonly http: typeof fetch
  constructor(private readonly options: MercadoPagoOptions) {
    this.origin = options.origin ?? "https://api.mercadopago.com"
    this.http = options.http ?? fetch
  }
  async request(method: "GET" | "POST" | "PUT", path: string, query: Record<string, string> = {}, body?: unknown) {
    const creation = method === "POST" && path === "/preapproval"
    const url = new URL(this.origin + path)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    let response: Response
    try {
      response = await this.http(url, { method, redirect: "error", signal: AbortSignal.timeout(6000),
        headers: { authorization: `Bearer ${this.options.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch { throw providerError() }
    if (creation && [400, 401, 403, 404, 422].includes(response.status)) throw creationRefused()
    if (!response.ok) throw providerError()
    try { return await response.json() } catch { throw providerError() }
  }
  create(reference: string, plan: Plan, email: string) {
    return this.request("POST", "/preapproval", {}, {
      reason: `Ávila ERP — ${plan.name}`, external_reference: reference, payer_email: email, back_url: this.options.returnUrl, status: "pending",
      auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: Math.trunc(plan.monthlyCents / 100), currency_id: "BRL" },
    })
  }
}

/** Equivalente a `MercadoPago::from_env`: sem token, a cobrança fica desligada. */
export function mercadoPagoFromEnv(env: NodeJS.ProcessEnv = process.env): MercadoPago | undefined {
  const token = (env.ERP_MP_ACCESS_TOKEN ?? "").trim()
  if (!token) return undefined
  const returnUrl = env.ERP_MP_RETURN_URL ?? ""
  let url: URL
  try { url = new URL(returnUrl) } catch { throw new Error("ERP_MP_RETURN_URL is required") }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error("ERP_MP_RETURN_URL must be an HTTPS URL without credentials")
  return new MercadoPago({ token: env.ERP_MP_ACCESS_TOKEN!, returnUrl })
}
