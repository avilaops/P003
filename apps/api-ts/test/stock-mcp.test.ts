import test from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import { registerInventoryMcp } from "../src/modules/inventory/mcp.js"
import { currentVerifiedMcpIdentity } from "../src/platform/request-identity.js"
import { Problem } from "../src/platform/problem.js"

const tenant = "11111111-1111-4111-8111-111111111111"
const auth = { authorization: "Bearer test-grant" }

test("inventory MCP preserves the authenticated grant, exact tenant and idempotent stock command", async t => {
  const app = Fastify()
  t.after(() => app.close())
  let scope = "erp.read"
  registerInventoryMcp(app, "https://erp.example.test/mcp", async authorization => {
    if (authorization !== auth.authorization) throw new Problem(401, "invalid_token", "Credencial inválida")
    return { subject: "operador", email: "test@example.test", name: "Operador", verified_email: true, scope }
  })
  const writes: unknown[] = []
  app.get("/api/v1/stock", (request, reply) => reply.header("x-erp-backend", "typescript").send({
    tenant: request.headers["x-tenant-id"], subject: currentVerifiedMcpIdentity()?.subject, query: request.query,
  }))
  app.post("/api/v1/stock/movements", (request, reply) => {
    writes.push({ tenant: request.headers["x-tenant-id"], key: request.headers["idempotency-key"], body: request.body })
    return reply.code(201).send({ id: "movimento" })
  })
  app.put<{Params:{id:string}}>("/api/v1/warehouses/:id",(request,reply)=>reply.header("etag",'"2"').send({
    id:request.params.id,revision:request.headers["if-match"],request:request.body,
  }))
  const call = (name: string, args: Record<string, unknown>, headers: Record<string, string> = auth) => app.inject({
    method: "POST", url: "/internal/mcp/inventory", headers, payload: { jsonrpc: "2.0", id: "capture", method: "tools/call", params: { name, arguments: args } },
  })
  const list = { tenant_id: tenant, query: { q: "A/B", limit: 25 } }
  assert.equal((await call("erp_get_stock", list, {})).statusCode, 401)
  assert.equal((await call("erp_get_stock", list, {})).headers["www-authenticate"], 'Bearer resource_metadata="https://erp.example.test/.well-known/oauth-protected-resource/mcp"')
  assert.equal((await call("erp_get_stock", list, { ...auth, origin: "https://unrelated.example" })).statusCode, 403)
  const receipt = (await call("erp_get_stock", list)).json().result
  assert.equal(receipt.isError, false)
  assert.equal(receipt.structuredContent.headers["x-erp-backend"], "typescript")
  assert.deepEqual(receipt.structuredContent.data, { tenant, subject: "operador", query: { q: "A/B", limit: "25" } })
  const write = { tenant_id: tenant, headers: { "Idempotency-Key": "intent" }, body: { quantity: "1.250000" } }
  assert.equal((await call("erp_post_stock_movements", write)).json().result.structuredContent.status, 403)
  scope = "erp.read erp.write"
  assert.equal((await call("erp_post_stock_movements", { ...write, headers: { ...write.headers, Authorization: "other" } })).json().error.code, -32602)
  assert.equal(writes.length, 0)
  assert.equal((await call("erp_post_stock_movements", write)).json().result.structuredContent.status, 201)
  assert.deepEqual(writes, [{ tenant, key: "intent", body: write.body }])
  const update={tenant_id:tenant,path:{id:tenant},headers:{"Idempotency-Key":"key","If-Match":'"1"'},body:{code:"PRINCIPAL"}}
  const saved=(await call("erp_put_warehouses__id",update)).json().result
  assert.deepEqual(saved.structuredContent.data,{id:tenant,revision:'"1"',request:{code:"PRINCIPAL"}})
  assert.equal(saved.structuredContent.headers.etag,'"2"')
  assert.equal((await call("erp_put_warehouses__id",{...update,path:{id:"../stock"}})).json().error.code,-32602)
  assert.equal((await call("erp_put_warehouses__id",{...update,headers:{"Idempotency-Key":"key"}})).json().error.code,-32602)
})
