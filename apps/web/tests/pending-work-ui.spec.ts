import { expect, test } from "@playwright/test"
import { installFrontendFixture, tenant } from "./helpers/frontend-fixture"

const item = (key: string, group: string, title: string, count: number, href: string, extra: object = {}) => ({ key, group, title, count, amountCents: null, href, action: null, ...extra })
const stale = item("sales.stale-orders", "sales", "Pedidos em rascunho parados há mais de 7 dias", 2, "/vendas/pedidos?status=draft&stale=true", { amountCents: "40450" })
const overdue = item("finance.overdue-receivables", "finance", "Contas a receber vencidas", 1, "/relatorios/financeiro?side=receivable&status=open&to=2026-11-18")
const account = item("setup.financial-account", "setup", "Nenhuma conta financeira ativa", 1, "/cadastros/contas-financeiras", { action: { label: "Cadastrar conta", href: "/cadastros/contas-financeiras" } })
const snapshot = (items: object[]) => ({ tenantId: tenant, asOf: "2026-11-19T12:00:00Z", total: items.reduce((sum: number, entry) => sum + (entry as { count: number }).count, 0), items })

test.beforeEach(async ({ context }) => installFrontendFixture(context))

test("pendências: cada item leva à lista com o mesmo total e o sino mostra o contador", async ({ page }) => {
  await page.route("**/api/erp/pending-work", route => route.fulfill({ json: snapshot([stale, overdue, account]) }))
  await page.goto("/")
  const panel = page.getByRole("region", { name: "Precisa da sua atenção" })
  await expect(panel.getByRole("link", { name: /2 Pedidos em rascunho parados/ })).toHaveAttribute("href", "/vendas/pedidos?status=draft&stale=true")
  await expect(panel.getByRole("link", { name: /1 Contas a receber vencidas/ })).toHaveAttribute("href", "/relatorios/financeiro?side=receivable&status=open&to=2026-11-18")
  await expect(panel.getByRole("link", { name: "Cadastrar conta" })).toHaveAttribute("href", "/cadastros/contas-financeiras")
  await expect(page.getByTestId("bell-count")).toHaveText("4")
})

test("pendências: itens resolvidos somem sem recarregar a página", async ({ page }) => {
  let resolved = false
  await page.route("**/api/erp/pending-work", route => route.fulfill({ json: snapshot(resolved ? [overdue] : [stale, overdue]) }))
  await page.goto("/")
  const panel = page.getByRole("region", { name: "Precisa da sua atenção" })
  await expect(panel.getByText("Pedidos em rascunho parados")).toBeVisible()
  resolved = true
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(panel.getByText("Pedidos em rascunho parados")).toHaveCount(0)
  await expect(page.getByTestId("bell-count")).toHaveText("1")
})

test("pendências: perfil sem acesso não vê o bloco nem o contador", async ({ page }) => {
  await page.route("**/api/erp/pending-work", route => route.fulfill({ status: 403, json: { title: "Seu perfil não acompanha pendências desta empresa" } }))
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Visão geral" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Precisa da sua atenção" })).toHaveCount(0)
  await expect(page.getByTestId("bell-count")).toHaveCount(0)
})
