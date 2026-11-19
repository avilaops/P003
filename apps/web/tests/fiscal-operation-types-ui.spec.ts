import { expect, test } from "@playwright/test"
import { installFrontendFixture, tenant } from "./helpers/frontend-fixture"

const base = { code: "REM-CONSERTO", name: "Remessa para conserto", direction: "outgoing", purpose: "repair_shipment", nfePurpose: 1, cfopInternal: "5915", cfopInterstate: "6915", cfopForeign: null,
  icmsCst: null, icmsCsosn: null, ipiCst: null, pisCst: "08", cofinsCst: "08", ibsCbsCst: null, ibsCbsClass: null, movesStock: true, generatesFinance: false, generatesCommission: false,
  requiresOrigin: false, financialCategoryId: null, isDefault: true, active: true }

test.beforeEach(async ({ context }) => installFrontendFixture(context))

test("tipos de operação listam incompletos, cadastram com idempotência e mostram o que falta", async ({ page }) => {
  const items: Record<string, unknown>[] = []
  let posts = 0
  await page.route("**/api/erp/fiscal/operation-types", async route => {
    if (route.request().method() === "POST") {
      posts++
      expect(route.request().headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/)
      const body = route.request().postDataJSON() as Record<string, unknown>
      expect(body.generatesFinance).toBe(false)
      items.push({ ...body, id: "11111111-1111-4111-8111-111111111111", revision: 1, complete: false, missing: ["CSOSN do ICMS"] })
      return route.fulfill({ status: 201, json: { tenantId: tenant, data: items[0] } })
    }
    return route.fulfill({ json: { tenantId: tenant, canEdit: true, data: items } })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/preferencias/fiscal/tipos-operacao")
  await expect(page.getByText("Nenhum tipo de operação cadastrado.")).toBeVisible()
  await page.getByRole("button", { name: "Novo tipo" }).click()
  const form = page.getByRole("form", { name: "Tipo de operação" })
  await form.getByLabel("Código", { exact: true }).fill("REM-CONSERTO")
  await form.getByLabel("Descrição", { exact: true }).fill("Remessa para conserto")
  await form.getByLabel("Finalidade", { exact: true }).selectOption("repair_shipment")
  await form.getByLabel("CFOP no estado", { exact: true }).fill("5915")
  await form.getByLabel("CFOP fora do estado", { exact: true }).fill("6915")
  await form.getByLabel("CST PIS", { exact: true }).fill("08")
  await form.getByLabel("CST COFINS", { exact: true }).fill("08")
  await form.getByLabel("Gera financeiro", { exact: true }).uncheck()
  await form.getByLabel("Gera comissão", { exact: true }).uncheck()
  await form.getByRole("button", { name: "Salvar" }).click()
  await expect(page.getByRole("status")).toContainText("Tipo de operação salvo.")
  await expect(page.getByRole("row", { name: /REM-CONSERTO/ })).toContainText("Incompleto: CSOSN do ICMS")
  expect(posts).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
