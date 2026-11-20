import { expect, test } from "@playwright/test"
import { installFrontendFixture, tenant } from "./helpers/frontend-fixture"

const method = "44444444-4444-4444-8444-444444444444", term = "55555555-5555-4555-8555-555555555555"

test("Cadastros → Condições de pagamento lista as condições e salva uma nova com entrada e vencimentos", async ({ page, context, baseURL }) => {
  await installFrontendFixture(context, baseURL)
  let terms = [{ id: term, revision: 2, name: "30/60", entryBps: 2000, days: [30, 60], methodId: method, active: true }], saved: Record<string, unknown> | null = null
  await context.route("**/api/erp/commercial/policies/catalog", route => route.fulfill({ json: { tenantId: tenant, manage: true, terms, methods: [{ id: method, name: "Boleto" }], lists: [], people: [], defaultTermId: null, policy: null, channels: [], routes: [] } }))
  await context.route("**/api/erp/commercial/policies/settings", route => {
    saved = route.request().postDataJSON()
    expect(route.request().headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/)
    terms = [...terms, { id: "88888888-8888-4888-8888-888888888888", revision: 1, name: "À vista", entryBps: 10000, days: [], methodId: method, active: true }]
    return route.fulfill({ headers: { etag: '"1"' }, json: { tenantId: tenant, id: "88888888-8888-4888-8888-888888888888", revision: 1 } })
  })
  await page.goto("/cadastros/condicoes-pagamento")
  await expect(page.getByRole("heading", { name: "Condições de pagamento", level: 1 })).toBeVisible()
  await expect(page.getByRole("row", { name: /30\/60 20% 30, 60 Boleto Ativa/ })).toBeVisible()
  const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Condições de pagamento", level: 2 }) })
  await form.getByLabel("Nome").fill("À vista")
  await form.getByLabel("Entrada (%)").fill("100")
  await form.getByLabel("Vencimentos em dias (ex. 30, 60, 90)").fill("")
  await form.getByLabel("Forma de pagamento").selectOption(method)
  await form.getByRole("button", { name: "Salvar condição" }).click()
  await expect(page.getByText("Condição salva.")).toBeVisible()
  expect(saved).toEqual({ kind: "term", revision: 0, name: "À vista", entryBps: 10000, days: [], methodId: method, active: true })
  await expect(page.getByRole("row", { name: /À vista 100% À vista Boleto Ativa/ })).toBeVisible()
})
