import { expect, test } from "@playwright/test"
import { installFrontendFixture, tenant, record } from "./helpers/frontend-fixture"

test("contador • cadastra regra, consulta o diário e exporta a competência", async ({ context, page }) => {
  await installFrontendFixture(context)
  const accounts = [
    { id: "10000000-0000-4000-8000-000000000001", code: "1.01", name: "Banco", classification: "asset" },
    { id: "20000000-0000-4000-8000-000000000002", code: "2.01", name: "Clientes", classification: "asset" },
  ]
  let revision = 1
  const rules: { eventType: string; debitId: string; creditId: string }[] = []
  const state = () => ({
    tenantId: tenant,
    canEdit: true,
    data: { revision },
    accounts,
    rules,
    periods: [],
    pending: [],
    pendingInvoices: 0,
    eventTypes: ["receivable.cash"],
  })
  await page.route("**/api/erp/accounting", (route) =>
    route.fulfill({ headers: { etag: '"' + revision + '"' }, json: state() }),
  )
  await page.route("**/api/erp/accounting/rules", (route) => {
    expect(route.request().headers()["if-match"]).toBe('"1"')
    rules.push(route.request().postDataJSON())
    revision++
    return route.fulfill({ headers: { etag: '"2"' }, json: state() })
  })
  await page.route("**/api/erp/accounting/reports/journal?*", (route) =>
    route.fulfill({
      json: {
        tenantId: tenant,
        data: [
          {
            id: record,
            date: "2025-01-08",
            eventType: "receivable.cash",
            documentType: "receivable",
            documentId: record,
            debitAccount: "1.01",
            creditAccount: "2.01",
            debitName: "Banco",
            creditName: "Clientes",
            amount: "400.00",
          },
        ],
      },
    }),
  )
  const [configuration] = await Promise.all([
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/erp/accounting" && response.request().method() === "GET",
      { timeout: 60000 },
    ),
    page.goto("/financeiro/contador"),
  ])
  expect(configuration.status()).toBe(200)
  await expect(page.getByRole("heading", { name: "Plano de contas e regras" })).toBeVisible()
  await page.getByLabel("Operação contábil").selectOption("rules")
  await page.getByLabel("Conta de débito").selectOption(accounts[0].id)
  await page.getByLabel("Conta de crédito").selectOption(accounts[1].id)
  await page.getByRole("button", { name: "Confirmar operação" }).click()
  await expect(page.getByText("Recebimento • principal em caixa • Débito 1.01 • Crédito 2.01")).toBeVisible()
  expect(rules).toEqual([{ eventType: "receivable.cash", debitId: accounts[0].id, creditId: accounts[1].id }])
  await page.getByLabel("Mês dos lançamentos").fill("2025-01")
  await expect(page.getByRole("link", { name: "Exportar livro em CSV" })).toHaveAttribute(
    "href",
    /from=2025-01-01&to=2025-01-31&format=csv/,
  )
  await expect(page.getByRole("link", { name: "Abrir documento de origem" })).toHaveAttribute(
    "href",
    "/financeiro/contas-receber/" + record,
  )
})

test("comissões • salva a política de faturamento da linha e atualiza a revisão", async ({ context, page }) => {
  await installFrontendFixture(context)
  const balance = { sellerStaffId: record, sellerName: "Maria", revision: 1, openAmount: "0.00", paidAmount: "0.00" }
  const policies: { id: string; productId: null; productLine: string; trigger: string; commissionRate: string }[] = []
  const book = () => ({
    tenantId: tenant,
    canEdit: true,
    canClose: true,
    data: balance,
    entries: [],
    payments: [],
    closings: [],
    policies,
  })
  await page.route("**/api/erp/commissions?*", (route) =>
    route.fulfill({
      json: {
        tenantId: tenant,
        canEdit: true,
        data: [balance],
        total: 1,
        totals: { openAmount: "0.00", paidAmount: "0.00" },
      },
    }),
  )
  await page.route("**/api/erp/commissions/" + record, (route) =>
    route.fulfill({ headers: { ETag: '"' + balance.revision + '"' }, json: book() }),
  )
  await page.route("**/api/erp/commissions/" + record + "/policies", (route) => {
    const headers = route.request().headers()
    expect(headers["if-match"]).toBe('"1"')
    expect(headers["x-tenant-id"]).toBe(tenant)
    expect(headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/i)
    const input = route.request().postDataJSON()
    expect(input).toEqual({ productId: null, productLine: "national", trigger: "invoice", commissionRate: "6.2500" })
    policies.push({ id: record, ...input })
    balance.revision++
    return route.fulfill({ headers: { ETag: '"2"' }, json: book() })
  })
  await Promise.all([
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/erp/commissions" && response.request().method() === "GET",
      { timeout: 60000 },
    ),
    page.goto("/financeiro/comissoes"),
  ])
  await page.getByRole("button", { name: "Consultar comissões de Maria" }).click()
  await page.getByLabel("Abrangência da política").selectOption("line")
  await page.getByLabel("Apurar comissão no").selectOption("invoice")
  await page.getByLabel("Percentual da política").fill("6,25")
  await page.getByRole("button", { name: "Salvar política" }).click()
  await expect(page.getByText("Linha nacional • 6,2500% • NF-e autorizada")).toBeVisible()
})
