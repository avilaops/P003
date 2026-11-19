import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { databaseTestOptions, withTestContext, type TestContext } from "./support/test-context.js"

const rules = "/api/v1/approval-rules"

async function roleId(ctx: TestContext, code: string, tenant = ctx.tenant) {
  return String((await ctx.seed.query("SELECT id FROM roles WHERE tenant_id=$1 AND code=$2", [tenant, code])).rows[0]!.id)
}
async function identityId(ctx: TestContext, subject: string) {
  return String((await ctx.seed.query("SELECT id FROM identities WHERE auth_subject=$1", [subject])).rows[0]!.id)
}
/** Pedido de aprovação semeado direto no banco: o fluxo por documento é testado em purchase-approvals. */
async function seedRequest(ctx: TestContext, approverRole: string, requester = "user") {
  const rule = randomUUID(), request = randomUUID()
  await ctx.seed.query("INSERT INTO approval_rules(id,tenant_id,document_type,name,threshold_cents,approver_role_id) VALUES($1,$2,'sale','Gerência',100000,$3)", [rule, ctx.tenant, approverRole])
  await ctx.seed.query("INSERT INTO approval_requests(id,tenant_id,document_type,document_id,amount_cents,summary,requested_by) VALUES($1,$2,'sale',$3,250000,'Venda teste',$4)", [request, ctx.tenant, randomUUID(), await identityId(ctx, requester)])
  await ctx.seed.query("INSERT INTO approval_steps(tenant_id,request_id,rule_id,rule_name,threshold_cents,approver_role_id) VALUES($1,$2,$3,'Gerência',100000,$4)", [ctx.tenant, request, rule, approverRole])
  return request
}

test("GET /api/v1/approval-rules + POST /api/v1/approval-rules + PUT /api/v1/approval-rules/{id} [sucesso] cria, lista e altera regras com revisão", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["approvals.rules.manage"] }, async ctx => {
    const approver = await roleId(ctx, "denied")
    const body = { documentType: "purchase", name: "Compras acima de 5 mil", threshold: "5000.00", approverRoleId: approver }
    const created = await ctx.as("user").post(rules, { body })
    assert.equal(created.statusCode, 201, created.body)
    const rule = created.json().data
    assert.equal(rule.threshold, "5000.00")
    assert.equal(rule.revision, 1)
    const listed = await ctx.as("user").get(rules, { query: { documentType: "purchase" } })
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.json().data.length, 1)
    const updated = await ctx.as("user").put(`${rules}/${rule.id}`, { body: { ...body, threshold: "8000.00" }, revision: 1 })
    assert.equal(updated.statusCode, 200, updated.body)
    assert.equal(updated.json().data.threshold, "8000.00")
    assert.equal(updated.headers.etag, '"2"')
  })
})

test("PUT /api/v1/approval-rules/{id} [negado] revisão antiga 412, entrada inválida 422 e papel de outra empresa 409", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["approvals.rules.manage"] }, async ctx => {
    const approver = await roleId(ctx, "denied")
    const body = { documentType: "purchase", name: "Compras", threshold: "100.00", approverRoleId: approver }
    const rule = (await ctx.as("user").post(rules, { body })).json().data
    assert.equal((await ctx.as("user").put(`${rules}/${rule.id}`, { body, revision: 5 })).statusCode, 412)
    assert.equal((await ctx.as("user").post(rules, { body: { ...body, threshold: "-1" } })).statusCode, 422)
    assert.equal((await ctx.as("user").post(rules, { body: { ...body, documentType: "outro" } })).statusCode, 422)
    const foreign = await roleId(ctx, "outsider", ctx.otherTenant)
    assert.equal((await ctx.as("user").post(rules, { body: { ...body, approverRoleId: foreign } })).statusCode, 409)
    assert.equal((await ctx.as("user").put(`${rules}/${randomUUID()}`, { body, revision: 1 })).statusCode, 404)
  })
})

test("GET /api/v1/approval-rules + POST /api/v1/approval-rules [negado] sem permissão 403, sem token 401, outra empresa 403", databaseTestOptions, async () => {
  await withTestContext({}, async ctx => {
    const body = { documentType: "purchase", name: "Compras", threshold: "100.00", approverRoleId: await roleId(ctx, "user") }
    assert.equal((await ctx.as("user").get(rules)).statusCode, 403)
    assert.equal((await ctx.as("user").post(rules, { body })).statusCode, 403)
    assert.equal((await ctx.as("anonymous").get(rules)).statusCode, 401)
    assert.equal((await ctx.as("outsider").get(rules)).statusCode, 403)
  })
})

test("GET /api/v1/approvals/pending + GET /api/v1/approvals/{id} + POST /api/v1/approvals/{id}/decision + GET /api/v1/approvals [sucesso] aprovador da alçada vê e aprova; histórico registra a decisão", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["approvals.decide"] }, async ctx => {
    await ctx.grant("denied", "approvals.decide")
    // `denied` pede; `user` (papel aprovador) decide.
    const request = await seedRequest(ctx, await roleId(ctx, "user"), "denied")
    const pending = await ctx.as("user").get("/api/v1/approvals/pending")
    assert.equal(pending.statusCode, 200, pending.body)
    assert.deepEqual(pending.json().data.map((row: { id: string }) => row.id), [request])
    assert.equal((await ctx.as("denied").get("/api/v1/approvals/pending")).json().total, 0, "quem pediu não vê como pendência sua")
    const detail = await ctx.as("user").get(`/api/v1/approvals/${request}`)
    assert.equal(detail.json().canDecide, true)
    const decided = await ctx.as("user").post(`/api/v1/approvals/${request}/decision`, { body: { decision: "approved" } })
    assert.equal(decided.statusCode, 200, decided.body)
    assert.equal(decided.json().data.status, "approved")
    assert.equal(decided.json().data.steps[0].status, "approved")
    const documentId = decided.json().data.documentId
    const history = await ctx.as("user").get("/api/v1/approvals", { query: { documentType: "sale", documentId } })
    assert.equal(history.json().data[0].status, "approved")
    // Decidir de novo: 409.
    assert.equal((await ctx.as("user").post(`/api/v1/approvals/${request}/decision`, { body: { decision: "approved" } })).statusCode, 409)
  })
})

test("POST /api/v1/approvals/{id}/decision [negado] fora da alçada 403, autoaprovação 409, recusa sem motivo 422, sem permissão 403", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["approvals.decide"] }, async ctx => {
    await ctx.grant("denied", "approvals.decide")
    const othersRole = await seedRequest(ctx, await roleId(ctx, "denied"), "denied")
    assert.equal((await ctx.as("user").post(`/api/v1/approvals/${othersRole}/decision`, { body: { decision: "approved" } })).statusCode, 403)
    assert.equal((await ctx.as("denied").post(`/api/v1/approvals/${othersRole}/decision`, { body: { decision: "approved" } })).statusCode, 409)
    const mine = await seedRequest(ctx, await roleId(ctx, "user"), "denied")
    assert.equal((await ctx.as("user").post(`/api/v1/approvals/${mine}/decision`, { body: { decision: "rejected" } })).statusCode, 422)
    assert.equal((await ctx.as("user").post(`/api/v1/approvals/${mine}/decision`, { body: { decision: "talvez" } })).statusCode, 422)
    const rejected = await ctx.as("user").post(`/api/v1/approvals/${mine}/decision`, { body: { decision: "rejected", reason: "Fora do orçamento" } })
    assert.equal(rejected.json().data.status, "rejected")
    assert.equal((await ctx.as("user").get(`/api/v1/approvals/${randomUUID()}`)).statusCode, 404)
  })
})

test("GET /api/v1/approvals/pending + GET /api/v1/approvals + GET /api/v1/approvals/{id} [negado] sem approvals.decide 403, sem token 401, outra empresa não vê o pedido", databaseTestOptions, async () => {
  await withTestContext({}, async ctx => {
    const request = await seedRequest(ctx, await roleId(ctx, "user"), "denied")
    assert.equal((await ctx.as("user").get("/api/v1/approvals/pending")).statusCode, 403)
    assert.equal((await ctx.as("user").get("/api/v1/approvals", { query: { documentType: "sale", documentId: "x" } })).statusCode, 403)
    assert.equal((await ctx.as("user").get(`/api/v1/approvals/${request}`)).statusCode, 403)
    assert.equal((await ctx.as("anonymous").get("/api/v1/approvals/pending")).statusCode, 401)
    // `outsider` tem todas as permissões na empresa B: o pedido da empresa A não existe para ele.
    assert.equal((await ctx.as("outsider").get(`/api/v1/approvals/${request}`, { tenant: ctx.otherTenant })).statusCode, 404)
  })
})
