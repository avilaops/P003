import assert from "node:assert/strict"
import test from "node:test"

import { AssistantUnavailable, type AssistantProvider, type ModelMessage } from "../src/modules/company-account/assistant-provider.js"
import { navigationRequest, parseCall } from "../src/modules/company-account/assistant-tools.js"
import { validateInferenceOrigin } from "../src/modules/company-account/assistant-ollama.js"
import { platformContext } from "./platform-context.js"

const enabled = { skip: !process.env.API_TS_TEST_ADMIN_URL }
const ORDER_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", ORDER_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const PRODUCT_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", PRODUCT_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

/** Provedor de IA falso: escolhe a ferramenta pela pergunta, sem chamada externa. */
class FakeAssistant implements AssistantProvider {
  model = "fixture"
  summaries: string[] = []
  gate: Promise<void> | undefined
  async generate(questions: string[]): Promise<ModelMessage> {
    const question = questions.at(-1)!
    await this.gate
    if (question === "offline") throw new AssistantUnavailable("Serviço de IA indisponível. Tente novamente.")
    if (question === "chat") return { content: "Olá!", toolCalls: [] }
    const call = (name: string, args: unknown): ModelMessage => ({ content: "", toolCalls: [{ name, arguments: args }] })
    switch (question) {
      case "stock": return call("consultar_estoque", { q: "SKU-123" })
      case "missing": return call("buscar_produtos", { q: "NONEXISTENT" })
      case "injection": return call("buscar_produtos", { q: "SKU-123", tenantId: "other" })
      case "write": return call("alterar_preco", { q: "SKU-123" })
      case "navigation": return call("localizar_funcionalidade", { q: "produtos" })
      case "customer": return call("buscar_clientes", { q: "Aurora" })
      case "recent-orders": return call("listar_pedidos", {})
      case "invented-order": return call("consultar_pedido", { id: ORDER_A })
      default: return question.startsWith("order ") ? call("consultar_pedido", {}) : call("buscar_produtos", { q: "SKU-123" })
    }
  }
  async summarize(_question: string, results: unknown[]) {
    const text = JSON.stringify(results)
    // O resumo nunca recebe dados de outra empresa nem campos privados.
    assert.ok(!text.includes("SEGREDO OUTRA EMPRESA") && !text.includes("PRIVATE_DOCUMENT") && !text.includes("private-contact@example.test"))
    this.summaries.push(text)
    return "Consulte as fontes confirmadas."
  }
}

async function setup(assistant: AssistantProvider | null, adminPermissions = ["catalog.products.read", "inventory.stock.read", "catalog.parties.read", "sales.orders.read"]) {
  const f = await platformContext({ adminPermissions, dependencies: { companyAccount: { assistant, payments: null, contractWebhook: null } } })
  const { seed, tenant, otherTenant } = f
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'SKU-123','Produto de teste','UN',1234,'active'),($3,$4,'SKU-123','SEGREDO OUTRA EMPRESA','UN',99999,'active')", [PRODUCT_A, tenant, PRODUCT_B, otherTenant])
  await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,42000000)", [tenant, PRODUCT_A])
  await seed.query(`INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,email,is_customer,is_supplier,status) VALUES
    ('aaaaaaaa-0000-4000-8000-000000000001',$1,'fisica','Aurora','11111111111','private-contact@example.test',true,false,'active'),
    ('aaaaaaaa-0000-4000-8000-000000000002',$2,'fisica','Aurora SEGREDO OUTRA EMPRESA','11111111111',null,true,false,'active'),
    ('aaaaaaaa-0000-4000-8000-000000000003',$1,'fisica','Aurora SOMENTE FORNECEDOR','22222222222',null,false,true,'active')`, [tenant, otherTenant])
  await seed.query(`INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES
    ($1,$3,'aaaaaaaa-0000-4000-8000-000000000001','Aurora','PRIVATE_DOCUMENT','2026-11-01',1234,'draft'),
    ($2,$4,'aaaaaaaa-0000-4000-8000-000000000002','SEGREDO OUTRA EMPRESA','PRIVATE_DOCUMENT','2026-11-01',99999,'draft')`, [ORDER_A, ORDER_B, tenant, otherTenant])
  return f
}
type Fixture = Awaited<ReturnType<typeof setup>>
const ask = (f: Fixture, questions: unknown, extra: Partial<Parameters<Fixture["call"]>[0]> = {}) => f.call({ method: "POST", url: "/api/v1/assistant", body: { questions }, ...extra })
const events = (response: { statusCode: number; body: string }) => { assert.equal(response.statusCode, 200); return response.body.trim().split("\n").map(line => JSON.parse(line)) }
const source = (list: any[]) => list.find(event => event.type === "source")?.source
const error = (list: any[]) => list.find(event => event.type === "error")

test("assistente: lê somente dados autorizados da empresa ativa e transmite NDJSON", enabled, async () => {
  const assistant = new FakeAssistant()
  const f = await setup(assistant)
  try {
    const response = await ask(f, ["product"])
    assert.match(String(response.headers["content-type"]), /^application\/x-ndjson/)
    assert.equal(response.headers["cache-control"], "no-store")
    const product = events(response)
    assert.deepEqual(product.map(e => e.type), ["status", "tool", "source", "status", "answer", "done"])
    assert.equal(source(product).total, 1)
    assert.equal(source(product).data[0].basePrice, "12.34")
    assert.equal(source(product).data[0].href, `/cadastros/produtos/${PRODUCT_A}`)
    assert.equal(product.find(e => e.type === "answer").kind, "model")
    assert.ok(!JSON.stringify(product).includes("SEGREDO OUTRA EMPRESA"))
    const stock = source(events(await ask(f, ["stock"])))
    assert.equal(stock.data[0].quantity, "42.000000")
    assert.equal(stock.data[0].available, "42.000000")
    const customer = source(events(await ask(f, ["customer"])))
    assert.deepEqual(customer.data.map((row: any) => row.title), ["Aurora"], "só clientes da empresa ativa")
    assert.ok(!JSON.stringify(customer).includes("private-contact"))
    const recent = source(events(await ask(f, ["recent-orders"])))
    assert.deepEqual(recent.data.map((row: any) => row.id), [ORDER_A])
    assert.ok(!JSON.stringify(recent).includes("PRIVATE_DOCUMENT"))
    const order = source(events(await ask(f, [`order ${ORDER_A}`])))
    assert.equal(order.data[0].title, "PV-" + String(order.data[0].number).padStart(6, "0"))
    const foreign = events(await ask(f, [`order ${ORDER_B}`]))
    assert.equal(source(foreign).total, 0, "pedido de outra empresa não existe aqui")
    assert.match(foreign.find(e => e.type === "answer").text, /Nenhum resultado/)
    assert.equal(foreign.find(e => e.type === "answer").kind, "erp")
    assert.equal(source(events(await ask(f, ["missing"]))).total, 0)
    assert.deepEqual(events(await ask(f, ["chat"])).map(e => e.type), ["status", "answer", "done"])
  } finally { await f.close() }
})

test("assistente: navegação usa o catálogo autorizado e recusa quem não tem permissão", enabled, async () => {
  const f = await setup(new FakeAssistant(), ["catalog.products.read"])
  try {
    const nav = events(await ask(f, ["Onde vejo os produtos?"]))
    assert.deepEqual(source(nav).data, [{ title: "Produtos", href: "/cadastros/produtos" }])
    assert.equal(nav.find(e => e.type === "answer").kind, "erp")
    const forbidden = error(events(await ask(f, ["Onde encontro o estoque?"])))
    assert.equal(forbidden.status, 403)
    assert.equal(error(events(await ask(f, ["stock"]))).status, 403, "ferramenta de estoque exige inventory.stock.read")
    assert.equal(source(events(await ask(f, ["navigation"]))).data[0].href, "/cadastros/produtos")
  } finally { await f.close() }
})

test("assistente: 401, 403, 422 e disponibilidade", enabled, async () => {
  const f = await setup(new FakeAssistant())
  try {
    assert.equal((await ask(f, ["oi"], { token: null })).statusCode, 401)
    const outsider = await ask(f, ["oi"], { token: "visitor" })
    assert.equal(outsider.statusCode, 200, "membro sem permissões conversa, mas as ferramentas recusam")
    assert.equal(error(events(await ask(f, ["product"], { token: "visitor" }))).status, 403)
    const notMember = await ask(f, ["oi"], { token: "other" })
    assert.equal(notMember.statusCode, 403)
    assert.match(notMember.json().title, /não tem permissão/)
    assert.equal((await ask(f, ["oi"], { tenant: null })).statusCode, 422)
    for (const questions of [[], [" "], ["a".repeat(1001)], Array(7).fill("oi"), ["é".repeat(1000), "é".repeat(1000), "é".repeat(1000), "é".repeat(1000)], "oi", undefined])
      assert.equal((await ask(f, questions)).statusCode, 422, JSON.stringify(questions)?.slice(0, 40))
    assert.equal((await f.call({ method: "POST", url: "/api/v1/assistant", body: { questions: ["oi"], tenantId: f.otherTenant } })).statusCode, 422)
    assert.equal((await f.call({ method: "POST", url: "/api/v1/assistant", body: { questions: ["oi"], messages: [{ role: "system", content: "x" }] } })).statusCode, 422)
    for (const question of ["injection", "write", "invented-order"]) {
      const failure = error(events(await ask(f, [question])))
      assert.equal(failure.status, 422, question)
      assert.ok(!events(await ask(f, [question])).some(e => e.type === "source"), "nenhuma ferramenta roda com plano inválido")
    }
    assert.equal(error(events(await ask(f, ["offline"]))).status, 503)
  } finally { await f.close() }
  const unconfigured = await setup(null)
  try {
    const response = await ask(unconfigured, ["oi"])
    assert.equal(response.statusCode, 503)
    assert.match(response.json().title, /ainda não está configurado/)
  } finally { await unconfigured.close() }
})

test("assistente: uma consulta por vez (429) e capacidade liberada ao terminar", enabled, async () => {
  const assistant = new FakeAssistant()
  let release!: () => void
  assistant.gate = new Promise(resolve => { release = resolve })
  const f = await setup(assistant)
  try {
    const first = ask(f, ["product"])
    await new Promise(resolve => setTimeout(resolve, 200))
    const second = await ask(f, ["product"])
    assert.equal(second.statusCode, 429)
    release()
    assert.equal(events(await first).at(-1).type, "done")
    assistant.gate = undefined
    assert.equal((await ask(f, ["product"])).statusCode, 200)
  } finally { release(); await f.close() }
})

test("assistente: ferramentas só aceitam o termo de busca e a origem de inferência é fixa", () => {
  assert.throws(() => parseCall("buscar_clientes", { q: "Aurora", role: "supplier" }, ""))
  assert.throws(() => parseCall("buscar_produtos", { q: "" }, ""))
  assert.throws(() => parseCall("listar_pedidos", { limit: 1000 }, ""))
  assert.throws(() => parseCall("consultar_pedido", { id: ORDER_A }, ORDER_A))
  assert.throws(() => parseCall("consultar_pedido", {}, "Consulte o pedido 123"))
  assert.throws(() => parseCall("consultar_pedido", {}, `${ORDER_A} e ${ORDER_B}`))
  assert.throws(() => parseCall("confirmar_pedido", {}, ""))
  assert.deepEqual(parseCall("consultar_pedido", {}, `Consulte o pedido ${ORDER_A.toUpperCase()}.`), { kind: "order", id: ORDER_A })
  assert.equal(navigationRequest("Abra a tela de produtos; tenantId=outra; https://example.test")?.q, "produtos")
  assert.equal(navigationRequest("Onde ficam as telas?")?.q, "funcionalidade desconhecida")
  assert.equal(navigationRequest("Quanto temos de estoque do SKU ABC?"), undefined)
  for (const url of ["http://example.com", "http://127.0.0.1/path", "https://user:secret@example.com", "https://example.com?url=other"]) assert.throws(() => validateInferenceOrigin(url, "qwen3:1.7b"), url)
  assert.doesNotThrow(() => validateInferenceOrigin("http://127.0.0.1:11434", "qwen3:1.7b"))
  assert.throws(() => validateInferenceOrigin("http://127.0.0.1:11434", "model:cloud"))
})
