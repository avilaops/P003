import assert from "node:assert/strict"
import test from "node:test"

import { DocuSeal, type ContractProvider } from "../src/modules/company-account/contract-webhook.js"
import { platformContext } from "./platform-context.js"

const enabled = { skip: !process.env.API_TS_TEST_ADMIN_URL }
const SECRET = "fixture-webhook-secret-with-32-chars!!"
const PARTY = "aaaaaaaa-0000-4000-8000-000000000001", ORDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", CONTRACT = "cccccccc-0000-4000-8000-000000000001"
const pdf = (text: string) => Buffer.from(`%PDF-1.4 ${text}`)

/** Portal de contratos falso: estado controlado pelo teste, sem rede. */
class FakePortal implements ContractProvider {
  completed = false
  requests: string[] = []
  pdfs: string[] = []
  fail = false
  email = "Cliente@example.test"
  constructor(public tenant: string, private readonly contract: string) {}
  verifyWebhook(candidate: string) { return candidate === SECRET }
  async request(_method: "GET", path: string) {
    this.requests.push(path)
    if (this.fail) throw new Error("portal fora do ar")
    if (path === "submissions/7") return { id: 7, template: { id: 1 }, status: this.completed ? "completed" : "pending", completed_at: this.completed ? "2026-10-29T01:00:00Z" : null,
      audit_log_url: this.completed ? "https://contrato.test/audit.pdf" : undefined,
      submitters: [{ id: 1, role: "Cliente", email: this.email, status: this.completed ? "completed" : "sent", external_id: `erp:${this.tenant}:${this.contract}:0`, completed_at: this.completed ? "2026-10-29T01:00:00Z" : null }],
      submission_events: [{ event_type: "send_email", submitter_id: 1 }] }
    if (path === "submissions/7/documents") return { documents: [{ url: "https://contrato.test/doc-1.pdf" }] }
    throw new Error("rota inesperada " + path)
  }
  async pdf(url: string) { this.pdfs.push(url); return pdf(url) }
}

async function setup() {
  const portal = new FakePortal("", CONTRACT)
  const f = await platformContext({ adminPermissions: ["platform.company.read"], dependencies: { companyAccount: { contractWebhook: portal, payments: null, assistant: null } } })
  portal.tenant = f.tenant // o helper sorteia as empresas
  for (const tenant of [f.tenant, f.otherTenant]) {
    const party = tenant === f.tenant ? PARTY : "aaaaaaaa-0000-4000-8000-000000000002", order = tenant === f.tenant ? ORDER : "dddddddd-dddd-4ddd-8ddd-ddddddddddd2"
    await f.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente','52998224725',true,false,'active')", [party, tenant])
    await f.seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','52998224725','2027-01-01',1000,'draft')", [order, tenant, party])
  }
  await f.seed.query(`INSERT INTO commercial_contracts(id,tenant_id,customer_id,order_id,template_id,template_name,template_snapshot,snapshot,recipients,fields,fingerprint,external_id,status)
    VALUES($1,$2,$3,$4,1,'Modelo','{}','{}',$5,'{}','fp-1',7,'created')`, [CONTRACT, f.tenant, PARTY, ORDER, JSON.stringify([{ role: "Cliente", name: "Cliente", email: "cliente@example.test" }])])
  const hook = (body: unknown, extra: { secret?: string | null; tenant?: string } = {}) => f.app.inject({ method: "POST", url: `/api/v1/webhooks/contracts/${extra.tenant ?? f.tenant}`,
    headers: { "content-type": "application/json", ...(extra.secret === null ? {} : { "x-avila-contract-secret": extra.secret ?? SECRET }) }, payload: JSON.stringify(body) })
  const state = async () => (await f.seed.query("SELECT status,revision::int AS revision,external_id::int AS external FROM commercial_contracts WHERE id=$1", [CONTRACT])).rows[0]
  const files = async () => (await f.seed.query("SELECT kind,position FROM commercial_contract_files WHERE contract_id=$1 ORDER BY kind,position", [CONTRACT])).rows
  return { ...f, portal, hook, state, files }
}

test("webhook de contratos: público, valida o segredo e reconcilia pelo estado do provedor", enabled, async () => {
  const f = await setup()
  try {
    const event = { event_type: "submission.created", timestamp: "2026-10-29T00:00:00Z", data: { id: 7 } }
    // Sem Bearer, mas com segredo inválido ou ausente: 403 e nenhuma consulta ao provedor.
    assert.equal((await f.hook(event, { secret: null })).statusCode, 403)
    assert.equal((await f.hook(event, { secret: "errado" })).statusCode, 403)
    assert.equal((await f.hook({})).statusCode, 422)
    assert.equal(f.portal.requests.length, 0)
    const first = await f.hook(event)
    assert.equal(first.statusCode, 204)
    assert.equal((await f.state()).status, "sent", "envio confirmado pelo evento send_email")
    assert.deepEqual(await f.files(), [{ kind: "preview", position: 0 }])
    // Ignora as alegações do corpo: o estado vem do provedor.
    f.portal.completed = true
    assert.equal((await f.hook({ event_type: "submission.completed", data: { id: 7 } })).statusCode, 204)
    const done = await f.state()
    assert.equal(done.status, "completed")
    assert.deepEqual(await f.files(), [{ kind: "audit", position: 0 }, { kind: "preview", position: 0 }, { kind: "signed", position: 0 }])
    const trail = await f.seed.query("SELECT action FROM audit_log WHERE tenant_id=$1 AND entity_type='commercial_contract' ORDER BY occurred_at,id", [f.tenant])
    assert.deepEqual(trail.rows.map(row => row.action), ["contract.reconciled", "contract.reconciled"])
  } finally { await f.close() }
})

test("webhook de contratos: evento repetido não duplica efeito; evento form.* e entradas inválidas", enabled, async () => {
  const f = await setup()
  try {
    const event = { event_type: "submission.completed", timestamp: "t", data: { id: 7 } }
    f.portal.completed = true
    assert.equal((await f.hook(event)).statusCode, 204)
    const requests = f.portal.requests.length, revision = (await f.state()).revision
    for (let i = 0; i < 3; i++) assert.equal((await f.hook(event)).statusCode, 204)
    assert.equal(f.portal.requests.length, requests, "reenvio idêntico não consulta o provedor")
    assert.equal((await f.state()).revision, revision)
    const webhooks = await f.seed.query("SELECT count(*)::int AS n FROM commercial_contract_webhooks WHERE contract_id=$1", [CONTRACT])
    assert.equal(webhooks.rows[0].n, 1)
    // Outro evento do mesmo contrato reconcilia de novo, mas sem alterar nada já convergido.
    assert.equal((await f.hook({ event_type: "form.completed", data: { submission_id: 7 } })).statusCode, 204)
    assert.equal((await f.hook({ event_type: "form.viewed", data: { submission: { id: 7 } } })).statusCode, 204)
    assert.equal((await f.state()).revision, revision)
    for (const body of [{ event_type: "outro.evento", data: { id: 7 } }, { event_type: 5 }, { event_type: "submission.created", data: {} }, { event_type: "submission.created", data: { id: "7" } }])
      assert.equal((await f.hook(body)).statusCode, 422, JSON.stringify(body))
    assert.equal((await f.hook({ event_type: "submission.created", data: { id: 7 } }, { tenant: "nao-uuid" })).statusCode, 400)
  } finally { await f.close() }
})

test("webhook de contratos: isola empresas, pede repetição se o contrato é desconhecido ou o portal falha", enabled, async () => {
  const f = await setup()
  try {
    const event = { event_type: "submission.created", data: { id: 7 } }
    // A solicitação 7 pertence à empresa A; na empresa B o webhook não a encontra e pede repetição.
    const other = await f.hook(event, { tenant: f.otherTenant })
    assert.equal(other.statusCode, 503)
    assert.equal(other.headers["retry-after"], "30")
    assert.equal(f.portal.requests.length, 0)
    assert.equal((await f.hook({ event_type: "submission.created", data: { id: 999 } })).statusCode, 503)
    // Falha do provedor: 503, nada gravado e o evento não fica marcado como processado.
    f.portal.fail = true
    assert.equal((await f.hook(event)).statusCode, 503)
    assert.equal((await f.state()).revision, 1)
    assert.equal((await f.files()).length, 0)
    f.portal.fail = false
    assert.equal((await f.hook(event)).statusCode, 204, "a repetição do provedor é processada")
    // Provedor devolvendo outro destinatário bloqueia a reconciliação.
    f.portal.email = "outro@example.test"
    assert.equal((await f.hook({ event_type: "submission.opened", data: { id: 7 } })).statusCode, 503)
    assert.equal((await f.state()).status, "sent")
  } finally { await f.close() }
})

test("webhook de contratos: sem integração configurada responde 409 e DocuSeal compara segredo e origem", enabled, async () => {
  const f = await platformContext({ adminPermissions: ["platform.company.read"], dependencies: { companyAccount: { contractWebhook: null, payments: null, assistant: null } } })
  try {
    const response = await f.app.inject({ method: "POST", url: `/api/v1/webhooks/contracts/${f.tenant}`, headers: { "content-type": "application/json" }, payload: "{}" })
    assert.equal(response.statusCode, 409)
  } finally { await f.close() }
  const base = new URL("https://contrato.avilaops.com")
  const docuseal = new DocuSeal(base, "token-token-token-token", SECRET, async () => { throw new Error("sem rede em teste") })
  assert.equal(docuseal.verifyWebhook(SECRET), true)
  assert.equal(docuseal.verifyWebhook(SECRET + "x"), false)
  assert.equal(docuseal.verifyWebhook(""), false)
})
