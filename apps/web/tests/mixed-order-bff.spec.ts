import { expect, test } from "@playwright/test"
import { createServer } from "node:http"
import { installFrontendFixture, record, tenant } from "./helpers/frontend-fixture"

for (const action of ["simulate", "orders"]) test(`pedido misto BFF encaminha fontes e protege sessão • ${action}`, async ({ context, baseURL }) => {
  await installFrontendFixture(context, baseURL)
  let calls = 0
  const payload = { simulation: { items: [{ line: "imported", versionId: record }, { line: "national", versionId: tenant }] }, digest: "a".repeat(64) }
  const server = createServer(async (request, response) => {
    calls++
    expect(request.url).toBe(`/api/v1/commercial/mixed/${action}`)
    expect(request.headers["x-tenant-id"]).toBe(tenant)
    expect(request.headers["idempotency-key"]).toBe(record)
    let body = ""
    for await (const chunk of request) body += chunk
    expect(JSON.parse(body)).toEqual(payload)
    response.writeHead(200, { "Content-Type": "application/json", ETag: '"1"' })
    response.end(JSON.stringify({ tenantId: tenant }))
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(33191, "127.0.0.1", resolve) })
  try {
    const path = `/api/erp/commercial/mixed/${action}`
    const headers = { Origin: baseURL!, "X-Tenant-Id": tenant, "Idempotency-Key": record }
    expect((await context.request.post(path, { headers, data: payload })).status()).toBe(200)
    expect((await context.request.post(`${path}?unexpected=1`, { headers, data: payload })).status()).toBe(400)
    expect((await context.request.post(path, { headers: { ...headers, Origin: "https://other.example" }, data: payload })).status()).toBe(403)
    expect((await context.request.post(path, { headers: { ...headers, "X-Tenant-Id": record }, data: payload })).status()).toBe(409)
    await context.clearCookies()
    expect((await context.request.post(path, { headers, data: payload })).status()).toBe(401)
    expect(calls).toBe(1)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
