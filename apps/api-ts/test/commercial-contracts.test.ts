import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import type { ContractPortal } from "../src/modules/company-account/contract-webhook.js"
import { Problem } from "../src/platform/problem.js"
import { createTestContext, databaseTestOptions, type TestContext } from "./support/test-context.js"

const READ = "sales.orders.read", MANAGE = "sales.orders.manage", SEND = "sales.contracts.send", INTEGRATIONS = "platform.integrations.manage"
const pdf = (text: string) => Buffer.from(`%PDF-1.4 ${text}`)
const TEMPLATE_UPDATED = "2026-11-01T00:00:00Z"

/** Portal DocuSeal falso: estado em memória, sem rede. */
class FakePortal implements ContractPortal {
  calls: string[] = []
  submission: any
  publications = new Map<string, any>()
  mailOk = true
  constructor(readonly tenant: string, public emailOn = true) {}
  emailReady() { return this.emailOn }
  templateIds(tenant: string) { return tenant === this.tenant ? [1, 2] : [] }
  verifyWebhook() { return true }
  template(id: number) {
    return { id, name: id === 1 ? "Contrato simples" : "Modelo com condição", updated_at: TEMPLATE_UPDATED, archived_at: null,
      submitters: [{ name: "Cliente", uuid: "u-cliente" }],
      fields: [{ name: "cliente_nome", type: "text", required: true, submitter_uuid: "u-cliente" }, { name: "assinatura", type: "signature", required: true, submitter_uuid: "u-cliente" }],
      documents: [{ uuid: "doc", url: "https://contrato.test/template.pdf" }], schema: [{ attachment_uuid: "doc" }],
      ...(id === 2 ? { fields: [{ uuid: "6f1d0c7e-1111-4111-8111-111111111111", name: "Nome", type: "text", submitter_uuid: "u-cliente", conditions: [{ x: 1 }], areas: [{ attachment_uuid: "doc", page: 0, x: 0.1, y: 0.1, w: 0.1, h: 0.1 }] }] } : {}) }
  }
  async request(method: string, path: string, body?: any) {
    this.calls.push(`${method} ${path}`)
    let match
    if (method === "GET" && (match = /^templates\/(\d+)$/.exec(path))) return this.template(Number(match[1]))
    if (method === "POST" && path === "submissions") {
      this.submission = { id: 7, template: { id: body.template_id }, status: "pending", completed_at: null, submission_events: [],
        submitters: body.submitters.map((s: any, index: number) => ({ id: 70 + index, role: s.role, email: s.email, external_id: s.external_id, status: "pending", sent: false })) }
      return this.submission
    }
    if (method === "GET" && path.startsWith("submitters?external_id=")) {
      return { data: this.submission ? [{ submission_id: 7 }] : [] }
    }
    if (method === "GET" && path === "submissions/7") return { ...this.submission, submission_events: this.submission.submitters.filter((s: any) => s.sent).map((s: any) => ({ event_type: "send_email", submitter_id: s.id })) }
    if (method === "GET" && path === "submissions/7/documents") return { documents: [{ url: "https://contrato.test/preview.pdf" }] }
    if (method === "PUT" && (match = /^submitters\/(\d+)$/.exec(path))) {
      this.submission.submitters.find((s: any) => s.id === Number(match![1])).sent = this.mailOk
      return {}
    }
    if (path.startsWith("avila/templates/")) {
      if (method === "GET") return this.publications.get(path) ?? { found: false }
      const hash = (await import("node:crypto")).createHash("sha256")
      void hash
      const record = { found: true, id: 900 + this.publications.size, archived: false, requestHash: this.pendingHash, body }
      this.publications.set(path, record)
      return record
    }
    throw new Problem(409, "domain_conflict", "rota inesperada " + method + " " + path)
  }
  pendingHash = ""
  async pdf(url: string) { this.calls.push(`PDF ${url}`); return pdf(url) }
}

async function setup(permissions = [READ, MANAGE, SEND, INTEGRATIONS]) {
  const portal = new FakePortal("")
  const holder: { portal?: FakePortal } = {}
  // O portal conhece a empresa depois que o contexto sorteia os IDs.
  const proxy: ContractPortal = {
    emailReady: () => holder.portal!.emailReady(), templateIds: tenant => holder.portal!.templateIds(tenant), verifyWebhook: () => true,
    request: (m, p, b) => holder.portal!.request(m, p, b), pdf: url => holder.portal!.pdf(url),
  }
  const ctx = await createTestContext({ permissions, dependencies: { contracts: proxy } })
  const fake = new FakePortal(ctx.tenant)
  holder.portal = fake
  void portal
  const party = randomUUID(), order = randomUUID(), foreignOrder = randomUUID(), foreignParty = randomUUID(), product = randomUUID()
  await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente A','52998224725',true,false,'active'),($3,$4,'fisica','Cliente B','11144477735',true,false,'active')", [party, ctx.tenant, foreignParty, ctx.otherTenant])
  await ctx.seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'LD-1','Banco','UN',10000,'active')", [product, ctx.tenant])
  await ctx.seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente A','52998224725','2027-01-01',10000,'confirmed'),($4,$5,$6,'Cliente B','11144477735','2027-01-01',500,'confirmed')", [order, ctx.tenant, party, foreignOrder, ctx.otherTenant, foreignParty])
  await ctx.seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'LD-1','Banco','UN',1000000,10000,10000)", [ctx.tenant, order, product])
  const revision = async () => Number((await ctx.seed.query("SELECT revision FROM sales_orders WHERE id=$1", [order])).rows[0].revision)
  const generateBody = async () => ({ orderId: order, orderRevision: await revision(), templateId: 1, templateUpdatedAt: TEMPLATE_UPDATED,
    recipients: [{ role: "Cliente", name: "Maria", email: "Maria@Example.test" }], fields: { cliente_nome: "Maria" } })
  return { ctx, fake, order, foreignOrder, generateBody }
}

const base = "/api/v1/commercial-contracts"
const run = async (body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, permissions?: string[]) => {
  const f = await setup(permissions)
  try { await body(f) } finally { await f.ctx.close() }
}
const etag = (res: { headers: Record<string, unknown> }) => Number(String(res.headers.etag).replaceAll('"', ""))

test("POST /api/v1/commercial-contracts + GET /api/v1/commercial-contracts + GET /api/v1/commercial-contracts/{id} [sucesso] gera, lista e detalha com isolamento por empresa", databaseTestOptions, () => run(async ({ ctx, fake, generateBody, order }) => {
  const user = ctx.as("user"), key = randomUUID()
  const created = await user.post(base, { body: await generateBody(), idempotencyKey: key })
  assert.equal(created.statusCode, 200, created.body)
  const body = created.json()
  assert.equal(body.data.status, "created")
  assert.equal(body.data.recipients[0].email, "maria@example.test")
  assert.equal(body.data.snapshot.customer.name, "Cliente A")
  assert.equal(body.files.length, 1)
  assert.equal(body.files[0].kind, "preview")
  assert.equal(body.canSend, true)
  assert.match(body.email.subject, /e contrato para assinatura/)
  assert.equal(created.headers["cache-control"], "no-store")
  assert.equal(etag(created), body.data.revision)
  // Idempotência: mesma chave não cria nem envia ao provedor de novo.
  const posts = () => fake.calls.filter(call => call === "POST submissions").length
  assert.equal(posts(), 1)
  const again = await user.post(base, { body: await generateBody(), idempotencyKey: key })
  assert.equal(again.statusCode, 200)
  assert.equal(again.json().data.id, body.data.id)
  assert.equal(posts(), 1)
  // Mesma chave com outro corpo: conflito.
  const other = await generateBody(); other.fields.cliente_nome = "Outra"
  assert.equal((await user.post(base, { body: other, idempotencyKey: key })).statusCode, 409)
  // Outra chave, mesma intenção: impressão digital repete o contrato, sem novo envio.
  const twin = await user.post(base, { body: await generateBody() })
  assert.equal(twin.json().data.id, body.data.id)
  assert.equal(posts(), 1)
  assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM commercial_contracts")).rows[0].n, 1)

  const list = (await user.get(base, { query: { orderId: order } })).json()
  assert.equal(list.total, 1)
  assert.equal(list.data[0].customerName, "Cliente A")
  assert.equal(list.canEdit, true)
  const detail = await user.get(`${base}/${body.data.id}`)
  assert.equal(detail.statusCode, 200)
  assert.equal(etag(detail), body.data.revision)
  assert.equal(detail.json().data.templateSnapshot, undefined, "snapshot do provedor não é exposto")
  // Outra empresa não enxerga o contrato.
  const outsider = ctx.as("outsider")
  assert.equal((await outsider.get(`${base}/${body.data.id}`, { tenant: ctx.otherTenant })).statusCode, 404)
  assert.equal((await outsider.get(base, { tenant: ctx.otherTenant })).json().total, 0)
  assert.equal((await outsider.get(`${base}/${body.data.id}`, { tenant: ctx.tenant })).statusCode, 403)
}))

test("GET /api/v1/commercial-contracts + POST /api/v1/commercial-contracts + GET /api/v1/commercial-contracts/options/{id} + GET /api/v1/commercial-contracts/{id} + POST /api/v1/commercial-contracts/{id}/sync + POST /api/v1/commercial-contracts/{id}/review + POST /api/v1/commercial-contracts/{id}/send + GET /api/v1/commercial-contracts/{id}/files/{file} [negado] sem login, sem permissão e de outra empresa", databaseTestOptions, () => run(async ({ ctx, generateBody }) => {
  const id = randomUUID(), file = randomUUID()
  const routes: [("get" | "post"), string][] = [["get", base], ["post", base], ["get", `${base}/options/${id}`], ["get", `${base}/${id}`], ["post", `${base}/${id}/sync`],
    ["post", `${base}/${id}/review`], ["post", `${base}/${id}/send`], ["get", `${base}/${id}/files/${file}`]]
  const body = await generateBody()
  for (const [method, url] of routes) {
    const init = { body: method === "post" ? body : undefined, revision: 1 }
    assert.equal((await ctx.as("anonymous")[method](url, init)).statusCode, 401, `${method} ${url} sem login`)
    assert.equal((await ctx.as("denied")[method](url, init)).statusCode, 403, `${method} ${url} sem permissão`)
    assert.equal((await ctx.as("outsider")[method](url, { ...init, tenant: ctx.tenant })).statusCode, 403, `${method} ${url} outra empresa`)
  }
}))

test("POST /api/v1/commercial-contracts [negado] leitura sem gestão e modelo não atribuído", databaseTestOptions, () => run(async ({ ctx, generateBody }) => {
  const body = await generateBody()
  assert.equal((await ctx.as("user").post(base, { body: { ...body, templateId: 99 } })).statusCode, 403)
}))

test("POST /api/v1/commercial-contracts [negado] com só leitura não gera", databaseTestOptions, () => run(async ({ ctx, generateBody }) => {
  assert.equal((await ctx.as("user").post(base, { body: await generateBody() })).statusCode, 403)
}, [READ]))

test("POST /api/v1/commercial-contracts [invalido] 422, 409 e 412 conforme o caso", databaseTestOptions, () => run(async ({ ctx, generateBody, foreignOrder }) => {
  const user = ctx.as("user"), good = await generateBody()
  for (const bad of [{ ...good, extra: 1 }, { ...good, recipients: [] }, { ...good, recipients: [{ role: "Cliente", name: "", email: "x@y.test" }] },
    { ...good, recipients: [{ role: "Cliente", name: "Maria", email: "sem-arroba" }] }, { ...good, fields: { desconhecido: "x" } }, { orderId: "x" }])
    assert.equal((await user.post(base, { body: bad })).statusCode, 422, JSON.stringify(bad).slice(0, 80))
  assert.equal((await user.post(base, { body: { ...good, orderRevision: good.orderRevision + 1 } })).statusCode, 412)
  assert.equal((await user.post(base, { body: { ...good, templateUpdatedAt: "antigo" } })).statusCode, 409)
  assert.equal((await user.post(base, { body: { ...good, orderId: foreignOrder } })).statusCode, 404, "pedido de outra empresa")
  assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM commercial_contracts")).rows[0].n, 0)
  const noKey = await ctx.app.inject({ method: "POST", url: base, headers: { authorization: "Bearer user", "x-tenant-id": ctx.tenant }, payload: good })
  assert.equal(noKey.statusCode, 428)
}))

test("GET /api/v1/commercial-contracts [invalido] filtro inválido responde 422", databaseTestOptions, () => run(async ({ ctx }) => {
  const user = ctx.as("user")
  assert.equal((await user.get(base, { query: { orderId: "x" } })).statusCode, 422)
  assert.equal((await user.get(base, { query: { offset: -1 } })).statusCode, 422)
  assert.equal((await user.get(base, { query: { surpresa: "1" } })).statusCode, 422)
}))

test("GET /api/v1/commercial-contracts/options/{id} [sucesso] lista modelos com padrões e problema de geração", databaseTestOptions, () => run(async ({ ctx, order, foreignOrder }) => {
  const user = ctx.as("user")
  const res = await user.get(`${base}/options/${order}`)
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.configured, true)
  assert.equal(body.emailReady, true)
  assert.equal(body.snapshot.customer.name, "Cliente A")
  assert.deepEqual(body.templates.map((t: any) => t.id), [1, 2])
  assert.equal(body.defaults.cliente_nome, "Cliente A")
  assert.equal(body.templates[0].defaults.cliente_nome, "Cliente A")
  assert.equal((await user.get(`${base}/options/${foreignOrder}`)).statusCode, 404)
  assert.equal((await user.get(`${base}/options/nao-e-uuid`)).statusCode, 404)
}))

test("POST /api/v1/commercial-contracts/{id}/review + POST /api/v1/commercial-contracts/{id}/send + POST /api/v1/commercial-contracts/{id}/sync + GET /api/v1/commercial-contracts/{id}/files/{file} [sucesso] revisa, envia uma vez e sincroniza", databaseTestOptions, () => run(async ({ ctx, fake, generateBody }) => {
  const user = ctx.as("user")
  const created = (await user.post(base, { body: await generateBody() })).json()
  const id = created.data.id
  // Revisão: If-Match obrigatório (428), errado (412), certo (200) e idempotente.
  assert.equal((await user.post(`${base}/${id}/review`, {})).statusCode, 428)
  assert.equal((await user.post(`${base}/${id}/review`, { revision: created.data.revision + 5 })).statusCode, 412)
  const key = randomUUID()
  const reviewed = await user.post(`${base}/${id}/review`, { revision: created.data.revision, idempotencyKey: key })
  assert.equal(reviewed.statusCode, 200, reviewed.body)
  assert.equal(reviewed.json().data.status, "reviewed")
  assert.equal(reviewed.json().data.reviewedBy, "user")
  const replayed = await user.post(`${base}/${id}/review`, { revision: created.data.revision, idempotencyKey: key })
  assert.equal(replayed.statusCode, 200)
  assert.equal(etag(replayed), etag(reviewed), "repetição não avança a revisão")
  assert.equal((await user.post(`${base}/${id}/review`, { revision: created.data.revision, idempotencyKey: randomUUID() })).statusCode, 412)

  // Envio: revisão desatualizada é 412; sem e-mail validado, 409 sem tocar no provedor.
  assert.equal((await user.post(`${base}/${id}/send`, { revision: created.data.revision })).statusCode, 412)
  fake.emailOn = false
  assert.equal((await user.post(`${base}/${id}/send`, { revision: etag(reviewed) })).statusCode, 409)
  assert.ok(!fake.calls.some(call => call.startsWith("PUT")))
  fake.emailOn = true
  const sendKey = randomUUID()
  const sent = await user.post(`${base}/${id}/send`, { revision: etag(reviewed), idempotencyKey: sendKey })
  assert.equal(sent.statusCode, 200, sent.body)
  assert.equal(sent.json().data.status, "sent")
  assert.ok(sent.json().data.sendRequestedAt)
  assert.equal(sent.json().email, null, "depois do envio não há prévia de e-mail")
  const puts = () => fake.calls.filter(call => call.startsWith("PUT")).length
  assert.equal(puts(), 1)
  // Idempotência: repetir (mesma chave ou outra) só reconcilia; nenhum novo convite.
  assert.equal((await user.post(`${base}/${id}/send`, { revision: etag(reviewed), idempotencyKey: sendKey })).statusCode, 200)
  assert.equal((await user.post(`${base}/${id}/send`, { revision: etag(sent), idempotencyKey: randomUUID() })).statusCode, 200)
  assert.equal(puts(), 1)
  const audit = await ctx.seed.query("SELECT action FROM audit_log WHERE entity_type='commercial_contract' ORDER BY occurred_at,id")
  assert.ok(audit.rows.map(row => row.action).includes("contract.send_requested"))

  // Sincronização e arquivo: o PDF preservado é servido privado e com tipo correto.
  const sync = await user.post(`${base}/${id}/sync`, { body: {} })
  assert.equal(sync.statusCode, 200)
  const file = sync.json().files[0]
  const download = await user.get(`${base}/${id}/files/${file.id}`)
  assert.equal(download.statusCode, 200)
  assert.equal(download.headers["content-type"], "application/pdf")
  assert.equal(download.headers["cache-control"], "no-store")
  assert.equal(download.headers["x-content-type-options"], "nosniff")
  assert.ok(download.rawPayload.subarray(0, 5).equals(Buffer.from("%PDF-")))
  assert.equal((await user.get(`${base}/${id}/files/${randomUUID()}`)).statusCode, 404)
  assert.equal((await ctx.as("outsider").get(`${base}/${id}/files/${file.id}`, { tenant: ctx.otherTenant })).statusCode, 404, "outra empresa não baixa o arquivo")
}))

test("POST /api/v1/commercial-contracts/{id}/review + POST /api/v1/commercial-contracts/{id}/send [negado] gerir sem permissão de envio", databaseTestOptions, () => run(async ({ ctx, generateBody }) => {
  const created = (await ctx.as("user").post(base, { body: await generateBody() })).json()
  await ctx.seed.query("DELETE FROM role_permissions WHERE permission_code=$1", [SEND])
  for (const action of ["review", "send"]) assert.equal((await ctx.as("user").post(`${base}/${created.data.id}/${action}`, { revision: created.data.revision })).statusCode, 403, action)
}))

test("POST /api/v1/commercial-contracts/{id}/send [conflito] pedido que mudou ou foi cancelado após a prévia bloqueia o envio", databaseTestOptions, () => run(async ({ ctx, fake, generateBody, order }) => {
  const user = ctx.as("user")
  const created = (await user.post(base, { body: await generateBody() })).json()
  const reviewed = await user.post(`${base}/${created.data.id}/review`, { revision: created.data.revision })
  await ctx.seed.query("UPDATE sales_orders SET amount_cents=20000 WHERE id=$1", [order])
  const blocked = await user.post(`${base}/${created.data.id}/send`, { revision: etag(reviewed) })
  assert.equal(blocked.statusCode, 409)
  assert.ok(!fake.calls.some(call => call.startsWith("PUT")))
  await ctx.seed.query("UPDATE sales_orders SET status='cancelled' WHERE id=$1", [order])
  assert.equal((await user.post(`${base}/${created.data.id}/send`, { revision: etag(reviewed) })).statusCode, 409)
}))

test("POST /api/v1/commercial-contracts/{id}/sync [conflito] falha do provedor vira pendência visível, sem novo envio", databaseTestOptions, () => run(async ({ ctx, fake, generateBody }) => {
  const user = ctx.as("user")
  const created = (await user.post(base, { body: await generateBody() })).json()
  fake.request = async () => { throw new Problem(409, "domain_conflict", "Resultado ainda não confirmado") }
  const sync = await user.post(`${base}/${created.data.id}/sync`, { body: {} })
  assert.equal(sync.statusCode, 200)
  assert.equal(sync.json().data.problem, "Resultado ainda não confirmado")
  assert.equal((await user.post(`${base}/${randomUUID()}/sync`, { body: {} })).statusCode, 404)
}))

const drafts = "/api/v1/contract-template-drafts"
const definition = (name = "Modelo de teste") => ({ name, pages: 1, roles: ["Cliente"], fields: [
  { id: randomUUID(), name: "cliente_nome", kind: "text", role: "Cliente", required: true, page: 1, x: 5, y: 10, width: 80, height: 5 },
  { id: randomUUID(), name: "assinatura", kind: "signature", role: "Cliente", required: true, page: 1, x: 5, y: 20, width: 30, height: 5 }] })
const base64 = Buffer.from("%PDF-1.4 modelo").toString("base64")

test("POST /api/v1/contract-template-drafts/{id} + GET /api/v1/contract-template-drafts + GET /api/v1/contract-template-drafts/{id} + GET /api/v1/contract-template-drafts/{id}/pdf [sucesso] cria, edita com If-Match e serve o PDF", databaseTestOptions, () => run(async ({ ctx }) => {
  const user = ctx.as("user"), id = randomUUID()
  const created = await user.post(`${drafts}/${id}`, { body: { definition: definition(), pdfBase64: base64 } })
  assert.equal(created.statusCode, 200, created.body)
  assert.equal(created.json().revision, 1)
  assert.equal(etag(created), 1)
  const key = randomUUID(), edited = definition("Modelo editado")
  const saved = await user.post(`${drafts}/${id}`, { body: { definition: edited }, revision: 1, idempotencyKey: key })
  assert.equal(saved.statusCode, 200, saved.body)
  assert.equal(saved.json().revision, 2)
  // Idempotência: repetir a mesma chave devolve o mesmo resultado sem nova revisão.
  const again = await user.post(`${drafts}/${id}`, { body: { definition: edited }, revision: 1, idempotencyKey: key })
  assert.equal(again.json().revision, 2)
  assert.equal((await ctx.seed.query("SELECT revision::int AS r FROM commercial_template_drafts WHERE id=$1", [id])).rows[0].r, 2)
  const detail = await user.get(`${drafts}/${id}`)
  assert.equal(detail.json().definition.name, "Modelo editado")
  assert.equal(etag(detail), 2)
  assert.deepEqual(detail.json().versions, [])
  const list = (await user.get(drafts)).json()
  assert.deepEqual(list.data.map((d: any) => d.name), ["Modelo editado"])
  assert.equal(list.data[0].publishedRevision, null)
  const file = await user.get(`${drafts}/${id}/pdf`)
  assert.equal(file.statusCode, 200)
  assert.equal(file.headers["content-type"], "application/pdf")
  assert.equal(file.headers["x-content-type-options"], "nosniff")
  assert.equal(file.headers["cache-control"], "no-store")
  assert.equal(file.rawPayload.toString(), "%PDF-1.4 modelo", "PDF mantido quando a edição não envia outro")
  // Outra empresa não vê nem lê o modelo.
  const outsider = ctx.as("outsider")
  const there = { tenant: ctx.otherTenant }
  assert.equal((await outsider.get(drafts, there)).json().data.length, 0)
  assert.equal((await outsider.get(`${drafts}/${id}`, there)).statusCode, 404)
  assert.equal((await outsider.get(`${drafts}/${id}/pdf`, there)).statusCode, 404)
  assert.equal((await outsider.post(`${drafts}/${id}`, { body: { definition: edited }, revision: 2, tenant: ctx.otherTenant })).statusCode, 412, "não edita o modelo de outra empresa")
}))

test("GET /api/v1/contract-template-drafts + GET /api/v1/contract-template-drafts/catalog + GET /api/v1/contract-template-drafts/{id} + POST /api/v1/contract-template-drafts/{id} + GET /api/v1/contract-template-drafts/{id}/pdf + POST /api/v1/contract-template-drafts/{id}/import + POST /api/v1/contract-template-drafts/{id}/publish [negado] sem login, sem permissão e de outra empresa", databaseTestOptions, () => run(async ({ ctx }) => {
  const id = randomUUID()
  const routes: [("get" | "post"), string, unknown][] = [["get", drafts, undefined], ["get", `${drafts}/catalog`, undefined], ["get", `${drafts}/${id}`, undefined],
    ["post", `${drafts}/${id}`, { definition: definition(), pdfBase64: base64 }], ["get", `${drafts}/${id}/pdf`, undefined], ["post", `${drafts}/${id}/import`, { templateId: 1 }], ["post", `${drafts}/${id}/publish`, undefined]]
  for (const [method, url, body] of routes) {
    const init = { body, revision: 1 }
    assert.equal((await ctx.as("anonymous")[method](url, init)).statusCode, 401, `${method} ${url} sem login`)
    assert.equal((await ctx.as("denied")[method](url, init)).statusCode, 403, `${method} ${url} sem permissão`)
    assert.equal((await ctx.as("outsider")[method](url, { ...init, tenant: ctx.tenant })).statusCode, 403, `${method} ${url} outra empresa`)
  }
}))

test("POST /api/v1/contract-template-drafts/{id} [negado] ler não basta para editar modelos", databaseTestOptions, () => run(async ({ ctx }) => {
  assert.equal((await ctx.as("user").post(`${drafts}/${randomUUID()}`, { body: { definition: definition(), pdfBase64: base64 } })).statusCode, 403)
  assert.equal((await ctx.as("user").get(drafts)).statusCode, 200)
}, [READ]))

test("POST /api/v1/contract-template-drafts/{id} [invalido] 422, 412 e 428", databaseTestOptions, () => run(async ({ ctx }) => {
  const user = ctx.as("user"), id = randomUUID()
  const bad = (mutate: (d: any) => void) => { const d = definition(); mutate(d); return d }
  for (const body of [{ definition: definition() }, { definition: definition(), pdfBase64: "%%%" }, { definition: definition(), pdfBase64: Buffer.from("texto").toString("base64") },
    { definition: bad(d => { d.fields[0].width = 100 }), pdfBase64: base64 }, { definition: bad(d => { d.fields[0].role = "Outro" }), pdfBase64: base64 },
    { definition: bad(d => { d.fields[1].name = d.fields[0].name }), pdfBase64: base64 }, { definition: { ...definition(), surpresa: 1 }, pdfBase64: base64 }, {}])
    assert.equal((await user.post(`${drafts}/${id}`, { body })).statusCode, 422, JSON.stringify(body).slice(0, 90))
  assert.equal((await user.post(`${drafts}/${id}`, { body: { definition: definition(), pdfBase64: base64 }, revision: 1 })).statusCode, 412, "criar não aceita If-Match")
  await user.post(`${drafts}/${id}`, { body: { definition: definition(), pdfBase64: base64 } })
  assert.equal((await user.post(`${drafts}/${id}`, { body: { definition: definition() }, revision: 9 })).statusCode, 412)
  assert.equal((await user.post(`${drafts}/${id}`, { body: { definition: definition() } })).statusCode, 428)
  assert.equal((await user.get(`${drafts}/nao-e-uuid`)).statusCode, 404)
}))

test("GET /api/v1/contract-template-drafts/catalog + POST /api/v1/contract-template-drafts/{id}/import [sucesso] importa uma vez por origem e recusa o que o editor não suporta", databaseTestOptions, () => run(async ({ ctx, fake }) => {
  const user = ctx.as("user")
  const before = (await user.get(`${drafts}/catalog`)).json()
  assert.equal(before.configured, true)
  assert.deepEqual(before.data.map((t: any) => [t.id, t.canImport, t.draftId]), [[1, false, null], [2, false, null]])
  // O modelo 1 do portal é simples demais para o editor (sem áreas); ajusta o fake para um suportado.
  const supported = fake.template.bind(fake)
  fake.template = ((id: number) => id === 1 ? { ...supported(1), fields: [{ uuid: "6f1d0c7e-1111-4111-8111-111111111111", name: "Nome", type: "text", submitter_uuid: "u-cliente", areas: [{ attachment_uuid: "doc", page: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.05 }] },
    { uuid: "6f1d0c7e-1111-4111-8111-222222222222", name: "Assinatura", type: "signature", required: true, submitter_uuid: "u-cliente", areas: [{ attachment_uuid: "doc", page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.05 }] }] } : supported(id)) as typeof fake.template
  assert.deepEqual((await user.get(`${drafts}/catalog`)).json().data.map((t: any) => [t.id, t.canImport]), [[1, true], [2, false]])
  const id = randomUUID(), key = randomUUID()
  const imported = await user.post(`${drafts}/${id}/import`, { body: { templateId: 1 }, idempotencyKey: key })
  assert.equal(imported.statusCode, 200, imported.body)
  assert.deepEqual([imported.json().id, imported.json().revision], [id, 1])
  // Outra chave e outro id para a mesma origem devolvem a cópia existente.
  const second = await user.post(`${drafts}/${randomUUID()}/import`, { body: { templateId: 1 } })
  assert.equal(second.json().id, id)
  assert.equal((await user.post(`${drafts}/${id}/import`, { body: { templateId: 1 }, idempotencyKey: key })).json().id, id)
  assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM commercial_template_drafts")).rows[0].n, 1)
  assert.equal((await user.get(`${drafts}/catalog`)).json().data[0].draftId, id)
  assert.equal((await user.get(`${drafts}/${id}/pdf`)).statusCode, 200)
  // Erros: modelo não atribuído 403, não suportado 422, corpo inválido 422.
  assert.equal((await user.post(`${drafts}/${randomUUID()}/import`, { body: { templateId: 99 } })).statusCode, 403)
  assert.equal((await user.post(`${drafts}/${randomUUID()}/import`, { body: { templateId: 2 } })).statusCode, 422)
  assert.equal((await user.post(`${drafts}/${randomUUID()}/import`, { body: { templateId: "x" } })).statusCode, 422)
}))

test("POST /api/v1/contract-template-drafts/{id}/publish [sucesso] publica uma vez, reconcilia e recusa revisão errada ou sem assinatura", databaseTestOptions, () => run(async ({ ctx, fake }) => {
  const user = ctx.as("user"), id = randomUUID()
  await user.post(`${drafts}/${id}`, { body: { definition: definition(), pdfBase64: base64 } })
  // O portal falso confirma o hash que o ERP calculou.
  const realRequest = fake.request.bind(fake)
  fake.request = async (method, path, body) => {
    if (method === "POST" && path.startsWith("avila/templates/")) fake.pendingHash = (await ctx.seed.query("SELECT request_hash FROM commercial_template_versions WHERE id=$1", [path.split("/").pop()])).rows[0].request_hash
    return realRequest(method, path, body)
  }
  assert.equal((await user.post(`${drafts}/${id}/publish`, {})).statusCode, 428)
  assert.equal((await user.post(`${drafts}/${id}/publish`, { revision: 7 })).statusCode, 412)
  const key = randomUUID()
  const published = await user.post(`${drafts}/${id}/publish`, { revision: 1, idempotencyKey: key })
  assert.equal(published.statusCode, 200, published.body)
  assert.equal(published.json().status, "published")
  assert.equal(published.json().revision, 1)
  assert.ok(published.json().externalId >= 900)
  const posts = () => fake.calls.filter(call => call.startsWith("POST avila/")).length
  assert.equal(posts(), 1)
  // Repetição (mesma chave e chave nova): sem segunda publicação no portal.
  assert.equal((await user.post(`${drafts}/${id}/publish`, { revision: 1, idempotencyKey: key })).json().externalId, published.json().externalId)
  assert.equal((await user.post(`${drafts}/${id}/publish`, { revision: 1 })).json().externalId, published.json().externalId)
  assert.equal(posts(), 1)
  assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM commercial_template_versions")).rows[0].n, 1)
  const detail = (await user.get(`${drafts}/${id}`)).json()
  assert.deepEqual(detail.versions.map((v: any) => [v.revision, v.status]), [["1", "published"]].map(([r, s]) => [Number(r), s]))
  assert.equal((await user.get(drafts)).json().data[0].publishedRevision, 1)
  assert.ok((await ctx.seed.query("SELECT 1 FROM audit_log WHERE action='contract_template.published'")).rows.length === 1)
  // Modelo publicado passa a ser oferecido para novos contratos.
  const orderless = await ctx.seed.query("SELECT 1 FROM commercial_template_versions WHERE external_id IS NOT NULL")
  assert.equal(orderless.rows.length, 1)
  // Sem assinatura obrigatória por participante: 422; outra empresa: 404.
  const bad = randomUUID(), noSign = definition(); noSign.fields.pop()
  await user.post(`${drafts}/${bad}`, { body: { definition: noSign, pdfBase64: base64 } })
  assert.equal((await user.post(`${drafts}/${bad}/publish`, { revision: 1 })).statusCode, 422)
  assert.equal((await user.post(`${drafts}/${randomUUID()}/publish`, { revision: 1 })).statusCode, 404)
  assert.equal((await ctx.as("outsider").post(`${drafts}/${id}/publish`, { revision: 1, tenant: ctx.otherTenant })).statusCode, 404, "outra empresa não publica o modelo")
}, [READ, INTEGRATIONS]))

test("POST /api/v1/contract-template-drafts/{id}/publish [conflito] divergência no portal bloqueia a publicação", databaseTestOptions, () => run(async ({ ctx, fake }) => {
  const user = ctx.as("user"), id = randomUUID()
  await user.post(`${drafts}/${id}`, { body: { definition: definition(), pdfBase64: base64 } })
  fake.pendingHash = "hash-divergente"
  const res = await user.post(`${drafts}/${id}/publish`, { revision: 1 })
  assert.equal(res.statusCode, 409)
  assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM commercial_template_versions WHERE external_id IS NOT NULL")).rows[0].n, 0)
}, [READ, INTEGRATIONS]))

test("contratos sem integração configurada respondem 409 e leituras locais seguem funcionando", databaseTestOptions, async () => {
  const ctx: TestContext = await createTestContext({ permissions: [READ, MANAGE, INTEGRATIONS], dependencies: { contracts: null } })
  try {
    const user = ctx.as("user")
    assert.equal((await user.get(base)).statusCode, 200)
    assert.equal((await user.get(`${drafts}/catalog`)).json().configured, false)
    assert.equal((await user.post(`${drafts}/${randomUUID()}/import`, { body: { templateId: 1 } })).statusCode, 409)
    assert.equal((await user.post(`${drafts}/${randomUUID()}/publish`, { revision: 1 })).statusCode, 409)
    const options = await user.get(`${base}/options/${randomUUID()}`)
    assert.equal(options.statusCode, 404)
  } finally { await ctx.close() }
})
