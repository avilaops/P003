import { IE_STATES, type LookupAttempt, type LookupInput, type LookupKind, type LookupReply, type RegistryProvider } from "./model.js"
import { parseRegistry, statusWarning } from "./parse.js"

const MAX_CACHE = 512, MAX_BODY = 262_144, PROVIDER_TIMEOUT = 3000
type Provider = "viacep" | "brasilcep" | "brasilcnpj" | "cnpjws"
const SOURCES: Record<Provider, string> = { viacep: "ViaCEP", brasilcep: "BrasilAPI", brasilcnpj: "BrasilAPI", cnpjws: "CNPJ.ws" }
export type RegistryEndpoints = Record<Provider, string>
export const defaultEndpoints: RegistryEndpoints = { viacep: "https://viacep.com.br/ws", brasilcep: "https://brasilapi.com.br/api/cep/v2", brasilcnpj: "https://brasilapi.com.br/api/cnpj/v1", cnpjws: "https://publica.cnpj.ws/cnpj" }
const NIL = "00000000-0000-0000-0000-000000000000"

function reserve(queue: number[], maximum: number, now: number) {
  while (queue.length > 0 && now - queue[0]! >= 60_000) queue.shift()
  if (queue.length >= maximum) return false
  queue.push(now)
  return true
}

// Registry data is public, so results are cached per company (or per identity for sign-up),
// with per-source budgets so a tenant cannot exhaust the free providers.
export class RegistryClient implements RegistryProvider {
  private readonly cache = new Map<string, { expires: number; reply: LookupReply }>()
  private readonly budgets = new Map<string, number[]>()
  private readonly scopes = new Map<string, number[]>()
  private inFlight = 0
  constructor(private readonly options: { cnpjWsEnabled: boolean; endpoints?: RegistryEndpoints; fetcher?: typeof fetch; now?: () => number } = { cnpjWsEnabled: false }) {}

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env) { return new RegistryClient({ cnpjWsEnabled: environment.ERP_CNPJ_WS_ENABLED === "true" }) }
  private get now() { return this.options.now?.() ?? Date.now() }

  lookup(tenant: string, input: LookupInput) { return this.scoped(`tenant:${tenant}`, tenant, input) }
  lookupRegistration(subject: string, input: LookupInput) { return this.scoped(`registration:${subject}`, NIL, input) }

  private async scoped(scope: string, tenant: string, input: LookupInput): Promise<LookupReply> {
    const now = this.now, key = JSON.stringify([scope, input.kind, input.value, input.state])
    const reply: LookupReply = { tenantId: tenant, kind: input.kind, value: input.value, status: "unavailable", data: null, source: null, sourceUpdatedAt: null, fetchedAt: new Date(now).toISOString(), expiresAt: null, cached: false, attempts: [], warnings: [] }
    for (const [name, entry] of this.cache) if (entry.expires <= now) this.cache.delete(name)
    const hit = this.cache.get(key)
    if (hit) return { ...structuredClone(hit.reply), cached: true }
    for (const [name, queue] of this.scopes) if (!(queue.at(-1) !== undefined && now - queue.at(-1)! < 60_000)) this.scopes.delete(name)
    if (this.scopes.size >= MAX_CACHE && !this.scopes.has(scope) || !reserve(this.scopes.get(scope) ?? this.scopes.set(scope, []).get(scope)!, 20, now)) {
      reply.warnings.push("Limite de consultas atingido. Aguarde um minuto ou preencha manualmente")
      return reply
    }
    if (this.inFlight >= 8) { reply.warnings.push("Consultas ocupadas. Continue o preenchimento manual"); return reply }
    this.inFlight += 1
    try { return await this.query(key, reply, input) } finally { this.inFlight -= 1 }
  }

  private async query(key: string, reply: LookupReply, input: LookupInput): Promise<LookupReply> {
    if (input.kind === "ie" && (!this.options.cnpjWsEnabled || /[A-Za-z]/.test(input.value) || input.state === null || !IE_STATES.includes(input.state))) {
      reply.status = "unsupported"
      reply.warnings.push("Consulta IE indisponível para esta fonte, UF ou documento. Confirme no cadastro estadual; ausência não significa isenção")
      return reply
    }
    const providers: Provider[] = input.kind === "cep" ? ["viacep", "brasilcep"] : input.kind === "ie" ? ["cnpjws"]
      : ["brasilcnpj", ...(this.options.cnpjWsEnabled && /^\d+$/.test(input.value) ? ["cnpjws" as const] : [])]
    const endpoints = this.options.endpoints ?? defaultEndpoints
    let allAbsent = true
    for (const provider of providers) {
      const source = SOURCES[provider], attempt = (outcome: string) => reply.attempts.push({ source, outcome } satisfies LookupAttempt)
      const queue = this.budgets.get(source) ?? this.budgets.set(source, []).get(source)!
      if (!reserve(queue, source === "CNPJ.ws" ? 3 : 30, this.now)) { allAbsent = false; attempt("rate_limited"); continue }
      const result = await this.fetchJson(`${endpoints[provider]}/${input.value}${provider === "viacep" ? "/json" : ""}`)
      if (result === undefined) { allAbsent = false; attempt("unavailable"); continue }
      if (result.status === 404) { attempt("not_found"); continue }
      if (result.status === 200 && provider === "viacep" && (result.body as { erro?: unknown } | null)?.erro !== undefined && ((result.body as { erro?: unknown }).erro === true || (result.body as { erro?: unknown }).erro === "true")) { attempt("not_found"); continue }
      if (result.status !== 200) { allAbsent = false; attempt(result.status === 429 ? "rate_limited" : "unavailable"); continue }
      const parsed = parseRegistry(source, input.kind as LookupKind, input.value, input.state, result.body)
      if (!parsed) { allAbsent = false; attempt("malformed_response"); continue }
      attempt("found")
      reply.status = "found"
      if (input.kind === "cnpj") { const warning = statusWarning(parsed.data.fields); if (warning) reply.warnings.push(warning) }
      if (parsed.data.genericPostalCode) reply.warnings.push("CEP genérico ou endereço incompleto. Complete os campos manualmente")
      if (input.kind !== "cep") reply.warnings.push("Confira a data da fonte e os dados fiscais. Ausência de opção pelo Simples não determina Lucro Real ou Presumido, crédito ou condição de contribuinte")
      if (source === "CNPJ.ws" && parsed.data.stateRegistrations.length === 0) reply.warnings.push("Inscrição estadual não informada na base consultada; situação desconhecida")
      reply.data = parsed.data
      reply.source = source
      reply.sourceUpdatedAt = parsed.sourceUpdatedAt
      const ttl = input.kind === "cep" ? 86_400_000 : 21_600_000
      // Cache age starts after the response, never while the provider is still pending.
      const fetched = this.now
      reply.fetchedAt = new Date(fetched).toISOString()
      reply.expiresAt = new Date(fetched + ttl).toISOString()
      if (this.cache.size >= MAX_CACHE) {
        const oldest = [...this.cache].sort((a, b) => a[1].expires - b[1].expires)[0]
        if (oldest) this.cache.delete(oldest[0])
      }
      this.cache.set(key, { expires: fetched + ttl, reply: structuredClone(reply) })
      return reply
    }
    if (allAbsent) reply.status = "not_found"
    reply.warnings.push("Consulta sem resultado disponível. Isso não comprova cadastro inválido; continue manualmente")
    return reply
  }

  // Redirects, oversized bodies, invalid JSON and timeouts all count as an unavailable provider.
  private async fetchJson(url: string): Promise<{ status: number; body: unknown } | undefined> {
    try {
      const response = await (this.options.fetcher ?? fetch)(url, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(PROVIDER_TIMEOUT) })
      if (response.status !== 200) return { status: response.status, body: null }
      if (Number(response.headers.get("content-length") ?? 0) > MAX_BODY || !response.body) return undefined
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length
        if (size > MAX_BODY) return undefined
        chunks.push(chunk)
      }
      return { status: 200, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }
    } catch { return undefined }
  }
}
