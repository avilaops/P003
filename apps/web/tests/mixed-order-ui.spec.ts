import { expect, test } from "@playwright/test"
import { installProductFinishesFixture } from "./helpers/product-finishes-fixture"
import { installFrontendFixture, tenant } from "./helpers/frontend-fixture"

const versions = { imported: "11111111-1111-4111-8111-111111111112", national: "11111111-1111-4111-8111-111111111113" }
const equipment = [
  { productId: "22222222-2222-4222-8222-222222222221", name: "Estação importada", sku: "IMP-01", unit: "UN", priceWithoutIpiCents: 100000, priceWithIpiCents: 113000, ipiBps: 1300, available: true },
  { productId: "22222222-2222-4222-8222-222222222222", name: "Banco nacional", sku: "NAC-01", unit: "UN", priceWithoutIpiCents: 50000, priceWithIpiCents: 50000, ipiBps: 0, available: true },
]
const pix = "66666666-6666-4666-8666-666666666666"
const boleto = "77777777-7777-4777-8777-777777777777"

test("seletor navega por teclado, mantém a busca aberta e rola sem deslocar o pedido", async ({ page, context, baseURL }) => {
  await installFrontendFixture(context, baseURL)
  const imported = { ...equipment[0], name: "Estação de puxada articulada" }
  const national = { ...equipment[1], name: "Banco de extensão lombar com regulagem de altura" }
  const alternateSource = { ...imported, name: "Estação no catálogo nacional", sku: "NAC-02", priceWithIpiCents: 95000, priceWithoutIpiCents: 95000, ipiBps: 0 }
  const other = Array.from({ length: 15 }, (_, index) => ({
    ...equipment[0],
    productId: `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
    name: `Estação de puxada ${index + 1}`,
    sku: `EXT-${index + 1}`,
  }))
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["sales.orders.read", "sales.orders.manage", "catalog.products.read"] } }))
  for (const [line, items] of [["imported", [imported, ...other]], ["national", [national, alternateSource]]] as const) {
    await page.route(`**/api/erp/commercial/tables/${line}`, route => route.fulfill({ json: { tenantId: tenant, line, canManage: false, canCreateOrder: true, authority: "seller", data: { id: versions[line], version: 1, publishedAt: "2026-11-16T10:00:00Z", originState: "SP", freeDiscountBps: 2000, minimumDownPaymentBps: 7000, items } } }))
  }
  const photo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4O0AAAAASUVORK5CYII="
  await page.route(`**/api/erp/products/${imported.productId}`, route => route.fulfill({ json: { tenantId: tenant, data: { ...imported, id: imported.productId, photoDataUrl: photo } } }))

  await page.goto("/vendas/pedidos/novo")
  const search = page.getByLabel("Buscar equipamento", { exact: true })
  const card = page.getByRole("region", { name: "Equipamentos", exact: true })
  const results = page.getByRole("listbox", { name: "Equipamentos encontrados" })
  const importedOption = results.getByRole("option", { name: /Estação de puxada articulada.*IMP-01/ })
  const nationalOption = results.getByRole("option", { name: /Banco de extensão lombar.*NAC-01/ })

  const height = await card.evaluate(element => element.clientHeight)
  await search.focus()
  await expect(search).toHaveAttribute("aria-expanded", "true")
  await expect(results.getByRole("option")).toHaveCount(18)
  await expect(importedOption.locator("img")).toHaveAttribute("src", photo)
  await expect(importedOption).toContainText("Importada")
  await expect(importedOption).toContainText("1.130,00")
  expect(await card.evaluate(element => element.clientHeight)).toBe(height)

  await search.press("Escape")
  await expect(results).toBeHidden()
  await expect(search).toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  const mobileHeight = await card.evaluate(element => element.clientHeight)
  await search.click()
  await expect(results).toBeVisible()
  expect(await results.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight && element.scrollHeight > element.clientHeight
  })).toBe(true)
  expect(await card.evaluate(element => element.clientHeight)).toBe(mobileHeight)

  await search.fill("articulada estacao")
  await expect(results.getByRole("option")).toHaveCount(1)
  await search.press("ArrowDown")
  await expect(search).toHaveAttribute("aria-activedescendant", (await importedOption.getAttribute("id"))!)
  await search.press("Enter")
  const quantity = page.getByLabel(`Quantidade de ${imported.name}`, { exact: true })
  await expect(quantity).toHaveValue("1")
  await expect(search).toBeFocused()
  await expect(search).toHaveValue("")
  await expect(results).toBeHidden()
  await search.press("ArrowDown")
  await expect(importedOption).toContainText("Acrescentar 1 un.")

  await search.fill("imp-01")
  await search.press("Enter")
  await expect(quantity).toHaveValue("2")
  await search.fill("nac-02")
  await expect(results.getByRole("option", { name: /NAC-02/ })).toBeDisabled()
  await search.press("Enter")
  await expect(quantity).toHaveValue("2")
  await search.fill("puxada estacao")
  await search.press("ArrowDown")
  await search.press("ArrowDown")
  await search.press("Enter")
  await expect(page.getByLabel("Quantidade de Estação de puxada 1", { exact: true })).toHaveValue("1")

  await search.fill("lombar extensao nac-01")
  await expect(nationalOption).toHaveCount(1)
  await nationalOption.click()
  await expect(page.getByLabel(`Quantidade de ${national.name}`, { exact: true })).toHaveValue("1")
  await expect(search).toBeFocused()
  await page.getByText("Novo pedido", { exact: true }).click()
  await expect(results).toBeHidden()

  await search.focus()
  await expect(results).toBeVisible()
  await search.press("Tab")
  await expect(results).toBeHidden()
  await expect(search).not.toBeFocused()
  await expect(page.getByRole("heading", { name: "Novo pedido", exact: true })).toBeVisible()
})

test("novo pedido reúne ambas as tabelas e só libera proposta após cálculo atual", async ({ page, context, browserName }, info) => {
  await installFrontendFixture(context)
  await installProductFinishesFixture(page, tenant, equipment.map(item => ({ id: item.productId, name: item.name, weight: "20" })))
  const inputs: Record<string, unknown>[] = []
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["sales.orders.read", "sales.orders.manage", "catalog.parties.read", "catalog.products.read"] } }))
  await page.route("**/api/erp/company", route => route.fulfill({ json: { tenantId: tenant, data: { legalName: "Emitente da proposta", taxId: "12345678000190" } } }))
  const customer = { id: "44444444-4444-4444-8444-444444444444", revision: 1, personType: "juridica", legalName: "Cliente da proposta atual", taxId: "11222333000181", isCustomer: true, isSupplier: false, status: "active", addresses: [], contacts: [] }
  await page.route("**/api/erp/parties?*", route => route.fulfill({ json: { tenantId: tenant, data: [customer], total: 1 } }))
  await page.route(`**/api/erp/parties/${customer.id}`, route => route.fulfill({ headers: { ETag: '"1"' }, json: { tenantId: tenant, data: customer } }))
  for (const [index, line] of ["imported", "national"].entries()) {
    await page.route(`**/api/erp/commercial/tables/${line}*`, route => route.fulfill({ json: { tenantId: tenant, line, canManage: false, canCreateOrder: true, authority: "seller", paymentMethods: [{ id: pix, name: "PIX", kind: "pix" }, { id: boleto, name: "Boleto", kind: "boleto" }], data: { id: versions[line as keyof typeof versions], version: index + 1, publishedAt: "2026-11-16T10:00:00Z", originState: "SP", freeDiscountBps: 2000, minimumDownPaymentBps: 7000, items: [equipment[index]] } } }))
    await page.route(`**/api/erp/products/${equipment[index].productId}*`, route => route.fulfill({ json: { tenantId: tenant, data: { ...equipment[index], id: equipment[index].productId, weight: "20", structureColors: [], upholsteryColors: [], upholsteryConfigurable: false } } }))
  }
  await page.route("**/api/erp/commercial/mixed/simulate", route => {
    const input = route.request().postDataJSON()
    inputs.push(input)
    const items = input.items.map((item: { productId: string; quantity: number; line: string; versionId: string }) => { const source = equipment.find(product => product.productId === item.productId)!; return { ...item, name: source.name, sku: source.sku, tableUnitCents: source.priceWithoutIpiCents, netCents: source.priceWithoutIpiCents * item.quantity, ipiCents: (source.priceWithIpiCents - source.priceWithoutIpiCents) * item.quantity, totalCents: source.priceWithIpiCents * item.quantity, ipiBps: source.ipiBps } })
    const sum = (key: string) => items.reduce((total: number, item: Record<string, number>) => total + item[key], 0)
    return route.fulfill({ json: { tenantId: tenant, digest: "a".repeat(64), director: null, sale: { calculatorVersion: "mixed-fixture", items, policyGroups: [], tableTotalCents: sum("netCents"), discountCents: 0, discountBps: 0, netSaleCents: sum("netCents"), ipiBps: items.length > 1 ? null : items[0].ipiBps, ipiCents: sum("ipiCents"), totalCents: sum("totalCents"), freeDiscountBps: 2000, minimumDownPaymentBps: null, minimumDownPaymentCents: 100000, downPaymentCents: 100000, freightCents: 0, approvalReasons: [] } } })
  })
  await page.goto("/vendas/pedidos/novo")
  await expect(page.getByRole("heading", { name: "Novo pedido", exact: true })).toHaveCSS("font-size", "32px")
  await expect(page.getByLabel("Tabela de preços", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Copiar proposta", exact: true })).toBeDisabled()
  const search = page.getByLabel("Buscar equipamento", { exact: true })
  await search.fill("Estação")
  await page.getByRole("option", { name: /Estação importada.*IMP-01/ }).click()
  await search.fill("Banco")
  await page.getByRole("option", { name: /Banco nacional.*NAC-01/ }).click()
  await search.press("Escape")
  await expect.poll(() => inputs.at(-1)?.items).toEqual(expect.arrayContaining(equipment.map((item, index) => expect.objectContaining({ productId: item.productId, line: index === 0 ? "imported" : "national", versionId: index === 0 ? versions.imported : versions.national }))))
  expect(inputs.at(-1)).not.toHaveProperty("versionId")
  await expect(page.locator(".order-proposal-heading").getByText("Liberado", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Pesquisar cliente", exact: true }).click()
  await page.getByRole("button", { name: "Selecionar Cliente da proposta atual", exact: true }).click()
  await page.getByLabel("Forma da entrada", { exact: true }).selectOption(pix)
  await page.getByLabel("Forma do saldo", { exact: true }).selectOption(boleto)
  await page.getByLabel("Prazo de fabricação", { exact: true }).fill("45")
  await page.getByLabel("Parcelas", { exact: true }).fill("2")
  await page.getByRole("button", { name: "Gerar parcelas", exact: true }).click()
  await page.getByLabel("Valor da parcela 1 (R$)", { exact: true }).fill("300,00")
  await page.getByLabel("Vencimento da parcela 1", { exact: true }).fill("2026-12-20")
  await page.getByLabel("Observações do pagamento", { exact: true }).fill("Condição comercial conferida")
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (globalThis as typeof globalThis & { copiedProposal: string }).copiedProposal = text } } }) })
  await page.getByRole("button", { name: "Copiar proposta", exact: true }).click()
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { copiedProposal: string }).copiedProposal)).toContain("Banco nacional")
  const copied = await page.evaluate(() => (globalThis as typeof globalThis & { copiedProposal: string }).copiedProposal)
  expect(copied).toContain("Cliente da proposta atual")
  expect(copied).toContain("PIX")
  expect(copied).toContain("Boleto")
  expect(copied).toContain("300,00")
  expect(copied).toContain("20/12/2026")
  expect(copied).toContain("Condição comercial conferida")
  expect(copied).toContain("45 dias úteis")
  expect(copied).toContain("conferência")
  await expect(page.getByLabel("Inscrição estadual", { exact: true })).not.toHaveAttribute("aria-invalid", "true")
  await page.getByRole("button", { name: "Salvar PDF", exact: true }).click()
  const document = page.locator("[data-commercial-document]")
  await expect(document).toContainText("Emitente da proposta")
  await expect(document).toContainText("Estação importada")
  await expect(document).toContainText("Banco nacional")
  await expect(document).toContainText("1.630,00")
  await expect(document).toContainText("Cliente da proposta atual")
  await expect(document).toContainText("300,00")
  await expect(document).toContainText("20/12/2026")
  await expect(document).toContainText("Condição comercial conferida")
  await expect(document).toContainText("45 dias úteis")
  await expect(document.locator("p").filter({ hasText: /^Pagamento:/ })).toHaveCSS("white-space", "pre-line")
  await expect(page.getByRole("button", { name: "Imprimir • salvar PDF", exact: true })).toBeEnabled()
  await page.emulateMedia({ media: "print" })
  await expect(page.getByRole("button", { name: "Salvar pedido", exact: true })).toBeHidden()
  const overflow = await document.evaluate(article => {
    const bounds = article.getBoundingClientRect()
    return [...article.querySelectorAll<HTMLElement>(".commercial-section-body p, th, td")].filter(element => {
      const box = element.getBoundingClientRect()
      return element.scrollWidth > element.clientWidth + 1 || box.left < bounds.left - 1 || box.right > bounds.right + 1
    }).map(element => element.textContent)
  })
  expect(overflow).toEqual([])
  if (browserName === "chromium") await page.pdf({ path: info.outputPath("proposta-mista.pdf"), preferCSSPageSize: true, printBackground: true })
  await page.emulateMedia({ media: "screen" })
})
