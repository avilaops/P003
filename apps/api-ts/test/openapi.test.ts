import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { buildApp } from "../src/app.js"
import { buildOpenApiDocument, openApiPath, registeredRoutes } from "../src/platform/openapi.js"

const app = buildApp({ pool: { async connect() { throw Error("sem banco") } }, userinfoUrl: "https://auth.example.invalid/userinfo" })
test.after(() => app.close())

test("openapi.json versionado confere com as rotas registradas (rode `pnpm --filter api-ts openapi` se mudar rotas)", async () => {
  await app.ready()
  const committed = await readFile(new URL("../openapi.json", import.meta.url), "utf8")
  assert.equal(committed, JSON.stringify(buildOpenApiDocument(app), null, 2) + "\n")
})

test("contrato tem uma operação por rota registrada, operationId único e schemas zod nas rotas anotadas", async () => {
  await app.ready()
  const document = buildOpenApiDocument(app)
  const operations = Object.values(document.paths).flatMap(item => Object.values(item) as { operationId: string }[])
  assert.equal(operations.length, new Set(registeredRoutes(app).map(route => route.method + " " + openApiPath(route.path))).size)
  assert.equal(new Set(operations.map(operation => operation.operationId)).size, operations.length)
  const put = (document.paths["/api/v1/preferences"] as Record<string, any>).put
  assert.equal(put.requestBody.content["application/json"].schema.type, "object")
  assert.deepEqual(put.security, [{ bearerAuth: [], tenantHeader: [] }])
})
