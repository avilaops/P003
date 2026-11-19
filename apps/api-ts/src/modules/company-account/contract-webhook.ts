import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { DatabaseClient, DatabasePool } from "../../platform/database.js"
import { canonicalJson, sameJson } from "../../platform/json.js"
import { Problem } from "../../platform/problem.js"
import { conflict, invalid } from "../../platform/domain.js"

/** Provedor de assinatura (DocuSeal) atrás de interface: o webhook só conhece este contrato. */
export interface ContractProvider {
  verifyWebhook(candidate: string): boolean
  request(method: "GET", path: string): Promise<any>
  pdf(url: string): Promise<Buffer>
}

const unconfirmed = () => conflict("Não foi possível confirmar o resultado no serviço de contratos. Atualize o andamento; não gere outro envio")
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")

export class DocuSeal implements ContractProvider {
  constructor(private readonly base: URL, private readonly token: string, private readonly secret: string, private readonly http: typeof fetch = fetch) {}
  verifyWebhook(candidate: string) {
    // Compara resumos de tamanho fixo, sem saída antecipada.
    return timingSafeEqual(createHash("sha256").update(candidate).digest(), createHash("sha256").update(this.secret).digest())
  }
  private async bounded(response: Response, limit: number) {
    if (!response.ok) throw unconfirmed()
    const bytes = Buffer.from(await response.arrayBuffer().catch(() => { throw unconfirmed() }))
    if (bytes.length > limit) throw conflict("Resposta do provedor excede o limite permitido")
    return bytes
  }
  async request(method: "GET", path: string) {
    const response = await this.http(new URL(`api/${path}`, this.base), { method, headers: { "X-Auth-Token": this.token }, redirect: "error", signal: AbortSignal.timeout(15_000) }).catch(() => { throw unconfirmed() })
    try { return JSON.parse((await this.bounded(response, 4 * 1024 * 1024)).toString("utf8")) } catch (error) { throw error instanceof Problem ? error : unconfirmed() }
  }
  async pdf(raw: string) {
    let url: URL
    try { url = new URL(raw) } catch { throw unconfirmed() }
    // Nada de credenciais para URLs de arquivo nem redirecionamentos.
    if (url.origin !== this.base.origin || url.username || url.password) throw conflict("Documento retornou um endereço fora do nosso servidor")
    const response = await this.http(url, { redirect: "error", signal: AbortSignal.timeout(15_000) }).catch(() => { throw unconfirmed() })
    const bytes = await this.bounded(response, 20 * 1024 * 1024)
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw conflict("O provedor não retornou um PDF válido")
    return bytes
  }
}

export function docusealFromEnv(env: NodeJS.ProcessEnv = process.env): DocuSeal | undefined {
  const token = env.DOCUSEAL_API_TOKEN
  if (token === undefined) return undefined
  const base = new URL(env.DOCUSEAL_URL ?? "https://contrato.avilaops.com")
  if (base.protocol !== "https:" || base.hostname !== "contrato.avilaops.com" || base.port || base.username || base.password || base.search || base.hash || base.pathname !== "/")
    throw new Error("DOCUSEAL_URL must be our HTTPS installation")
  const secret = env.DOCUSEAL_WEBHOOK_SECRET
  if (!secret) throw new Error("DOCUSEAL_WEBHOOK_SECRET required")
  if (token.length < 16 || secret.length < 32) throw new Error("Invalid DocuSeal credentials")
  return new DocuSeal(base, token, secret)
}

type Contract = { id: string; tenant_id: string; template_id: string; recipients: { role: string; email: string }[]; external_id: string | null; status: string; progress: unknown; problem: string | null }
const correlation = (tenant: string, id: string, index: number) => `erp:${tenant}:${id}:${index}`

async function preserve(client: DatabaseClient, provider: ContractProvider, contract: Contract, kind: string, position: number, url: string) {
  const exists = await client.query("SELECT 1 FROM commercial_contract_files WHERE tenant_id=$1 AND contract_id=$2 AND kind=$3 AND position=$4", [contract.tenant_id, contract.id, kind, position])
  if (exists.rows.length) return
  const content = await provider.pdf(url)
  await client.query("INSERT INTO commercial_contract_files(id,tenant_id,contract_id,kind,position,sha256,content) VALUES($1,$2,$3,$4,$5,$6,$7)", [randomUUID(), contract.tenant_id, contract.id, kind, position, sha256(content), content])
}

/** Ignora ordem e alegações do evento: consulta o estado autenticado atual no provedor. */
export async function reconcile(client: DatabaseClient, contract: Contract, provider: ContractProvider) {
  let external: number
  if (contract.external_id !== null) external = Number(contract.external_id)
  else {
    const found = await provider.request("GET", `submitters?external_id=${correlation(contract.tenant_id, contract.id, 0)}&limit=100`)
    if (!Array.isArray(found?.data)) throw unconfirmed()
    if (!found.data.length) throw conflict("Resultado ainda não confirmado. A atualização consulta a solicitação existente e não repete a criação ou o e-mail.")
    if (found.data.length !== 1) throw conflict("Há mais de uma solicitação com a mesma referência. Necessária conferência no portal")
    if (!Number.isInteger(found.data[0].submission_id)) throw unconfirmed()
    external = found.data[0].submission_id
  }
  const submission = await provider.request("GET", `submissions/${external}`)
  const submitters: any[] = submission?.submitters
  if (!Array.isArray(submitters)) throw unconfirmed()
  if (submission.id !== external || submission.template?.id !== Number(contract.template_id) || submitters.length !== contract.recipients.length)
    throw conflict("A solicitação do provedor não corresponde ao contrato")
  contract.recipients.forEach((recipient, index) => {
    const expected = correlation(contract.tenant_id, contract.id, index)
    if (!submitters.some(s => s.external_id === expected && typeof s.email === "string" && s.email.toLowerCase() === recipient.email.toLowerCase() && s.role === recipient.role))
      throw conflict("Destinatários divergentes no provedor; envio bloqueado")
  })
  const events: any[] | undefined = Array.isArray(submission.submission_events) ? submission.submission_events : undefined
  // Só o evento send_email confirma a transmissão; sent_at pode ser preenchido ao agendar.
  const progress = submitters.map(s => ({ id: s.id, role: s.role, email: s.email, status: s.status, sendConfirmed: events?.some(e => e.event_type === "send_email" && e.submitter_id === s.id) ?? false,
    openedAt: s.opened_at ?? null, completedAt: s.completed_at ?? null, declinedAt: s.declined_at ?? null }))
  const completed = typeof submission.completed_at === "string" && submitters.every(s => typeof s.completed_at === "string")
  let next = contract.status
  if (completed) next = "completed"
  else if (contract.status !== "completed") {
    if (submission.status === "declined") next = "declined"
    else if (submission.status === "expired") next = "expired"
    else if (!["declined", "expired"].includes(contract.status)) {
      if (progress.some(p => typeof p.openedAt === "string")) next = "opened"
      else if (progress.every(p => p.sendConfirmed) && contract.status !== "opened") next = "sent"
      else if (contract.status === "creation_requested") next = "created"
    }
  }
  const documents = (await provider.request("GET", `submissions/${external}/documents`))?.documents
  if (!Array.isArray(documents)) throw unconfirmed()
  if (!documents.length || documents.length > 10) throw conflict("Quantidade de documentos inválida")
  const kind = completed ? "signed" : "preview"
  for (const [index, document] of documents.entries()) {
    if (typeof document?.url !== "string") throw unconfirmed()
    await preserve(client, provider, contract, kind, index, document.url)
  }
  let problem: string | null = null
  if (completed) {
    if (typeof submission.audit_log_url === "string") await preserve(client, provider, contract, "audit", 0, submission.audit_log_url)
    else problem = "Assinatura confirmada; a trilha de assinatura ainda não está disponível. Atualize para preservá-la."
  }
  if (next === "send_requested") problem = "Envio solicitado; confirmação de transmissão pelo provedor ainda pendente. Consulte também a fila de e-mail do portal. Nenhum reenvio automático será realizado."
  const changed = contract.external_id === null || Number(contract.external_id) !== external || contract.status !== next || !sameJson(contract.progress, progress) || contract.problem !== problem
  if (changed) {
    await client.query("UPDATE commercial_contracts SET external_id=$3,status=$4,progress=$5,problem=$6,completed_at=COALESCE(completed_at,$7::timestamptz),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [contract.tenant_id, contract.id, external, next, JSON.stringify(progress), problem, completed ? submission.completed_at : null])
    await client.query("INSERT INTO audit_log(tenant_id,action,entity_type,entity_id,details) VALUES($1,'contract.reconciled','commercial_contract',$2,$3)", [contract.tenant_id, contract.id, { status: next, externalId: external }])
  }
}

const params = z.strictObject({ tenant: z.guid() })
const eventId = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value : typeof value === "bigint" ? Number(value) : undefined
class Retry extends Error {}

export function registerContractWebhook(app: FastifyInstance, pool: DatabasePool, provider: ContractProvider | undefined) {
  app.post("/api/v1/webhooks/contracts/:tenant", async (request, reply) => {
    if (!provider) throw conflict("Integração de contratos ainda não configurada para esta instalação")
    const secret = request.headers["x-avila-contract-secret"]
    if (!provider.verifyWebhook(typeof secret === "string" ? secret : "")) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
    const tenant = params.safeParse(request.params)
    if (!tenant.success) throw new Problem(400, "invalid_tenant", "Identificador da empresa inválido")
    const payload = request.body as any
    const kind = payload?.event_type
    if (typeof kind !== "string" || !(kind.startsWith("submission.") || kind.startsWith("form."))) throw invalid("Evento inválido")
    const external = eventId(kind.startsWith("submission.") ? payload.data?.id : payload.data?.submission_id ?? payload.data?.submission?.id)
    if (external === undefined) throw invalid("Solicitação ausente")
    const tenantId = tenant.data.tenant.toLowerCase()
    // O digest do corpo canônico identifica o evento: reenvio idêntico não repete o efeito.
    const digest = sha256(canonicalJson(payload))
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId])
      const found = await client.query<Contract>("SELECT id,tenant_id,template_id::text,recipients,external_id::text,status,progress,problem FROM commercial_contracts WHERE tenant_id=$1 AND external_id=$2 FOR UPDATE", [tenantId, external])
      // O webhook de criação pode chegar antes da resposta da criação: o provedor repete depois.
      if (!found.rows[0]) { await client.query("COMMIT"); return reply.code(503).header("retry-after", "30").send() }
      const contract = found.rows[0]
      const duplicate = await client.query("SELECT 1 FROM commercial_contract_webhooks WHERE tenant_id=$1 AND contract_id=$2 AND digest=$3", [tenantId, contract.id, digest])
      if (!duplicate.rows.length) {
        try { await reconcile(client, contract, provider) } catch { throw new Retry() }
        await client.query("INSERT INTO commercial_contract_webhooks(tenant_id,contract_id,digest,event_type) VALUES($1,$2,$3,$4)", [tenantId, contract.id, digest, kind])
      }
      await client.query("COMMIT")
      return reply.code(204).send()
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      if (error instanceof Retry) return reply.code(503).send()
      throw error
    } finally { client.release() }
  })
}
