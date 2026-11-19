import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { inflateRawSync } from "node:zlib"
import test from "node:test"
import { Pool } from "pg"
import { PgClientAdapter, type DatabasePool } from "../src/platform/database.js"
import type { DocumentMail } from "../src/platform/document-mail.js"
import { resolvePeriod, validateLayout } from "../src/modules/reports/engine/definition.js"
import { toCsv, toXlsx } from "../src/modules/reports/engine/export.js"
import { reportSources } from "../src/modules/reports/engine/registry.js"
import type { ReportResult } from "../src/modules/reports/engine/run.js"
import { nextRunAt, processDueReports, type ReportMailer } from "../src/modules/reports/engine/schedule.js"
import { databaseTestOptions, withTestContext, type TestContext } from "./support/test-context.js"

// ---------- Unidades (sem banco) ----------

const sample: ReportResult = {
  title: "Vendas", source: "sales_orders", sourceLabel: "Vendas por período", generatedAt: "2026-11-19T12:00:00Z", filters: [], sourceRows: 2,
  columns: [{ key: "customer", label: "Cliente", type: "text" }, { key: "issued_on", label: "Emissão", type: "date" }, { key: "amount", label: "Valor (R$)", type: "money" }],
  rows: [{ customer: "=HYPERLINK(1)", issued_on: "2026-11-02", amount: 123456 }, { customer: "Ana", issued_on: "2026-11-03", amount: 100 }],
  totals: { count: 2, sum_amount: 123556 }, totalColumns: [{ key: "count", label: "Quantidade", type: "number" }, { key: "sum_amount", label: "Soma de Valor (R$)", type: "money" }], rowCount: 2,
}

test("exportação CSV: padrão brasileiro, BOM, totais e fórmulas neutralizadas", () => {
  const csv = toCsv(sample).toString("utf8")
  assert.ok(csv.startsWith("﻿\"Cliente\";\"Emissão\";\"Valor (R$)\""))
  assert.match(csv, /"'=HYPERLINK\(1\)";"02\/11\/2026";"1\.234,56"/)
  assert.match(csv, /"Soma de Valor \(R\$\)";"1\.235,56"/)
})

/** Lê as entradas de um ZIP (somente o que o escritor mínimo gera). */
function unzip(buffer: Buffer) {
  const files = new Map<string, string>()
  for (let offset = 0; buffer.readUInt32LE(offset) === 0x04034b50;) {
    const size = buffer.readUInt32LE(offset + 18), nameLength = buffer.readUInt16LE(offset + 26)
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8")
    const data = buffer.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size)
    files.set(name, inflateRawSync(data).toString("utf8"))
    offset += 30 + nameLength + size
  }
  return files
}
test("exportação XLSX: pacote OOXML válido com números como número e valores em reais", () => {
  const files = unzip(toXlsx(sample))
  assert.deepEqual([...files.keys()].sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"])
  const sheet = files.get("xl/worksheets/sheet1.xml")!
  assert.match(sheet, /<c r="C2" s="2"><v>1234.56<\/v><\/c>/)
  assert.match(sheet, /<t xml:space="preserve">=HYPERLINK\(1\)<\/t>/, "texto inline nunca vira fórmula no XLSX")
})

test("agenda: próxima ocorrência diária, semanal e mensal no horário de Brasília", () => {
  const after = new Date("2026-11-19T12:00:00Z") // quinta, 09:00 em Brasília
  assert.equal(nextRunAt({ frequency: "daily", weekday: null, monthDay: null, hour: 8 }, after).toISOString(), "2026-11-20T11:00:00.000Z")
  assert.equal(nextRunAt({ frequency: "daily", weekday: null, monthDay: null, hour: 10 }, after).toISOString(), "2026-11-19T13:00:00.000Z")
  assert.equal(nextRunAt({ frequency: "weekly", weekday: 1, monthDay: null, hour: 7 }, after).toISOString(), "2026-11-23T10:00:00.000Z")
  assert.equal(nextRunAt({ frequency: "monthly", weekday: null, monthDay: 1, hour: 6 }, after).toISOString(), "2026-12-01T09:00:00.000Z")
  assert.equal(nextRunAt({ frequency: "daily", weekday: null, monthDay: null, hour: 23 }, new Date("2026-11-20T01:30:00Z")).toISOString(), "2026-11-20T02:00:00.000Z", "22:30 de Brasília → 23:00 do mesmo dia")
})

test("períodos relativos: mês anterior, últimos 7 dias e ano corrente", () => {
  assert.deepEqual(resolvePeriod({ preset: "previous_month" }, "2026-01-15"), { from: "2025-12-01", to: "2025-12-31" })
  assert.deepEqual(resolvePeriod({ preset: "last_7_days" }, "2026-03-02"), { from: "2026-02-24", to: "2026-03-02" })
  assert.deepEqual(resolvePeriod({ preset: "current_year" }, "2026-03-02"), { from: "2026-01-01", to: "2026-03-02" })
})

test("layout: só aceita colunas, agrupamentos, totais e filtros declarados pela fonte", () => {
  const source = reportSources.get("sales_orders")!
  const ok = validateLayout(source, { columns: ["customer", "amount"], groupBy: ["status"], totals: [{ column: "amount", fn: "sum" }], filters: { status: "confirmed", customer: "  " } })
  assert.deepEqual(ok.filters, { status: "confirmed", period: { preset: "last_30_days" } }, "texto vazio é ignorado; período obrigatório recebe padrão")
  for (const bad of [
    { columns: ["amount; DROP TABLE x"], groupBy: [], totals: [], filters: {} },
    { columns: ["amount"], groupBy: ["amount"], totals: [], filters: {} },
    { columns: ["amount"], groupBy: [], totals: [{ column: "customer", fn: "sum" as const }], filters: {} },
    { columns: ["amount"], groupBy: [], totals: [], filters: { tenant_id: "x" } },
    { columns: ["amount"], groupBy: [], totals: [], filters: { status: "x" } },
    { columns: ["amount"], groupBy: [], totals: [], filters: { period: { preset: "custom", from: "2026-02-10", to: "2026-02-01" } } },
  ]) assert.throws(() => validateLayout(source, bad), { status: 422 })
})

// ---------- Integração (PostgreSQL real, helper #284) ----------

const reader = ["system.reports.read", "sales.orders.read", "platform.audit.read"]
const editor = [...reader, "system.reports.manage"]
async function prepare(ctx: TestContext) {
  await ctx.seed.query(`GRANT USAGE ON SCHEMA system_config TO ${ctx.role}; GRANT EXECUTE ON FUNCTION system_config.has_permission(text) TO ${ctx.role};
    GRANT SELECT,INSERT,UPDATE ON system_config.report_definitions TO ${ctx.role}; GRANT EXECUTE ON FUNCTION report_due_schedules(timestamptz) TO ${ctx.role}`)
  const party = randomUUID()
  await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente','52998224725',true,false,'active')", [party, ctx.tenant])
  const order = (amount: number, status: string, created: string, name = "Cliente Alfa") => ctx.seed.query(
    "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status,created_at) VALUES($1,$2,$3,$4,'52998224725',CURRENT_DATE,$5,$6,$7)",
    [randomUUID(), ctx.tenant, party, name, amount, status, created])
  await order(10000, "confirmed", "now()")
  await order(25050, "confirmed", "now()", "Cliente Beta")
  await order(5000, "cancelled", "now()")
  await order(99999, "confirmed", "2020-01-01T12:00:00Z")
}
const definition = { name: "Vendas confirmadas", dataset: "sales_orders", columns: ["customer", "status", "amount"], groupBy: ["customer"],
  totals: [{ column: "amount", fn: "sum" }], filters: { period: { preset: "last_30_days" }, status: "confirmed" }, visibility: "private" }
async function createDefinition(ctx: TestContext) {
  const created = await ctx.as("user").post("/api/v1/system/custom-reports", { body: definition })
  assert.equal(created.statusCode, 201, created.body)
  return created.json().data as { id: string; revision: number }
}
class StubMailer implements ReportMailer {
  sent: DocumentMail[] = []
  constructor(private outcome: "sent" | "failed" | "unknown" = "sent") {}
  async send(mail: DocumentMail) { this.sent.push(mail); return this.outcome }
}

/** Pool do job com o mesmo papel restrito (NOBYPASSRLS) da API. */
async function jobPool(ctx: TestContext, run: (pool: DatabasePool) => Promise<void>) {
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL!); url.pathname = "/" + ctx.database
  const raw = new Pool({ connectionString: url.href })
  try { await run({ async connect() { const client = await raw.connect(); await client.query(`SET ROLE ${ctx.role}`); return new PgClientAdapter(client) } }) }
  finally { await raw.end() }
}

test("Um relatório salvo com filtros é enviado por e-mail na periodicidade escolhida, com o arquivo e o registro da execução", databaseTestOptions, async () => {
  await withTestContext({ permissions: editor }, async ctx => {
    await prepare(ctx)
    const saved = await createDefinition(ctx)
    const scheduled = await ctx.as("user").post(`/api/v1/reports/definitions/${saved.id}/schedules`, { body: { frequency: "weekly", weekday: 1, hour: 7, format: "xlsx", recipients: ["Financeiro@Example.test"] } })
    assert.equal(scheduled.statusCode, 201, scheduled.body)
    const schedule = scheduled.json().data
    assert.equal(new Date(schedule.nextRunAt).getUTCDay(), 1, "segunda-feira")
    assert.equal(new Date(schedule.nextRunAt).getUTCHours(), 10, "07:00 em Brasília")
    const first = new Date(schedule.nextRunAt)

    const mailer = new StubMailer()
    await jobPool(ctx, async pool => {
      assert.deepEqual(await processDueReports(pool, mailer, new Date(first.getTime() - 60_000)), [], "antes do horário nada é enviado")
      // Rodadas concorrentes e repetidas: a mesma ocorrência sai uma única vez (job idempotente).
      await Promise.all([processDueReports(pool, mailer, new Date(first.getTime() + 60_000)), processDueReports(pool, mailer, new Date(first.getTime() + 60_000))])
      await processDueReports(pool, mailer, new Date(first.getTime() + 120_000))
    })
    assert.equal(mailer.sent.length, 1, "uma ocorrência, um e-mail")
    const mail = mailer.sent[0]!
    assert.deepEqual(mail.to, ["financeiro@example.test"])
    assert.match(mail.subject, /^Vendas confirmadas • Empresa A$/)
    assert.equal(mail.attachments.length, 1)
    assert.match(mail.attachments[0]!.filename, /^vendas-confirmadas-\d{4}-\d{2}-\d{2}\.xlsx$/)
    const sheet = unzip(mail.attachments[0]!.content).get("xl/worksheets/sheet1.xml")!
    assert.match(sheet, /Cliente Alfa/); assert.match(sheet, /Cliente Beta/)
    assert.match(sheet, /<v>350.5<\/v>/, "total das confirmadas no período (cancelada e fora do período ficam de fora)")

    const history = await ctx.as("user").get(`/api/v1/reports/definitions/${saved.id}/schedules`)
    assert.equal(history.statusCode, 200, history.body)
    const [run] = history.json().runs
    assert.equal(history.json().runs.length, 1)
    assert.equal(run.status, "sent"); assert.equal(run.rowCount, 2); assert.equal(run.scheduledFor, first.toISOString().replace(".000", ""))
    assert.equal(history.json().data[0].nextRunAt, new Date(first.getTime() + 7 * 86_400_000).toISOString().replace(".000", ""), "próxima semana")
    const file = await ctx.as("user").get(`/api/v1/reports/runs/${run.id}/file`)
    assert.equal(file.statusCode, 200)
    assert.equal(file.headers["content-type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    assert.deepEqual(file.rawPayload, mail.attachments[0]!.content, "o histórico guarda o arquivo enviado")
  })
})

test("agenda: e-mail recusado fica registrado como falha; responsável sem permissão desativa a agenda", databaseTestOptions, async () => {
  await withTestContext({ permissions: editor }, async ctx => {
    await prepare(ctx)
    const saved = await createDefinition(ctx)
    const created = (await ctx.as("user").post(`/api/v1/reports/definitions/${saved.id}/schedules`, { body: { frequency: "daily", hour: 6, format: "csv", recipients: ["a@example.test"] } })).json().data
    const first = new Date(created.nextRunAt)
    await jobPool(ctx, async pool => {
      await processDueReports(pool, new StubMailer("failed"), new Date(first.getTime() + 1000))
      await ctx.seed.query("DELETE FROM role_permissions WHERE permission_code='sales.orders.read'")
      const mailer = new StubMailer()
      await processDueReports(pool, mailer, new Date(first.getTime() + 86_400_000 + 1000))
      assert.equal(mailer.sent.length, 0, "sem permissão da fonte não há envio")
    })
    const runs = (await ctx.seed.query("SELECT status,error FROM report_runs ORDER BY scheduled_for")).rows
    assert.deepEqual(runs.map(r => r.status), ["failed", "failed"])
    assert.match(runs[0].error, /recusou/); assert.match(runs[1].error, /desativada/)
    assert.equal((await ctx.seed.query("SELECT active FROM report_schedules")).rows[0].active, false)
  })
})

test("GET /api/v1/reports/sources [sucesso] lista só as fontes permitidas", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["system.reports.read", "sales.orders.read"] }, async ctx => {
    const response = await ctx.as("user").get("/api/v1/reports/sources")
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().data.map((s: { id: string }) => s.id), ["sales_orders"])
    assert.equal(response.json().data[0].load, undefined)
  })
})

test("GET /api/v1/reports/sources + POST /api/v1/reports/preview + GET /api/v1/reports/definitions/{id}/run + GET /api/v1/reports/definitions/{id}/schedules + POST /api/v1/reports/definitions/{id}/schedules + PUT /api/v1/reports/schedules/{id} + GET /api/v1/reports/runs/{id}/file [negado] 401 sem token, 403 sem permissão e de outra empresa", databaseTestOptions, async () => {
  await withTestContext({ permissions: editor }, async ctx => {
    await prepare(ctx)
    const saved = await createDefinition(ctx)
    const scheduleBody = { frequency: "daily", hour: 6, format: "csv", recipients: ["a@example.test"] }
    const schedule = (await ctx.as("user").post(`/api/v1/reports/definitions/${saved.id}/schedules`, { body: scheduleBody })).json().data
    const calls: [string, string, object][] = [
      ["get", "/api/v1/reports/sources", {}], ["post", "/api/v1/reports/preview", { body: { dataset: "sales_orders", columns: ["amount"] } }],
      ["get", `/api/v1/reports/definitions/${saved.id}/run`, {}], ["get", `/api/v1/reports/definitions/${saved.id}/schedules`, {}],
      ["post", `/api/v1/reports/definitions/${saved.id}/schedules`, { body: scheduleBody }], ["put", `/api/v1/reports/schedules/${schedule.id}`, { body: scheduleBody, revision: 1 }],
      ["get", `/api/v1/reports/runs/${randomUUID()}/file`, {}],
    ]
    for (const [method, url, init] of calls) {
      for (const persona of ["anonymous", "denied", "outsider"] as const) {
        const response = await (ctx.as(persona) as unknown as Record<string, (u: string, i: object) => Promise<{ statusCode: number }>>)[method]!(url, init)
        assert.equal(response.statusCode, persona === "anonymous" ? 401 : 403, `${persona} ${method} ${url}`)
      }
    }
    // Leitor sem a permissão da fonte não executa nem enxerga a definição (RLS + motor).
    await ctx.seed.query("DELETE FROM role_permissions WHERE permission_code='sales.orders.read'")
    assert.equal((await ctx.as("user").post("/api/v1/reports/preview", { body: { dataset: "sales_orders", columns: ["amount"] } })).statusCode, 403)
    assert.equal((await ctx.as("user").get(`/api/v1/reports/definitions/${saved.id}/run`)).statusCode, 404)
  })
})

test("POST /api/v1/reports/preview [sucesso] agrupa, totaliza e filtra por empresa; 422 para campo não declarado", databaseTestOptions, async () => {
  await withTestContext({ permissions: reader }, async ctx => {
    await prepare(ctx)
    await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','X','52998224725',true,false,'active')", [ctx.otherTenant, ctx.otherTenant])
    await ctx.seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Outra empresa','52998224725',CURRENT_DATE,777,'confirmed')", [randomUUID(), ctx.otherTenant])
    const response = await ctx.as("user").post("/api/v1/reports/preview", { body: { dataset: "sales_orders", columns: ["status", "amount"], groupBy: ["status"], totals: [{ column: "amount", fn: "sum" }, { column: "amount", fn: "max" }], filters: { period: { preset: "last_7_days" } } } })
    assert.equal(response.statusCode, 200, response.body)
    const data = response.json().data
    assert.deepEqual(data.columns.map((c: { key: string }) => c.key), ["status", "count", "sum_amount", "max_amount"])
    assert.deepEqual(data.rows, [{ status: "Cancelado", count: 1, sum_amount: 5000, max_amount: 5000 }, { status: "Confirmado", count: 2, sum_amount: 35050, max_amount: 25050 }])
    assert.deepEqual(data.totals, { count: 3, sum_amount: 40050, max_amount: 25050 })
    for (const body of [{ dataset: "sales_orders", columns: ["tenant_id"] }, { dataset: "sql", columns: ["x"] }, { dataset: "sales_orders", columns: ["amount"], sql: "SELECT 1" }])
      assert.equal((await ctx.as("user").post("/api/v1/reports/preview", { body })).statusCode, 422)
    const audit = await ctx.as("user").post("/api/v1/reports/preview", { body: { dataset: "audit_log", columns: ["action"], groupBy: ["action"], filters: { period: { preset: "today" } } } })
    assert.equal(audit.statusCode, 200, audit.body)
  })
})

test("GET /api/v1/reports/definitions/{id}/run [sucesso] devolve JSON e exporta CSV, XLSX e PDF", databaseTestOptions, async () => {
  await withTestContext({ permissions: editor }, async ctx => {
    await prepare(ctx)
    const saved = await createDefinition(ctx)
    const json = await ctx.as("user").get(`/api/v1/reports/definitions/${saved.id}/run`)
    assert.equal(json.statusCode, 200, json.body)
    assert.equal(json.json().data.totals.sum_amount, 35050)
    const csv = await ctx.as("user").get(`/api/v1/reports/definitions/${saved.id}/run`, { query: { format: "csv" } })
    assert.equal(csv.headers["content-type"], "text/csv; charset=utf-8")
    assert.match(String(csv.headers["content-disposition"]), /attachment; filename="vendas-confirmadas-/)
    assert.match(csv.body, /"Cliente Beta";"1";"250,50"/)
    const pdf = await ctx.as("user").get(`/api/v1/reports/definitions/${saved.id}/run`, { query: { format: "pdf" } })
    assert.equal(pdf.statusCode, 200); assert.equal(pdf.rawPayload.subarray(0, 5).toString(), "%PDF-")
    const xlsx = await ctx.as("user").get(`/api/v1/reports/definitions/${saved.id}/run`, { query: { format: "xlsx" } })
    assert.ok(unzip(xlsx.rawPayload).has("xl/worksheets/sheet1.xml"))
    assert.equal((await ctx.as("user").get(`/api/v1/reports/definitions/${saved.id}/run`, { query: { format: "doc" } })).statusCode, 422)
    assert.equal((await ctx.as("user").get(`/api/v1/reports/definitions/${randomUUID()}/run`)).statusCode, 404)
  })
})

test("POST /api/v1/reports/definitions/{id}/schedules [sucesso] cria com idempotência; 409 ao reusar a chave; 422 inválido", databaseTestOptions, async () => {
  await withTestContext({ permissions: editor }, async ctx => {
    await prepare(ctx)
    const saved = await createDefinition(ctx)
    const url = `/api/v1/reports/definitions/${saved.id}/schedules`, key = randomUUID()
    const body = { frequency: "monthly", monthDay: 5, hour: 8, format: "pdf", recipients: ["x@example.test"] }
    const first = await ctx.as("user").post(url, { body, idempotencyKey: key })
    assert.equal(first.statusCode, 201, first.body)
    const again = await ctx.as("user").post(url, { body, idempotencyKey: key })
    assert.equal(again.json().data.id, first.json().data.id, "mesma intenção, mesma agenda")
    assert.equal((await ctx.as("user").post(url, { body: { ...body, hour: 9 }, idempotencyKey: key })).statusCode, 409)
    for (const bad of [{ ...body, monthDay: 31 }, { ...body, frequency: "weekly" }, { ...body, recipients: ["não-é-email"] }, { ...body, format: "doc" }, { ...body, extra: 1 }])
      assert.equal((await ctx.as("user").post(url, { body: bad })).statusCode, 422, JSON.stringify(bad))
    assert.equal(new Date(first.json().data.nextRunAt).getUTCDate(), 5)
  })
})

test("PUT /api/v1/reports/schedules/{id} [sucesso] altera e desativa com If-Match; 412 com revisão antiga", databaseTestOptions, async () => {
  await withTestContext({ permissions: editor }, async ctx => {
    await prepare(ctx)
    const saved = await createDefinition(ctx)
    const body = { frequency: "daily", hour: 6, format: "csv", recipients: ["a@example.test"] }
    const created = (await ctx.as("user").post(`/api/v1/reports/definitions/${saved.id}/schedules`, { body })).json().data
    const changed = await ctx.as("user").put(`/api/v1/reports/schedules/${created.id}`, { body: { ...body, active: false, hour: 20 }, revision: 1 })
    assert.equal(changed.statusCode, 200, changed.body)
    assert.equal(changed.json().data.active, false); assert.equal(changed.json().data.revision, 2)
    assert.equal((await ctx.as("user").put(`/api/v1/reports/schedules/${created.id}`, { body, revision: 1 })).statusCode, 412)
    assert.equal((await ctx.as("user").put(`/api/v1/reports/schedules/${created.id}`, { body })).statusCode, 428)
  })
})

test("GET /api/v1/reports/runs/{id}/file [sucesso] baixa o arquivo; 409 quando a execução não gerou arquivo", databaseTestOptions, async () => {
  await withTestContext({ permissions: editor }, async ctx => {
    await prepare(ctx)
    const saved = await createDefinition(ctx)
    const created = (await ctx.as("user").post(`/api/v1/reports/definitions/${saved.id}/schedules`, { body: { frequency: "daily", hour: 6, format: "csv", recipients: ["a@example.test"] } })).json().data
    await jobPool(ctx, pool => processDueReports(pool, new StubMailer(), new Date(new Date(created.nextRunAt).getTime() + 1000)).then(() => {}))
    const { rows: [run] } = await ctx.seed.query("SELECT id FROM report_runs")
    const file = await ctx.as("user").get(`/api/v1/reports/runs/${run.id}/file`)
    assert.equal(file.statusCode, 200); assert.match(file.body, /Cliente Alfa/)
    await ctx.seed.query("UPDATE report_runs SET content=NULL")
    assert.equal((await ctx.as("user").get(`/api/v1/reports/runs/${run.id}/file`)).statusCode, 409)
  })
})

test("definição do motor: grava agrupamento, totais e permissões; privada não aparece para outro leitor", databaseTestOptions, async () => {
  await withTestContext({ permissions: editor }, async ctx => {
    await prepare(ctx)
    const saved = await createDefinition(ctx)
    const row = (await ctx.seed.query("SELECT group_by,totals,required_permissions FROM system_config.report_definitions WHERE id=$1", [saved.id])).rows[0]
    assert.deepEqual(row, { group_by: ["customer"], totals: [{ column: "amount", fn: "sum" }], required_permissions: ["sales.orders.read"] })
    const list = (await ctx.as("user").get("/api/v1/system/custom-reports")).json()
    assert.deepEqual(list.engineSources.map((s: { id: string }) => s.id), ["sales_orders", "audit_log"])
    assert.equal((await ctx.as("user").post("/api/v1/system/custom-reports", { body: { ...definition, groupBy: ["amount"] } })).statusCode, 422)
    await ctx.grant("denied", ...reader)
    assert.equal((await ctx.as("denied").get(`/api/v1/reports/definitions/${saved.id}/run`)).statusCode, 404, "privada é do dono")
  })
})
