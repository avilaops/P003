import assert from "node:assert/strict"
import test from "node:test"
import { createTestContext, databaseTestOptions, withTestContext } from "./test-context.js"

// Prova o uso do helper em duas rotas reais: /me (qualquer membro) e /parties (permissão explícita).
test("GET /api/v1/me [sucesso] membro autenticado recebe o próprio perfil e as permissões do papel", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["catalog.parties.read"] }, async ctx => {
    const response = await ctx.as("user").get("/api/v1/me")
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().identity.subject, "user")
    assert.ok(response.json().permissions.includes("catalog.parties.read"))
  })
})

test("GET /api/v1/me [negado] sem token 401; membro de outra empresa 403", databaseTestOptions, async () => {
  await withTestContext({}, async ctx => {
    assert.equal((await ctx.as("anonymous").get("/api/v1/me")).statusCode, 401)
    assert.equal((await ctx.as("outsider").get("/api/v1/me")).statusCode, 403)
  })
})

test("GET /api/v1/parties [negado] sem catalog.parties.read, sem papel ou de outra empresa", databaseTestOptions, async () => {
  await withTestContext({}, async ctx => {
    assert.equal((await ctx.as("user").get("/api/v1/parties")).statusCode, 403)
    assert.equal((await ctx.as("denied").get("/api/v1/parties")).statusCode, 403)
    assert.equal((await ctx.as("anonymous").get("/api/v1/parties")).statusCode, 401)
    await ctx.grant("user", "catalog.parties.read")
    assert.equal((await ctx.as("user").get("/api/v1/parties", { tenant: ctx.otherTenant })).statusCode, 403)
  })
})

test("GET /api/v1/parties [sucesso] com catalog.parties.read lista as pessoas da empresa", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["catalog.parties.read"] }, async ctx => {
    const response = await ctx.as("user").get("/api/v1/parties")
    assert.equal(response.statusCode, 200, response.body)
  })
})

test("createTestContext [opções] membros extras, identidade sem empresa e dependências com os IDs das empresas", databaseTestOptions, async () => {
  let seen: { tenant: string; otherTenant: string } | undefined
  await withTestContext({ members: { reader: ["catalog.parties.read"] }, identitiesWithoutCompany: ["stranger"], dependencies: ids => { seen = ids; return {} } }, async ctx => {
    assert.deepEqual(seen, { tenant: ctx.tenant, otherTenant: ctx.otherTenant })
    assert.equal((await ctx.as("reader").get("/api/v1/parties")).statusCode, 200)
    assert.equal((await ctx.as("user").get("/api/v1/parties")).statusCode, 403)
    assert.equal((await ctx.as("stranger").get("/api/v1/parties")).statusCode, 403)
    assert.equal((await ctx.as("reader").get("/api/v1/parties", { tenant: ctx.otherTenant })).statusCode, 403)
  })
})

test("createTestContext [opções] nome de membro reservado pelo helper é recusado", databaseTestOptions, async () => {
  await assert.rejects(createTestContext({ members: { user: [] } }), /reservado/)
})
