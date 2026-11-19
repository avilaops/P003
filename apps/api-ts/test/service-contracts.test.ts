import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { Pool } from "pg"
import { runServiceBilling } from "../src/modules/services/contracts/billing.js"
import { addMonths, adjustItems, requiredCycles, schedule } from "../src/modules/services/contracts/schedule.js"
import type { ReceivableRequest, ServiceInvoiceRequest, ServicePorts } from "../src/modules/services/ports.contract.js"
import { PgClientAdapter } from "../src/platform/database.js"
import { databaseTestOptions, withTestContext, type TestContext } from "./support/test-context.js"

const permissions = ["service.contracts.read", "service.contracts.manage"]
const body = (customerId: string, extra: Record<string, unknown> = {}) => ({
  customerId, title: "Manutenção mensal", periodicity: "monthly", billingDay: 15, dueDays: 10, startOn: "2026-01-10", endOn: "2026-12-31",
  adjustmentIndex: "ipca", adjustmentBaseOn: "2026-01-10",
  items: [{ description: "Manutenção preventiva", serviceCode: "14.01", quantity: "2", unitCents: 50000 }], ...extra,
})
async function customer(ctx: TestContext, tenant = ctx.tenant, tax = "52998224725") {
  const id = randomUUID()
  await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente','" + tax + "',true,false,'active')", [id, tenant])
  return id
}
// Em produção o GRANT vai para `erp_next_app` (migração); aqui o papel de teste recebe o mesmo direito.
// Pool próprio: `SET ROLE` não pode vazar para a conexão de preparação (`ctx.seed`).
function runtimePool(ctx: TestContext) {
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL!); url.pathname = "/" + ctx.database
  const pool = new Pool({ connectionString: url.href, max: 3 })
  return { async connect() {
    const client = await pool.connect()
    await client.query(`SET ROLE ${ctx.role}`)
    await ctx.seed.query(`GRANT EXECUTE ON FUNCTION erp_service_billing_due_tenants(date) TO ${ctx.role}`)
    const adapter = new PgClientAdapter(client)
    adapter.release = () => client.release(true)
    return adapter
  } }
}
function fakePorts() {
  const invoices: ServiceInvoiceRequest[] = [], titles: ReceivableRequest[] = []
  const ports: ServicePorts = {
    invoices: { async issue(_ctx, request) { if (!invoices.some(r => r.idempotencyKey === request.idempotencyKey)) invoices.push(request); return { status: "issued", reference: "NFSE-" + request.idempotencyKey } } },
    receivables: { async open(_ctx, request) { if (!titles.some(r => r.idempotencyKey === request.idempotencyKey)) titles.push(request); return { status: "issued", reference: "TIT-" + request.idempotencyKey } } },
  }
  return { ports, invoices, titles }
}

test("cronograma: períodos mensais saem no dia de faturamento e o fim de mês não desliza", () => {
  const terms = { startOn: "2026-01-31", endOn: "2026-04-30", periodicity: "monthly" as const, billingDay: 5, dueDays: 10 }
  const periods = schedule(terms, "2026-12-31")
  assert.deepEqual(periods.map(p => p.periodStart), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"])
  assert.equal(periods[0]!.issueOn, "2026-02-05")
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28")
  assert.equal(schedule(terms, "2026-03-05").length, 2)
})
test("reajuste: ciclos pela data-base e taxa em pontos-base sobre o preço unitário", () => {
  assert.equal(requiredCycles("2026-01-10", "2027-01-09"), 0)
  assert.equal(requiredCycles("2026-01-10", "2028-01-10"), 2)
  assert.equal(adjustItems([{ description: "x", serviceCode: "14.01", quantity: "1", unitCents: 10000 }], 452)[0]!.unitCents, 10452)
})

test("GET /api/v1/service-contracts + POST /api/v1/service-contracts [sucesso] cria e lista com service.contracts.read/manage", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const customerId = await customer(ctx), user = ctx.as("user")
    const created = await user.post("/api/v1/service-contracts", { body: body(customerId) })
    assert.equal(created.statusCode, 201, created.body)
    const data = created.json().data
    assert.match(data.number, /^CTS-\d{6}$/)
    assert.equal(data.amountCents, 100000)
    const listed = await user.get("/api/v1/service-contracts")
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.json().total, 1)
    const detail = await user.get("/api/v1/service-contracts/" + data.id)
    assert.equal(detail.statusCode, 200)
    assert.equal(detail.json().data.versions.length, 1)
    assert.equal((await user.get("/api/v1/service-contracts/alerts")).statusCode, 200)
  })
})
test("GET /api/v1/service-contracts + POST /api/v1/service-contracts + GET /api/v1/service-contracts/{id} + GET /api/v1/service-contracts/alerts [negado] sem token, sem permissão e de outra empresa", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const customerId = await customer(ctx)
    const created = (await ctx.as("user").post("/api/v1/service-contracts", { body: body(customerId) })).json().data
    for (const persona of ["anonymous", "denied"] as const) {
      const client = ctx.as(persona), expected = persona === "anonymous" ? 401 : 403
      assert.equal((await client.get("/api/v1/service-contracts")).statusCode, expected)
      assert.equal((await client.get("/api/v1/service-contracts/alerts")).statusCode, expected)
      assert.equal((await client.get("/api/v1/service-contracts/" + created.id)).statusCode, expected)
      assert.equal((await client.post("/api/v1/service-contracts", { body: body(customerId) })).statusCode, expected)
    }
    // `outsider` tem todas as permissões, mas na empresa B: não enxerga o contrato da A.
    const other = ctx.as("outsider")
    assert.equal((await other.get("/api/v1/service-contracts/" + created.id, { tenant: ctx.otherTenant })).statusCode, 404)
    assert.equal((await other.get("/api/v1/service-contracts", { tenant: ctx.otherTenant })).json().total, 0)
    assert.equal((await other.get("/api/v1/service-contracts/" + created.id)).statusCode, 403)
  })
})
test("POST /api/v1/service-contracts [422] rejeita campos desconhecidos, datas invertidas e cliente de outra empresa", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const customerId = await customer(ctx), foreign = await customer(ctx, ctx.otherTenant, "04252011000110".slice(0, 11))
    const user = ctx.as("user")
    assert.equal((await user.post("/api/v1/service-contracts", { body: { ...body(customerId), extra: 1 } })).statusCode, 422)
    assert.equal((await user.post("/api/v1/service-contracts", { body: body(customerId, { endOn: "2025-01-01" }) })).statusCode, 422)
    assert.equal((await user.post("/api/v1/service-contracts", { body: body(customerId, { billingDay: 31 }) })).statusCode, 422)
    assert.equal((await user.post("/api/v1/service-contracts", { body: body(foreign) })).statusCode, 422)
  })
})
test("POST /api/v1/service-contracts [idempotência] repetir a chave não cria outro contrato", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const customerId = await customer(ctx), user = ctx.as("user"), key = randomUUID()
    const first = await user.post("/api/v1/service-contracts", { body: body(customerId), idempotencyKey: key })
    const again = await user.post("/api/v1/service-contracts", { body: body(customerId), idempotencyKey: key })
    assert.equal(again.statusCode, 200)
    assert.equal(again.json().data.id, first.json().data.id)
    assert.equal((await user.get("/api/v1/service-contracts")).json().total, 1)
    assert.equal((await user.post("/api/v1/service-contracts", { body: body(customerId, { title: "Outro" }), idempotencyKey: key })).statusCode, 409)
  })
})

test("POST /api/v1/service-contracts/{id}/transition + amendments + adjustments [sucesso] ativa, versiona e reajusta", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const customerId = await customer(ctx), user = ctx.as("user")
    const created = (await user.post("/api/v1/service-contracts", { body: body(customerId, { adjustmentBaseOn: "2025-06-01" }) })).json().data
    const base = "/api/v1/service-contracts/" + created.id
    const active = await user.post(base + "/transition", { body: { status: "active" }, revision: created.revision })
    assert.equal(active.statusCode, 200, active.body)
    const amended = await user.post(base + "/amendments", { body: { effectiveFrom: "2026-06-01", reason: "Novo item", items: [{ description: "Visita extra", serviceCode: "14.01", quantity: "1", unitCents: 80000 }] }, revision: active.json().data.revision })
    assert.equal(amended.statusCode, 200, amended.body)
    assert.equal(amended.json().data.currentVersion, 2)
    const adjusted = await user.post(base + "/adjustments", { body: { cycle: 1, rateBp: 500, reason: "IPCA acumulado" }, revision: amended.json().data.revision })
    assert.equal(adjusted.statusCode, 200, adjusted.body)
    const detail = (await user.get(base)).json().data
    assert.equal(detail.versions.length, 3)
    assert.equal(detail.amountCents, 84000)
    assert.deepEqual(detail.versions.map((v: { kind: string }) => v.kind), ["adjustment", "amendment", "original"])
    // O histórico é imutável: nenhuma versão é editável.
    await assert.rejects(ctx.seed.query("UPDATE service_contract_versions SET amount_cents=1 WHERE contract_id=$1", [created.id]))
  })
})
test("POST /api/v1/service-contracts/{id}/transition + amendments + adjustments [negado] sem permissão", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const customerId = await customer(ctx)
    const created = (await ctx.as("user").post("/api/v1/service-contracts", { body: body(customerId) })).json().data
    for (const path of ["transition", "amendments", "adjustments"]) {
      assert.equal((await ctx.as("anonymous").post(`/api/v1/service-contracts/${created.id}/${path}`, { body: {}, revision: 1 })).statusCode, 401)
      assert.equal((await ctx.as("denied").post(`/api/v1/service-contracts/${created.id}/${path}`, { body: {}, revision: 1 })).statusCode, 403)
    }
  })
})
test("POST /api/v1/service-contracts/{id}/transition + amendments + adjustments [412/409/422] revisão, estado e entrada", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const customerId = await customer(ctx), user = ctx.as("user")
    const created = (await user.post("/api/v1/service-contracts", { body: body(customerId) })).json().data
    const base = "/api/v1/service-contracts/" + created.id
    assert.equal((await user.post(base + "/transition", { body: { status: "active" }, revision: 99 })).statusCode, 412)
    assert.equal((await user.post(base + "/transition", { body: { status: "active" } })).statusCode, 428)
    assert.equal((await user.post(base + "/transition", { body: { status: "closed" }, revision: 1 })).statusCode, 409)
    assert.equal((await user.post(base + "/adjustments", { body: { cycle: 1, rateBp: 100, reason: "x1" }, revision: 1 })).statusCode, 422)
    const active = (await user.post(base + "/transition", { body: { status: "active" }, revision: 1 })).json().data
    assert.equal((await user.post(base + "/adjustments", { body: { cycle: 2, rateBp: 100, reason: "fora de ordem" }, revision: active.revision })).statusCode, 409)
    assert.equal((await user.post(base + "/amendments", { body: { effectiveFrom: "2030-01-01", reason: "fora", endOn: "2026-12-31" }, revision: active.revision })).statusCode, 422)
    assert.equal((await user.post(base + "/amendments", { body: { reason: "vazio", effectiveFrom: "2026-06-01" }, revision: active.revision })).statusCode, 422)
    assert.equal((await user.post("/api/v1/service-contracts/" + randomUUID() + "/transition", { body: { status: "active" }, revision: 1 })).statusCode, 404)
  })
})

test("Contrato mensal gera a nota e o título do mês na data do cronograma, sem intervenção manual", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const customerId = await customer(ctx), user = ctx.as("user")
    const created = (await user.post("/api/v1/service-contracts", { body: body(customerId, { adjustmentIndex: "none", adjustmentBaseOn: undefined }) })).json().data
    await user.post(`/api/v1/service-contracts/${created.id}/transition`, { body: { status: "active" }, revision: created.revision })
    const { ports, invoices, titles } = fakePorts()
    // Antes da data do cronograma (15/01) nada é gerado.
    assert.deepEqual(await runServiceBilling(runtimePool(ctx), ports, "2026-01-14"), { created: 0, issued: 0, pending: 0, blocked: 0 })
    // No dia 15/01 o job gera a nota e o título de janeiro.
    const jan = await runServiceBilling(runtimePool(ctx), ports, "2026-01-15")
    assert.equal(jan.issued, 1)
    assert.equal(invoices.length, 1); assert.equal(titles.length, 1)
    assert.equal(invoices[0]!.amountCents, 100000)
    assert.deepEqual(invoices[0]!.competence, { start: "2026-01-10", end: "2026-02-09" })
    assert.equal(titles[0]!.dueOn, "2026-01-25")
    // O job é idempotente: repetir o dia e rodar em paralelo não duplica.
    await Promise.all([runServiceBilling(runtimePool(ctx), ports, "2026-01-15"), runServiceBilling(runtimePool(ctx), ports, "2026-01-15")])
    assert.equal(invoices.length, 1); assert.equal(titles.length, 1)
    // Atrasado dois meses: recupera fevereiro e março, uma vez cada.
    await runServiceBilling(runtimePool(ctx), ports, "2026-03-20")
    await runServiceBilling(runtimePool(ctx), ports, "2026-03-20")
    assert.equal(invoices.length, 3)
    const rows = (await ctx.seed.query("SELECT status,count(*)::int AS n FROM service_contract_billings GROUP BY status")).rows
    assert.deepEqual(rows, [{ status: "issued", n: 3 }])
  })
})
test("faturamento recorrente: sem as portas de NFS-e/título o período fica pendente e conclui depois, sem duplicar", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const customerId = await customer(ctx), user = ctx.as("user")
    const created = (await user.post("/api/v1/service-contracts", { body: body(customerId, { adjustmentIndex: "none", adjustmentBaseOn: undefined }) })).json().data
    await user.post(`/api/v1/service-contracts/${created.id}/transition`, { body: { status: "active" }, revision: created.revision })
    assert.equal((await runServiceBilling(runtimePool(ctx), {}, "2026-01-15")).pending, 1)
    const { ports, invoices } = fakePorts()
    assert.equal((await runServiceBilling(runtimePool(ctx), ports, "2026-01-15")).issued, 1)
    assert.equal(invoices.length, 1)
  })
})
test("faturamento recorrente: reajuste vencido bloqueia o período com alerta e regra fiscal incompleta bloqueia com mensagem", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const customerId = await customer(ctx), user = ctx.as("user")
    // Contrato começa em 2026-01-10 com data-base 2025-01-10: o ciclo 1 já venceu em 10/01/2026.
    const created = (await user.post("/api/v1/service-contracts", { body: body(customerId, { adjustmentBaseOn: "2025-01-10" }) })).json().data
    await user.post(`/api/v1/service-contracts/${created.id}/transition`, { body: { status: "active" }, revision: created.revision })
    const { ports, invoices } = fakePorts()
    const run = await runServiceBilling(runtimePool(ctx), ports, "2026-01-15")
    assert.equal(run.blocked, 1)
    assert.equal(invoices.length, 0)
    const alerts = (await user.get("/api/v1/service-contracts/alerts")).json().data as { kind: string; message: string }[]
    assert.ok(alerts.some(a => a.kind === "billing_blocked" && /Reajuste/.test(a.message)))
    assert.ok(alerts.some(a => a.kind === "adjustment"))
    // Registrar o reajuste libera o período na próxima rodada.
    const current = (await user.get("/api/v1/service-contracts/" + created.id)).json().data
    const adjusted = await user.post(`/api/v1/service-contracts/${created.id}/adjustments`, { body: { cycle: 1, rateBp: 450, reason: "IPCA 2025" }, revision: current.revision })
    assert.equal(adjusted.statusCode, 200, adjusted.body)
    assert.equal((await runServiceBilling(runtimePool(ctx), ports, "2026-01-15")).issued, 1)
    assert.equal(invoices[0]!.amountCents, 104500)
    // Regra fiscal incompleta: a porta bloqueia, o ERP não inventa tributação.
    const blocking: ServicePorts = { ...ports, invoices: { async issue() { return { status: "blocked", message: "Município sem alíquota de ISS cadastrada" } } } }
    await runServiceBilling(runtimePool(ctx), blocking, "2026-02-15")
    const stuck = (await ctx.seed.query("SELECT message FROM service_contract_billings WHERE status='blocked'")).rows[0]
    assert.equal(stuck!.message, "Município sem alíquota de ISS cadastrada")
  })
})
test("POST /api/v1/service-contracts/billing-runs [sucesso] executa o faturamento da empresa sob demanda", databaseTestOptions, async () => {
  await withTestContext({ permissions }, async ctx => {
    const customerId = await customer(ctx), user = ctx.as("user")
    const created = (await user.post("/api/v1/service-contracts", { body: body(customerId, { adjustmentIndex: "none", adjustmentBaseOn: undefined }) })).json().data
    await user.post(`/api/v1/service-contracts/${created.id}/transition`, { body: { status: "active" }, revision: created.revision })
    const run = await user.post("/api/v1/service-contracts/billing-runs", { body: {} })
    assert.equal(run.statusCode, 201, run.body)
    assert.ok(run.json().data.created >= 1)
    assert.equal((await ctx.as("denied").post("/api/v1/service-contracts/billing-runs", { body: {} })).statusCode, 403)
    assert.equal((await ctx.as("anonymous").post("/api/v1/service-contracts/billing-runs", { body: {} })).statusCode, 401)
    assert.equal((await user.post("/api/v1/service-contracts/billing-runs", { body: { x: 1 } })).statusCode, 422)
  })
})
