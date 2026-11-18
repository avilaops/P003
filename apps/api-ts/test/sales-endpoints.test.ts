import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import type { HTTPMethods } from "fastify"
import { buildApp } from "../src/app.js"

test("o inventário de Vendas corresponde às rotas registradas pelo Fastify", async () => {
  const manifest: Record<string, Record<string, string>> = JSON.parse(
    await readFile(new URL("../src/modules/sales-endpoints.json", import.meta.url), "utf8")
  )
  const server = buildApp({
    pool: { async connect() { throw new Error("Inventário de rotas não consulta dados") } },
    userinfoUrl: "http://auth.test/userinfo"
  })
  try {
    await server.ready()
    for (const resource of Object.values(manifest)) {
      for (const [method, url] of Object.entries(resource)) {
        assert.ok(server.hasRoute({ method: method as HTTPMethods, url }), method + " " + url)
      }
    }
  } finally {
    await server.close()
  }
})
