import assert from "node:assert/strict"
import test from "node:test"
import { readParameter } from "../src/modules/parameters/catalog.js"
import { databaseTestOptions, withTestContext } from "./support/test-context.js"

const code = "data.export.retention_days"

test("G5 catálogo de parâmetros: nome legível, módulo, tipo, padrão, valor por empresa, efeito, quem alterou e quando, com busca", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["system.parameters.read", "system.parameters.manage"] }, async ctx => {
    const list = await ctx.as("user").get("/api/v1/parameters", { query: { q: "retenção" } })
    assert.equal(list.statusCode, 200, list.body)
    const found = list.json().data.find((item: { code: string }) => item.code === code)
    assert.deepEqual({ module: found.module, type: found.type, defaultValue: found.defaultValue, value: found.value, customized: found.customized, revision: found.revision }, { module: "data", type: "integer", defaultValue: 7, value: 7, customized: false, revision: 1 })
    assert.ok(found.label && found.description)
    assert.equal(list.json().canEdit, true)

    const changed = await ctx.as("user").put(`/api/v1/parameters/${code}`, { body: { value: 15 }, revision: 1 })
    assert.equal(changed.statusCode, 200, changed.body)
    assert.equal(changed.headers.etag, '"2"')
    assert.equal(changed.json().data.value, 15)
    assert.equal(changed.json().data.updatedBy, "Usuário de teste")
    assert.match(changed.json().data.updatedAt, /^\d{4}-\d{2}-\d{2}T/)

    const detail = await ctx.as("user").get(`/api/v1/parameters/${code}`)
    assert.equal(detail.statusCode, 200)
    assert.deepEqual(detail.json().history.map((h: { previous: number; value: number; actor: string }) => [h.previous, h.value, h.actor]), [[7, 15, "Usuário de teste"]])

    // Valor por empresa: a outra empresa continua no padrão.
    const client = await ctx.seed.connect()
    try {
      await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id',$1,true)", [ctx.otherTenant])
      assert.equal(await readParameter(client, ctx.otherTenant, code), 7)
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [ctx.tenant])
      assert.equal(await readParameter(client, ctx.tenant, code), 15)
      await client.query("ROLLBACK")
    } finally { client.release() }

    const reset = await ctx.as("user").put(`/api/v1/parameters/${code}`, { body: { value: null }, revision: 2 })
    assert.equal(reset.statusCode, 200, reset.body)
    assert.deepEqual([reset.json().data.value, reset.json().data.customized, reset.json().data.revision], [7, false, 3])

    const byModule = await ctx.as("user").get("/api/v1/parameters", { query: { module: "period_close" } })
    assert.ok(byModule.json().data.length >= 1 && byModule.json().data.every((item: { module: string }) => item.module === "period_close"))
  })
})

test("GET /api/v1/parameters + GET /api/v1/parameters/{code} [sucesso] leitura com system.parameters.read, sem edição", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["system.parameters.read"] }, async ctx => {
    const list = await ctx.as("user").get("/api/v1/parameters")
    assert.equal(list.statusCode, 200)
    assert.equal(list.json().canEdit, false)
    const detail = await ctx.as("user").get(`/api/v1/parameters/${code}`)
    assert.equal(detail.statusCode, 200)
    assert.equal(detail.headers.etag, '"1"')
    assert.equal((await ctx.as("user").get("/api/v1/parameters/inexistente.codigo")).statusCode, 404)
  })
})

test("GET /api/v1/parameters + GET /api/v1/parameters/{code} + PUT /api/v1/parameters/{code} [negado] sem token, sem permissão, outra empresa e sem gestão", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["system.parameters.read"] }, async ctx => {
    assert.equal((await ctx.as("anonymous").get("/api/v1/parameters")).statusCode, 401)
    assert.equal((await ctx.as("denied").get("/api/v1/parameters")).statusCode, 403)
    assert.equal((await ctx.as("denied").get(`/api/v1/parameters/${code}`)).statusCode, 403)
    assert.equal((await ctx.as("user").get("/api/v1/parameters", { tenant: ctx.otherTenant })).statusCode, 403)
    assert.equal((await ctx.as("user").put(`/api/v1/parameters/${code}`, { body: { value: 3 }, revision: 1 })).statusCode, 403)
  })
})

test("PUT /api/v1/parameters/{code} [sucesso] 422 fora da faixa/tipo, 412 revisão antiga e 428 sem If-Match", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["system.parameters.read", "system.parameters.manage"] }, async ctx => {
    const user = ctx.as("user")
    assert.equal((await user.put(`/api/v1/parameters/${code}`, { body: { value: 99 }, revision: 1 })).statusCode, 422)
    assert.equal((await user.put(`/api/v1/parameters/${code}`, { body: { value: "7" }, revision: 1 })).statusCode, 422)
    assert.equal((await user.put(`/api/v1/parameters/${code}`, { body: { value: 3, extra: 1 }, revision: 1 })).statusCode, 422)
    assert.equal((await user.put("/api/v1/parameters/data.export.schedule", { body: { value: "daily" }, revision: 1 })).statusCode, 422)
    assert.equal((await user.put("/api/v1/parameters/data.export.schedule", { body: { value: "weekly" }, revision: 1 })).statusCode, 200)
    assert.equal((await user.put(`/api/v1/parameters/${code}`, { body: { value: 3 } })).statusCode, 428)
    assert.equal((await user.put(`/api/v1/parameters/${code}`, { body: { value: 3 }, revision: 1 })).statusCode, 200)
    assert.equal((await user.put(`/api/v1/parameters/${code}`, { body: { value: 4 }, revision: 1 })).statusCode, 412)
  })
})
