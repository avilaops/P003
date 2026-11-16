import { expect, test } from "@playwright/test"
import { createServer, type Server } from "node:http"
import { installFrontendFixture, record, tenant } from "./helpers/frontend-fixture"

const calls: { backend: string; path: string; method: string; authorization: string | undefined; tenant: string | undefined; body: string; key: string | undefined; revision: string | undefined }[] = []
const servers: Server[] = []
test.beforeAll(async () => {
  for (const [backend, port] of [["rust", 33311], ["typescript", 33312]] as const) {
    const server = createServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) body += chunk
      const path = new URL(request.url!, "http://fixture").pathname
      calls.push({ backend, path, method: request.method!, authorization: request.headers.authorization, tenant: request.headers["x-tenant-id"] as string | undefined, body, key: request.headers["idempotency-key"] as string | undefined, revision: request.headers["if-match"] as string | undefined })
      if (path === "/api/v1/orders" && body.includes("lost-response")) { request.socket.destroy(); return }
      const list = { tenantId: tenant, canEdit: true, total: 1, data: [{ id: record, number: "7", customerName: `Cliente • ${backend}`, amount: "100.00", status: "draft", version: 1, expired: false, updatedAt: "2026-11-16T12:00:00Z", pricingOrigin: false }] }
      const value = path === "/health/ready" ? { status: "ready" }
        : path === "/api/v1/me" ? { tenant: { id: tenant, name: "Empresa da fixture" }, identity: { id: record, name: "Operador", email: "operator@example.test" }, permissions: ["sales.orders.read", "sales.orders.manage", "sales.proposals.read", "sales.proposals.manage"] }
        : path === "/api/v1/orders" || path === "/api/v1/proposals" ? list
        : { tenantId: tenant, backend }
      response.writeHead(request.method === "POST" ? 201 : 200, { "Content-Type": "application/json", ETag: '"8"', "Idempotency-Replayed": "true" })
      response.end(JSON.stringify(value))
    })
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve) })
    servers.push(server)
  }
})
test.afterAll(async () => { for (const server of servers) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } })

test("navegador usa os módulos configurados e preserva o retorno explícito a Rust", async ({ page, context, baseURL }, info) => {
  await installFrontendFixture(context, baseURL)
  await context.unroute("**/api/erp/**")
  const expected = info.project.name === "typescript" ? "typescript" : "rust"
  await page.goto("/vendas")
  await expect(page.getByRole("heading", { name: "Vendas", exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "Pedidos de venda", exact: true }).locator(".sales-customer-name")).toHaveText(`Cliente • ${expected}`)
  for (const resource of ["preferences", "parties", "dashboard", "system/custom-reports"]) {
    const result = await page.evaluate(async resource => { const response = await fetch(`/api/erp/${resource}`); return { status: response.status, value: await response.json() } }, resource)
    expect(result.status).toBe(200)
    expect(result.value.backend).toBe(expected)
  }
  const write = (body: string, selectedTenant = tenant) => page.evaluate(async ({ body, tenant }) => {
    const response = await fetch("/api/erp/orders", { method: "POST", headers: { "Content-Type": "application/json", "X-Tenant-Id": tenant, "If-Match": '"7"', "Idempotency-Key": "browser-migration-command" }, body })
    return { status: response.status, etag: response.headers.get("etag"), replay: response.headers.get("idempotency-replayed") }
  }, { body, tenant: selectedTenant })
  const body = '{"value":9007199254740993}'
  expect(await write(body)).toEqual({ status: 201, etag: '"8"', replay: "true" })
  const command = calls.findLast(call => call.method === "POST")!
  expect(command).toMatchObject({ backend: expected, authorization: "Bearer frontend-integration-fixture", tenant, body, key: "browser-migration-command", revision: '"7"' })
  let before = calls.filter(call => call.method === "POST").length
  expect((await write(body, record)).status).toBe(409)
  expect(calls.filter(call => call.method === "POST")).toHaveLength(before)
  expect((await write('{"case":"lost-response"}')).status).toBe(503)
  expect(calls.filter(call => call.method === "POST")).toHaveLength(before + 1)
  const financial = await page.evaluate(async () => (await fetch("/api/erp/receivables")).json())
  expect(financial.backend).toBe("rust")
  before = calls.length
  await context.clearCookies()
  expect((await context.request.get("/api/erp/orders")).status()).toBe(401)
  expect(calls).toHaveLength(before)
})
