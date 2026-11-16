import { expect, test } from "@playwright/test"
import { installFrontendFixture, tenant, record } from "./helpers/frontend-fixture"
import type { Schema } from "../src/lib/api/types"

test.beforeEach(async ({ context }) => installFrontendFixture(context))
for (const kind of ["pedidos", "propostas"] as const) {
  for (const canEdit of [true, false]) test(`${kind} • rascunho filtra no servidor e respeita consulta ${canEdit}`, async ({ page }) => {
    let requested = ""
    await page.route(`**/api/erp/${kind === "pedidos" ? "orders" : "proposals"}?**`, route => {
      requested = route.request().url()
      return route.fulfill({ json: { tenantId: tenant, canEdit, total: 1, data: [{ id: record, number: "17", customerName: "CLIENTE COM NOME COMERCIAL EXTENSO PARA CONFERÊNCIA", status: "draft", amount: "199128.86", version: 1, validUntil: "2026-12-30" }] } })
    })
    await page.goto(`/vendas/${kind}?status=draft&q=CLIENTE&offset=25`)
    await expect(page.getByRole("heading", { name: kind === "pedidos" ? "Pedidos de venda" : "Propostas", exact: true })).toBeVisible()
    await expect(page.getByRole("combobox", { name: "Situação" })).toHaveValue("draft")
    const region = page.getByRole("region", { name: `Lista de ${kind}`, exact: true })
    await expect(region.getByText("CLIENTE COM NOME COMERCIAL EXTENSO PARA CONFERÊNCIA", { exact: true })).toBeVisible()
    expect(new URL(requested).searchParams.get("status")).toBe("draft")
    expect(new URL(requested).searchParams.get("offset")).toBe("25")
    await expect(region.getByRole("link", { name: /CLIENTE/ })).toHaveCount(0)
    const action = region.getByRole("link", { name: canEdit ? /Continuar/ : /Abrir/ })
    const destination = new URL(await action.getAttribute("href") || "", "http://fixture.test")
    expect(destination.pathname).toBe(`/vendas/${kind}/${record}${canEdit ? "/editar" : ""}`)
    expect(destination.searchParams.get("returnTo")).toBe(`/vendas/${kind}?status=draft&q=CLIENTE&offset=25`)
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
      await expect(action).toBeVisible()
    }
  })
  test(`${kind} • distingue vazio de filtros e permite recuperar falha`, async ({ page }) => {
    let failure = false
    await page.route(`**/api/erp/${kind === "pedidos" ? "orders" : "proposals"}?**`, route => failure ? route.fulfill({ status: 503, json: { title: "Falha temporária" } }) : route.fulfill({ json: { tenantId: tenant, canEdit: true, total: 0, data: [] } }))
    await page.goto(`/vendas/${kind}`)
    await expect(page.getByText(kind === "pedidos" ? "Nenhum pedido cadastrado." : "Nenhuma proposta cadastrada.")).toBeVisible()
    await page.getByRole("combobox", { name: "Situação" }).selectOption("draft")
    await expect(page.getByText(/para estes filtros\./)).toBeVisible()
    failure = true
    await page.getByRole("button", { name: "Pesquisar", exact: true }).click()
    await expect(page.getByRole("alert").filter({ hasText: "Falha temporária" })).toBeVisible()
    failure = false
    await page.getByRole("button", { name: "Tentar novamente" }).click()
    await expect(page.getByText(/para estes filtros\./)).toBeVisible()
  })
}

test("menu de novo pedido fecha com Escape, restaura foco e fecha ao clicar fora", async ({ page }) => {
  await page.route("**/api/erp/orders?**", route => route.fulfill({ json: { tenantId: tenant, canEdit: true, total: 0, data: [] } }))
  await page.goto("/vendas/pedidos")
  const trigger = page.getByRole("button", { name: "Mais opções de novo pedido" })
  await trigger.focus()
  await page.keyboard.press("ArrowDown")
  const item = page.getByRole("menuitem", { name: "Pedido pelo catálogo" })
  await expect(item).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(item).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(item).toBeVisible()
  // A modal menu's dismissal layer receives the outside pointer event.
  const heading = (await page.getByRole("heading", { name: "Pedidos de venda", exact: true }).boundingBox())!
  await page.mouse.click(heading.x + heading.width / 2, heading.y + heading.height / 2)
  await expect(item).toBeHidden()
})

test("retorno do detalhe preserva busca, situação, página e rolagem da empresa", async ({ page }) => {
  const rows = Array.from({ length: 25 }, (_, index) => ({ id: index === 24 ? record : `${record.slice(0, -2)}${String(index).padStart(2, "0")}`, number: String(index + 1), customerId: record, customerName: `Cliente ${index + 1}`, customerTaxId: "52998224725", status: "draft", amount: "100.00", dueDate: "2026-12-30", pricingOrigin: false, revision: 1, updatedAt: "2026-11-16T12:00:00Z" } satisfies Schema<"OrderSummary">))
  const detail = { tenantId: tenant, canEdit: false, pricingOrigin: false, data: rows[24], items: [] } satisfies Schema<"OrderSnapshot">
  await page.route("**/api/erp/orders?**", route => route.fulfill({ json: { tenantId: tenant, canEdit: false, total: 75, data: rows } }))
  await page.route(`**/api/erp/orders/${record}?**`, route => route.fulfill({ json: detail }))
  await page.route(`**/api/erp/orders/${record}`, route => route.fulfill({ json: detail }))
  const list = "/vendas/pedidos?q=Cliente&status=draft&offset=25"
  await page.setViewportSize({ width: 390, height: 600 })
  await page.goto(list)
  const last = page.getByRole("region", { name: "Lista de pedidos", exact: true }).getByRole("link", { name: "Abrir PV-000025", exact: true })
  await last.scrollIntoViewIfNeeded()
  const before = await page.evaluate(() => window.scrollY)
  expect(before).toBeGreaterThan(100)
  await last.click()
  await expect(page.getByRole("heading", { name: "PV-000025", exact: true })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp("/vendas/pedidos\\?q=Cliente&status=draft&offset=25$"))
  await expect(page.getByRole("combobox", { name: "Situação" })).toHaveValue("draft")
  await expect(page.getByRole("searchbox", { name: "Buscar pedidos" })).toHaveValue("Cliente")
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before - 80)
})

test("rascunho com condições comerciais preservadas abre detalhe sem oferecer editor genérico", async ({ page }) => {
  await page.route("**/api/erp/orders?**", route => route.fulfill({ json: { tenantId: tenant, canEdit: true, total: 1, data: [{ id: record, number: "17", customerName: "Cliente comercial", status: "draft", pricingOrigin: true, amount: "100.00" }] } }))
  await page.goto("/vendas/pedidos?status=draft")
  const region = page.getByRole("region", { name: "Lista de pedidos", exact: true })
  await expect(region.getByRole("link", { name: /Continuar/ })).toHaveCount(0)
  const action = region.getByRole("link", { name: /Abrir/ })
  await expect(action).toHaveAttribute("href", new RegExp(`/vendas/pedidos/${record}\\?returnTo=`))
  await expect(region.getByText("Rascunho", { exact: true }).filter({ visible: true })).toBeVisible()
})
