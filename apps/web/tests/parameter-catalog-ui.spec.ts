import { expect, test, type BrowserContext } from "@playwright/test"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"

const origin = "http://127.0.0.1:33118"
const secret = "danfe-browser-fixture-not-a-real-service-secret"
const tenant = "11111111-1111-4111-8111-111111111111"
type Item = { code: string; module: string; label: string; description: string; type: string; defaultValue: unknown; value: unknown; customized: boolean; choices: string[]; minimum: number | null; maximum: number | null; unit: string | null; revision: number; updatedBy: string | null; updatedAt: string | null }
const base = { choices: [], minimum: 1, maximum: 30, unit: "dias", revision: 1, updatedBy: null, updatedAt: null, customized: false }
let items: Item[] = []
let calls: { method: string; url: string; ifMatch?: string | string[]; body: string }[] = []

const upstream = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  calls.push({ method: request.method || "", url: request.url || "", ifMatch: request.headers["if-match"], body })
  const send = (status: number, value: unknown, etag?: number) => { response.writeHead(status, { "Content-Type": "application/json", ...(etag ? { ETag: `"${etag}"` } : {}) }); response.end(JSON.stringify(value)) }
  if (request.url === "/api/v1/me") return send(200, { tenant: { id: tenant, legalName: "Empresa de teste" }, permissions: [] })
  const url = new URL(request.url || "", "http://x")
  if (url.pathname === "/api/v1/parameters" && request.method === "GET") {
    const q = (url.searchParams.get("q") || "").toLowerCase()
    return send(200, { tenantId: tenant, canEdit: true, data: items.filter(item => !q || `${item.label} ${item.description}`.toLowerCase().includes(q)) })
  }
  const match = /^\/api\/v1\/parameters\/(.+)$/.exec(url.pathname)
  if (match && request.method === "PUT") {
    const item = items.find(entry => entry.code === match[1])!
    if (request.headers["if-match"] !== `"${item.revision}"`) return send(412, { title: "Outra pessoa alterou o cadastro. Sua edição foi preservada" })
    const { value } = JSON.parse(body) as { value: number | null }
    if (value !== null && value > 30) return send(422, { title: "Retenção das exportações: informe um valor entre 1 e 30" })
    Object.assign(item, value === null ? { value: item.defaultValue, customized: false } : { value, customized: true, updatedBy: "Ana", updatedAt: "2026-11-19T12:00:00Z" }, { revision: item.revision + 1 })
    return send(200, { tenantId: tenant, data: item }, item.revision)
  }
  send(404, { title: "Recurso não encontrado" })
})

function cookie() {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv)
  cipher.setAAD(Buffer.from("erp-session"))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ accessToken: "fixture-token", tenantId: tenant, expiresAt: Date.now() + 3600_000 })), cipher.final()])
  return { name: "erp_session", value: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url"), url: origin, httpOnly: true, sameSite: "Lax" as const }
}
const authenticate = (context: BrowserContext) => context.addCookies([cookie()])

test.beforeAll(async () => { await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(33119, "127.0.0.1", resolve) }) })
test.afterAll(async () => { if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve())) })
test.beforeEach(() => {
  calls = []
  items = [
    { ...base, code: "data.export.retention_days", module: "data", label: "Retenção das exportações", description: "Dias em que o arquivo da exportação fica disponível.", type: "integer", defaultValue: 7, value: 7 },
    { ...base, code: "period_close.reopen_requires_reason", module: "period_close", label: "Exigir motivo na reabertura", description: "Reabrir exige motivo registrado na auditoria.", type: "boolean", defaultValue: true, value: true, minimum: null, maximum: null, unit: null },
  ]
})

test("catálogo de parâmetros: busca, altera com revisão, volta ao padrão e mostra erros", async ({ page, context }) => {
  await authenticate(context)
  await page.goto("/preferencias/sistema/parametros")
  await expect(page.getByRole("heading", { name: "Parâmetros da empresa" })).toBeVisible()
  const row = page.locator('[data-parameter="data.export.retention_days"]')
  await expect(row).toContainText("Padrão: 7 dias")
  await page.getByPlaceholder("Nome, módulo ou efeito").fill("motivo")
  await expect(page.locator("[data-parameter]")).toHaveCount(1)
  await page.getByPlaceholder("Nome, módulo ou efeito").fill("")
  await expect(page.locator("[data-parameter]")).toHaveCount(2)

  await row.getByRole("button", { name: "Alterar" }).click()
  await row.getByLabel("Retenção das exportações").fill("99")
  await row.getByRole("button", { name: "Salvar" }).click()
  await expect(row.getByRole("alert")).toContainText("informe um valor entre 1 e 30")
  await row.getByLabel("Retenção das exportações").fill("15")
  await row.getByRole("button", { name: "Salvar" }).click()
  await expect(row.getByTestId("parameter-value")).toHaveText("15 dias")
  await expect(row).toContainText("ajustado")
  await expect(row).toContainText("Alterado por Ana")
  expect(calls.filter(call => call.method === "PUT").at(-1)).toMatchObject({ ifMatch: '"1"', body: JSON.stringify({ value: 15 }) })

  await row.getByRole("button", { name: "Alterar" }).click()
  await row.getByRole("button", { name: "Padrão" }).click()
  await expect(row.getByTestId("parameter-value")).toHaveText("7 dias")
  await expect(row).not.toContainText("ajustado")
})

test("catálogo de parâmetros: revisão antiga preserva a edição e a tela é encontrada em Preferências", async ({ page, context }) => {
  await authenticate(context)
  await page.goto("/preferencias/sistema/parametros")
  const row = page.locator('[data-parameter="data.export.retention_days"]')
  await row.getByRole("button", { name: "Alterar" }).click()
  items[0]!.revision = 5
  await row.getByLabel("Retenção das exportações").fill("10")
  await row.getByRole("button", { name: "Salvar" }).click()
  await expect(row.getByRole("alert")).toContainText("Sua edição foi preservada")
  await expect(row.getByLabel("Retenção das exportações")).toHaveValue("10")
  await page.route("**/api/erp/pos/settings", route => route.fulfill({ json: { tenantId: tenant, data: { enabled: true, revision: 1 } } }))
  await page.goto("/preferencias?categoria=sistema")
  await expect(page.getByRole("link", { name: /Parâmetros da empresa/ })).toBeVisible()
})
