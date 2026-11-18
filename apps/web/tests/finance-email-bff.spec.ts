import { expect, test } from "@playwright/test"
import { createServer } from "node:http"
import { installFrontendFixture, record, tenant } from "./helpers/frontend-fixture"

for (const resource of [`receivables/${record}/email`, "financial-report/email", `commercial-contracts/${record}/send-package`]) test(`BFF documental preserva confirmação e isola sessão • ${resource}`, async ({ context, baseURL }) => {
  await installFrontendFixture(context, baseURL)
  const calls: { method?: string; url?: string; tenant?: string; revision?: string; key?: string; body: string }[] = []
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    calls.push({ method: request.method, url: request.url, tenant: request.headers["x-tenant-id"] as string, revision: request.headers["if-match"] as string, key: request.headers["idempotency-key"] as string, body })
    response.writeHead(200, { "Content-Type": "application/json", ETag: '"7"' })
    response.end(JSON.stringify({ tenantId: tenant, snapshotHash: "a".repeat(64), emailReady: true }))
  })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(33191, "127.0.0.1", resolve) })
  try {
    const path = `/api/erp/${resource}`
    const packageCommand = resource.endsWith("/send-package")
    const get = await context.request.get(path)
    expect(get.status()).toBe(packageCommand ? 405 : 200)
    if (!packageCommand) expect(get.headers()["etag"]).toBe('"7"')
    const data = packageCommand ? { recipients: ["buyer@example.test"] } : { recipient: "finance@example.test", subject: "Documento financeiro", message: "Segue para conferência.", snapshotHash: "a".repeat(64) }
    const headers = { Origin: baseURL!, "X-Tenant-Id": tenant, "If-Match": '"7"', "Idempotency-Key": record }
    expect((await context.request.post(path, { headers, data })).status()).toBe(200)
    expect(calls).toEqual([
      ...(packageCommand ? [] : [{ method: "GET", url: `/api/v1/${resource}`, tenant, revision: undefined, key: undefined, body: "" }]),
      { method: "POST", url: `/api/v1/${resource}`, tenant, revision: '"7"', key: record, body: JSON.stringify(data) },
    ])
    expect((await context.request.post(`${path}?unexpected=1`, { headers, data })).status()).toBe(400)
    expect((await context.request.post(path, { headers: { ...headers, Origin: "https://other.example" }, data })).status()).toBe(403)
    expect((await context.request.post(path, { headers: { ...headers, "X-Tenant-Id": record }, data })).status()).toBe(409)
    await context.clearCookies()
    expect((await context.request.post(path, { headers, data })).status()).toBe(401)
    expect(calls).toHaveLength(packageCommand ? 1 : 2)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
