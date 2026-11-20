import assert from "node:assert/strict"
import test from "node:test"
import { databaseTestOptions, withTestContext } from "./support/test-context.js"

const party = { personType: "fisica", legalName: "Maria da Silva", tradeName: null, taxId: "52998224725", email: null, phone: null, isCustomer: true, isSupplier: false, status: "active" }

test("GET /api/v1/history/:entity/:id: quem alterou, quando e o quê (antes/depois) a partir do audit_log", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["catalog.parties.read", "catalog.parties.manage", "catalog.products.read", "catalog.products.manage"] }, async ctx => {
    const user = ctx.as("user")
    const created = await user.post("/api/v1/parties", { body: party })
    assert.equal(created.statusCode, 201, created.body)
    const id = created.json().data.id
    assert.equal((await user.put("/api/v1/parties/" + id, { body: { ...party, legalName: "Maria S. Silva", phone: "11999990000" }, revision: 1 })).statusCode, 200)
    const history = await user.get(`/api/v1/history/party/${id}`)
    assert.equal(history.statusCode, 200, history.body)
    const [update, creation] = history.json().data
    assert.equal(creation.action, "party.created")
    assert.equal(update.action, "party.updated")
    assert.equal(update.actor, "Usuário de teste")
    assert.equal(update.revision, 2)
    assert.deepEqual(update.changes, { legalName: { before: "Maria da Silva", after: "Maria S. Silva" }, phone: { before: null, after: "11999990000" } })
    assert.match(update.occurredAt, /^\d{4}-\d\d-\d\dT/)

    const tag = await user.post("/api/v1/tags", { body: { code: "VIP", name: "Cliente VIP", status: "active", notes: null, groupId: null } })
    assert.equal(tag.statusCode, 201, tag.body)
    const tagId = tag.json().data.id
    assert.equal((await user.put("/api/v1/tags/" + tagId, { body: { code: "VIP", name: "Cliente premium", status: "active", notes: null, groupId: null }, revision: 1 })).statusCode, 200)
    const tagHistory = (await user.get(`/api/v1/history/tags/${tagId}`)).json().data
    assert.deepEqual(tagHistory[0].changes, { name: { before: "Cliente VIP", after: "Cliente premium" } })
    assert.equal(tagHistory.length, 2)
  })
})

test("GET /api/v1/history/:entity/:id: 401/403, 404, 422 e isolamento por empresa e por entidade", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["catalog.parties.read", "catalog.parties.manage"] }, async ctx => {
    const id = (await ctx.as("user").post("/api/v1/parties", { body: party })).json().data.id
    assert.equal((await ctx.as("anonymous").get(`/api/v1/history/party/${id}`)).statusCode, 401)
    assert.equal((await ctx.as("denied").get(`/api/v1/history/party/${id}`)).statusCode, 403)
    assert.equal((await ctx.as("user").get(`/api/v1/history/product/${id}`)).statusCode, 403, "leitura de produtos não vale para clientes")
    assert.equal((await ctx.as("user").get(`/api/v1/history/party/${id}`, { tenant: ctx.otherTenant })).statusCode, 403)
    assert.equal((await ctx.as("user").get(`/api/v1/history/inexistente/${id}`)).statusCode, 404)
    assert.equal((await ctx.as("user").get(`/api/v1/history/party/nao-e-uuid`)).statusCode, 404)
    assert.equal((await ctx.as("user").get(`/api/v1/history/party/${id}`, { query: { before: "nao-uuid" } })).statusCode, 422)
    assert.equal((await ctx.as("user").get(`/api/v1/history/party/${id}`, { query: { before: "11111111-1111-4111-8111-111111111111" } })).statusCode, 422)
    const outsider = await ctx.as("outsider").get(`/api/v1/history/party/${id}`, { tenant: ctx.otherTenant })
    assert.equal(outsider.statusCode, 200)
    assert.deepEqual(outsider.json().data, [], "outra empresa não vê o histórico deste registro")
  })
})
