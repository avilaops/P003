import assert from "node:assert/strict"
import test from "node:test"
import { createTestContext, databaseTestOptions, withTestContext } from "./test-context.js"

// Prova o uso do helper em duas rotas reais: /me (qualquer membro) e /parties (permissão explícita).
test("GET /api/v1/me — membro autenticado recebe o próprio perfil e as permissões do papel", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["catalog.parties.read"] }, async ctx => {
    const response = await ctx.as("user").get("/api/v1/me")
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().identity.subject, "user")
    assert.ok(response.json().permissions.includes("catalog.parties.read"))
  })
})

test("GET /api/v1/me — sem token 401; membro de outra empresa 403", databaseTestOptions, async () => {
  await withTestContext({}, async ctx => {
    assert.equal((await ctx.as("anonymous").get("/api/v1/me")).statusCode, 401)
    assert.equal((await ctx.as("outsider").get("/api/v1/me")).statusCode, 403)
  })
})

test("GET /api/v1/parties — exige catalog.parties.read; conceder a permissão libera, outra empresa continua negada", databaseTestOptions, async () => {
  const ctx = await createTestContext()
  try {
    assert.equal((await ctx.as("user").get("/api/v1/parties")).statusCode, 403)
    assert.equal((await ctx.as("denied").get("/api/v1/parties")).statusCode, 403)
    await ctx.grant("user", "catalog.parties.read")
    assert.equal((await ctx.as("user").get("/api/v1/parties")).statusCode, 200)
    assert.equal((await ctx.as("user").get("/api/v1/parties", { tenant: ctx.otherTenant })).statusCode, 403)
  } finally { await ctx.close() }
})
