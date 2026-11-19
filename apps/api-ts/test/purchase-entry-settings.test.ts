import assert from "node:assert/strict"
import test from "node:test"
import { databaseTestOptions, withTestContext } from "./support/test-context.js"

const url = "/api/v1/purchase-entry-settings"

test("GET /api/v1/purchase-entry-settings + PUT /api/v1/purchase-entry-settings [sucesso] lê o padrão exato e grava a tolerância com revisão", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["purchasing.orders.read", "platform.company.manage"] }, async ctx => {
    const first = await ctx.as("user").get(url)
    assert.equal(first.statusCode, 200, first.body)
    assert.deepEqual(first.json().data, { priceToleranceBps: 0, quantityToleranceBps: 0, revision: 1 })
    const saved = await ctx.as("user").put(url, { body: { priceToleranceBps: 250, quantityToleranceBps: 100 }, revision: 1 })
    assert.equal(saved.statusCode, 200, saved.body)
    const again = await ctx.as("user").put(url, { body: { priceToleranceBps: 300, quantityToleranceBps: 100 }, revision: 1 })
    assert.equal(again.json().data.revision, 2)
    assert.equal((await ctx.as("user").put(url, { body: { priceToleranceBps: 1, quantityToleranceBps: 1 }, revision: 1 })).statusCode, 412)
    assert.equal((await ctx.as("user").put(url, { body: { priceToleranceBps: 20000, quantityToleranceBps: 1 }, revision: 2 })).statusCode, 422)
  })
})

test("GET /api/v1/purchase-entry-settings + PUT /api/v1/purchase-entry-settings [negado] sem permissão 403, sem token 401, outra empresa 403", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["purchasing.orders.read"] }, async ctx => {
    assert.equal((await ctx.as("user").put(url, { body: { priceToleranceBps: 1, quantityToleranceBps: 1 }, revision: 1 })).statusCode, 403)
    assert.equal((await ctx.as("denied").get(url)).statusCode, 403)
    assert.equal((await ctx.as("anonymous").get(url)).statusCode, 401)
    assert.equal((await ctx.as("user").get(url, { tenant: ctx.otherTenant })).statusCode, 403)
  })
})
