import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { Problem } from "../../platform/problem.js"
import { parseJson } from "../../platform/json.js"
import { conflict, invalid } from "./ledger.js"

const merchantSchema = z.object({
  tenantId: z.guid(),
  accountId: z.guid(),
  collectorId: z.string().regex(/^\d+$/),
  accessToken: z.string().min(16),
  webhookSecret: z.string().min(16),
  subject: z.string().min(1),
  live: z.boolean().default(false),
})
export type Merchant = z.infer<typeof merchantSchema>
export function merchants(): Merchant[] {
  const env = process.env
  const result = merchantSchema.safeParse({
    tenantId: env.FINANCE_MP_SANDBOX_TENANT_ID,
    accountId: env.FINANCE_MP_SANDBOX_ACCOUNT_ID,
    collectorId: env.FINANCE_MP_SANDBOX_COLLECTOR_ID,
    accessToken: env.FINANCE_MP_SANDBOX_ACCESS_TOKEN,
    webhookSecret: env.FINANCE_MP_SANDBOX_WEBHOOK_SECRET,
    subject: env.FINANCE_MP_SANDBOX_SUBJECT,
  })
  const configs = result.success ? [result.data] : []
  if (env.FINANCE_MP_CONNECTIONS) {
    const secretName = z.string().regex(/^FINANCE_MP_[A-Z0-9_]+$/)
    const schema = z
      .array(
        z.strictObject({
          tenantId: z.guid(),
          accountId: z.guid(),
          collectorId: z.string().regex(/^\d+$/),
          subject: z.string().min(1),
          mode: z.enum(["sandbox", "production"]),
          enabled: z.boolean(),
          tokenEnv: secretName,
          webhookEnv: secretName,
        }),
      )
      .max(100)
    let bindings: z.infer<typeof schema>
    try {
      bindings = schema.parse(JSON.parse(env.FINANCE_MP_CONNECTIONS))
    } catch {
      throw new Problem(503, "bank_configuration", "Vínculos do Mercado Pago inválidos")
    }
    for (const binding of bindings) {
      if (!binding.enabled || (binding.mode === "production" && env.FINANCE_MP_ENABLE_PRODUCTION !== "true")) continue
      const item = merchantSchema.safeParse({
        ...binding,
        live: binding.mode === "production",
        accessToken: env[binding.tokenEnv],
        webhookSecret: env[binding.webhookEnv],
      })
      if (!item.success) throw new Problem(503, "bank_configuration", "Credencial ausente no vínculo financeiro")
      configs.push(item.data)
    }
  }
  const accounts = new Set(configs.map((c) => c.tenantId + "/" + c.accountId)),
    receivers = new Set(configs.map((c) => String(c.live) + "/" + c.collectorId))
  if (accounts.size !== configs.length || receivers.size !== configs.length)
    throw new Problem(503, "bank_configuration", "Conta ou vendedor associado a mais de um vínculo financeiro")
  return configs
}
export function requirePilot(tenantId: string, accountId?: string) {
  const config = merchants().find((c) => c.tenantId === tenantId && c.accountId === accountId)
  if (!config) throw conflict("Configure o vínculo Mercado Pago desta conta financeira para emitir cobranças")
  return config
}
async function remote(transport: typeof fetch, url: string, config: Merchant, body?: unknown, key?: string) {
  const response = await transport(url, {
    method: body ? "POST" : "GET",
    redirect: "error",
    headers: {
      Authorization: "Bearer " + config.accessToken,
      "Content-Type": "application/json",
      ...(key ? { "X-Idempotency-Key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {
    throw new Problem(503, "bank_unavailable", "Confirmação do Mercado Pago pendente. Repita a consulta")
  })
  if (!response.ok)
    throw new Problem(
      response.status >= 500 || response.status === 429 ? 503 : 422,
      "bank_request_failed",
      "Mercado Pago recusou a operação • HTTP " + response.status,
    )
  try {
    return parseJson(await response.text()) as unknown
  } catch {
    throw new Problem(503, "bank_unavailable", "O provedor retornou uma resposta inválida. Confira a mesma operação")
  }
}
export const paymentSchema = z.object({
  id: z.coerce.string().regex(/^\d+$/),
  live_mode: z.boolean(),
  collector_id: z.coerce.string(),
  currency_id: z.string(),
  external_reference: z.string(),
  status: z.string(),
  payment_method_id: z.string(),
  transaction_amount: z.number(),
  date_approved: z.string().nullish(),
  transaction_amount_refunded: z.number().nullish(),
  transaction_details: z
    .object({
      net_received_amount: z.number().nullish(),
      external_resource_url: z.string().nullish(),
      payment_method_reference_id: z.string().nullish(),
    })
    .nullish(),
  point_of_interaction: z.object({ transaction_data: z.object({ qr_code: z.string().nullish() }).nullish() }).nullish(),
  barcode: z.object({ content: z.string().nullish() }).nullish(),
})
export type BankPayment = z.infer<typeof paymentSchema>
function payment(value: unknown, config: Merchant) {
  const parsed = paymentSchema.safeParse(value)
  if (!parsed.success || parsed.data.live_mode !== config.live || parsed.data.collector_id !== config.collectorId)
    throw conflict("A resposta financeira diverge da conta e do ambiente vinculados")
  return parsed.data
}
export async function verifyMerchant(config: Merchant, transport: typeof fetch = fetch) {
  const identity = z
    .object({ id: z.coerce.string(), tags: z.array(z.string()), site_id: z.string() })
    .safeParse(await remote(transport, "https://api.mercadolibre.com/users/me", config))
  if (
    !identity.success ||
    identity.data.id !== config.collectorId ||
    identity.data.site_id !== "MLB" ||
    identity.data.tags.includes("test_user") === config.live
  )
    throw conflict("O vendedor e o ambiente devem corresponder ao vínculo financeiro brasileiro")
}
export async function issue(config: Merchant, body: unknown, key: string, transport: typeof fetch = fetch) {
  await verifyMerchant(config,transport)
  const query = new URLSearchParams({ external_reference: key, sort: "date_created", criteria: "desc", limit: "2" })
  const existing = z
    .object({ results: z.array(z.object({ id: z.coerce.string().regex(/^\d+$/), external_reference: z.string() })) })
    .safeParse(await remote(transport, "https://api.mercadopago.com/v1/payments/search?" + query, config))
  if (
    !existing.success ||
    existing.data.results.some((p) => p.external_reference !== key) ||
    existing.data.results.length > 1
  )
    throw conflict("Confira a identificação da cobrança no provedor antes de prosseguir")
  if (existing.data.results[0]) return getPayment(config, existing.data.results[0].id, transport)
  return payment(await remote(transport, "https://api.mercadopago.com/v1/payments", config, body, key), config)
}
export async function getPayment(config: Merchant, id: string, transport: typeof fetch = fetch) {
  if (!/^\d{1,25}$/.test(id)) throw invalid("Identificação de pagamento inválida")
  return payment(await remote(transport, "https://api.mercadopago.com/v1/payments/" + id, config), config)
}
export function checkSignature(
  config: Merchant,
  signature: unknown,
  requestId: unknown,
  dataId: string,
  now = Date.now(),
) {
  const reject = () => {
    throw new Problem(401, "invalid_signature", "Assinatura da notificação inválida")
  }
  if (
    typeof signature !== "string" ||
    typeof requestId !== "string" ||
    !/^[\w.-]{1,150}$/.test(requestId) ||
    !/^\d{1,25}$/.test(dataId)
  )
    return reject()
  const parts = Object.fromEntries(signature.split(",").map((field) => field.trim().split("="))),
    ts = parts.ts,
    hash = parts.v1
  if (!ts || !/^\d{10,13}$/.test(ts) || !hash || !/^[a-f\d]{64}$/i.test(hash)) return reject()
  const time = ts.length === 13 ? Number(ts) : Number(ts) * 1000
  if (Math.abs(now - time) > 300000) return reject()
  const expected = createHmac("sha256", config.webhookSecret)
    .update("id:" + dataId + ";request-id:" + requestId + ";ts:" + ts + ";")
    .digest()
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return reject()
}
export function providerCents(value: number) {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 999999999999.99 ||
    Math.abs(Math.round(value * 100) - value * 100) > 0.02
  )
    throw invalid("Valor do provedor fora da escala em centavos")
  return BigInt(Math.round(value * 100))
}
export function settlementReport(raw: string, collectorId: string) {
  const rows: string[][] = [],
    row: string[] = []
  let current = "",
    quoted = false
  raw = raw.replace(/^\uFEFF/, "")
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!
    if (char === '"') {
      if (quoted && raw[i + 1] === '"') {
        current += '"'
        i++
      } else quoted = !quoted
    } else if (char === ";" && !quoted) {
      row.push(current)
      current = ""
    } else if (char === "\n" && !quoted) {
      row.push(current.replace(/\r$/, ""))
      rows.push(row.splice(0))
      current = ""
    } else current += char
  }
  if (quoted) throw invalid("Aspas incompletas no relatório Mercado Pago")
  if (current || row.length) rows.push([...row, current.replace(/\r$/, "")])
  const header = rows.shift() ?? [],
    required = [
      "EXTERNAL_REFERENCE",
      "SOURCE_ID",
      "USER_ID",
      "TRANSACTION_TYPE",
      "TRANSACTION_AMOUNT",
      "TRANSACTION_CURRENCY",
      "SETTLEMENT_NET_AMOUNT",
    ]
  if (!required.every((key) => header.includes(key)) || new Set(header).size !== header.length)
    throw invalid("Selecione o relatório Dinheiro em conta com as colunas originais")
  if (rows.length > 3000) throw invalid("Importe até 3.000 linhas por arquivo")
  return rows
    .filter((v) => v.some(Boolean))
    .map((v) => {
      if (v.length !== header.length) throw invalid("Linha incompleta no relatório Mercado Pago")
      const get = (name: string) => v[header.indexOf(name)]!
      if (get("USER_ID") !== collectorId) throw conflict("O relatório contém operações de outra conta")
      return {
        id: get("SOURCE_ID"),
        externalReference: get("EXTERNAL_REFERENCE"),
        type: get("TRANSACTION_TYPE").toLowerCase(),
        currency: get("TRANSACTION_CURRENCY"),
        gross: get("TRANSACTION_AMOUNT"),
        net: get("SETTLEMENT_NET_AMOUNT"),
      }
    })
}
