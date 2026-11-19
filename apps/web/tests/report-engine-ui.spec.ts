import { expect, test } from "@playwright/test"
import { installFrontendFixture, tenant } from "./helpers/frontend-fixture"

// Jornada do motor de relatórios (G3): montar, pré-visualizar, salvar, abrir, agendar e consultar o histórico.
const id = "33333333-3333-4333-8333-333333333333", scheduleId = "44444444-4444-4444-8444-444444444444", runId = "55555555-5555-4555-8555-555555555555"
const source = {
  id: "sales_orders", label: "Vendas por período", area: "vendas", description: "Pedidos de venda emitidos no período.", permissions: ["sales.orders.read"],
  columns: { number: { label: "Número", type: "number" }, customer: { label: "Cliente", type: "text", groupable: true }, status: { label: "Situação", type: "text", groupable: true }, amount: { label: "Valor (R$)", type: "money", aggregatable: true } },
  filters: { period: { kind: "period", label: "Período de emissão", required: true }, status: { kind: "choice", label: "Situação", options: { confirmed: "Confirmado", cancelled: "Cancelado" } } },
  defaultColumns: ["number", "customer", "amount"],
}
const result = {
  title: "Vendas por cliente", sourceLabel: "Vendas por período", generatedAt: "2026-11-19T12:00:00Z", filters: [{ key: "period", label: "Período de emissão", value: "2026-10-01 a 2026-10-31" }],
  columns: [{ key: "customer", label: "Cliente", type: "text" }, { key: "count", label: "Quantidade", type: "number" }, { key: "sum_amount", label: "Soma de Valor (R$)", type: "money" }],
  rows: [{ customer: "Cliente Alfa", count: 2, sum_amount: 123456 }], totals: { count: 2, sum_amount: 123456 },
  totalColumns: [{ key: "count", label: "Quantidade", type: "number" }, { key: "sum_amount", label: "Soma de Valor (R$)", type: "money" }], rowCount: 1,
}

test.beforeEach(async ({ context, page, baseURL }) => {
  await installFrontendFixture(context, baseURL)
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["system.reports.read", "system.reports.manage", "sales.orders.read"] } }))
})

test("relatórios configuráveis: monta com agrupamento e total, salva, agenda o envio e mostra o histórico", async ({ page }) => {
  const definitions: object[] = []
  let saved: Record<string, unknown> | undefined, scheduleBody: Record<string, unknown> | undefined, scheduled = false
  await page.route("**/api/erp/system/custom-reports", async route => {
    if (route.request().method() === "POST") {
      saved = route.request().postDataJSON()
      definitions.push({ ...saved, id, revision: 1 })
      return route.fulfill({ status: 201, headers: { etag: '"1"' }, json: { tenantId: tenant, data: definitions.at(-1) } })
    }
    return route.fulfill({ json: { tenantId: tenant, data: definitions, engineSources: [source], stockSources: {}, canEdit: true } })
  })
  await page.route("**/api/erp/reports/preview", route => route.fulfill({ json: { tenantId: tenant, data: result } }))
  await page.route(`**/api/erp/reports/definitions/${id}/run`, route => route.fulfill({ json: { tenantId: tenant, data: result } }))
  await page.route(`**/api/erp/reports/definitions/${id}/schedules`, async route => {
    if (route.request().method() === "POST") {
      scheduleBody = route.request().postDataJSON(); scheduled = true
      return route.fulfill({ status: 201, headers: { etag: '"1"' }, json: { tenantId: tenant, data: { id: scheduleId, ...scheduleBody, weekday: 1, monthDay: null, active: true, nextRunAt: "2026-11-23T10:00:00Z", revision: 1 } } })
    }
    return route.fulfill({ json: { tenantId: tenant, canEdit: true,
      data: scheduled ? [{ id: scheduleId, frequency: "weekly", weekday: 1, monthDay: null, hour: 7, format: "xlsx", recipients: ["financeiro@example.test"], active: true, nextRunAt: "2026-11-23T10:00:00Z", revision: 1 }] : [],
      runs: scheduled ? [{ id: runId, status: "sent", format: "xlsx", rowCount: 1, fileName: "vendas-por-cliente-2026-11-16.xlsx", error: null, scheduledFor: "2026-11-16T10:00:00Z", recipients: ["financeiro@example.test"] }] : [] } })
  })

  await page.goto("/relatorios/configuraveis?fonte=sales_orders")
  await expect(page.getByRole("heading", { name: "Relatórios configuráveis" })).toBeVisible()
  await page.getByLabel("Nome").fill("Vendas por cliente")
  await page.getByRole("group", { name: "Agrupar por (até 2)" }).getByLabel("Cliente").check()
  await page.getByLabel("Soma de Valor (R$)").check()
  await page.getByRole("combobox", { name: "Período de emissão" }).selectOption("previous_month")
  await page.getByRole("combobox", { name: "Situação" }).selectOption("confirmed")
  await page.getByRole("button", { name: "Gerar prévia" }).click()
  await expect(page.getByRole("table", { name: "Vendas por cliente" }).getByText("Cliente Alfa")).toBeVisible()
  await expect(page.getByText("R$ 1.234,56").first()).toBeVisible()

  await page.getByRole("button", { name: "Salvar relatório" }).click()
  await expect(page.getByRole("status")).toContainText("Relatório \"Vendas por cliente\" salvo")
  expect(saved).toMatchObject({ dataset: "sales_orders", groupBy: ["customer"], totals: [{ column: "amount", fn: "sum" }], filters: { period: { preset: "previous_month" }, status: "confirmed" } })

  await page.getByRole("link", { name: "Abrir, exportar e agendar" }).click()
  await expect(page).toHaveURL(new RegExp(`/relatorios/configuraveis/${id}$`))
  await expect(page.getByRole("link", { name: "Excel (XLSX)" })).toHaveAttribute("href", `/api/erp/reports/definitions/${id}/run?format=xlsx`)
  await expect(page.getByText("Nenhum envio realizado ainda.")).toBeVisible()
  await page.getByLabel("E-mails (separe por vírgula)").fill("financeiro@example.test")
  await page.getByRole("button", { name: "Agendar envio" }).click()
  await expect(page.getByRole("status")).toContainText("Agenda criada")
  expect(scheduleBody).toMatchObject({ frequency: "weekly", weekday: 1, hour: 7, format: "xlsx", recipients: ["financeiro@example.test"] })
  await expect(page.getByText("Toda segunda, 07h")).toBeVisible()
  await expect(page.getByRole("link", { name: "vendas-por-cliente-2026-11-16.xlsx" })).toHaveAttribute("href", `/api/erp/reports/runs/${runId}/file`)
  await expect(page.getByRole("cell", { name: "Enviado" })).toBeVisible()
})
