import { expect, test } from "@playwright/test"
import { installFrontendFixture, tenant, record } from "./helpers/frontend-fixture"

const productId = "33333333-3333-4333-8333-333333333333"
const customerId = "44444444-4444-4444-8444-444444444444"
const name = "HammerForce Pro · Desenvolvimento de ombros articulado"
const proposal = { id: record, number: "1", version: 1, revision: 1, customerId, customerName: "Academia de teste", customerTaxId: "52998224725", validUntil: "2100-01-01", paymentTerms: "À vista", deliveryTerms: "Retirada", notes: "", amount: "200.00", status: "draft", expired: false, orderId: null, isCurrent: true, createdAt: "2026-11-11", sentAt: null, decidedAt: null, decidedBy: null, decisionReason: null }
const item = { productId, name, sku: "HF-101", unit: "UN", quantity: "1.000000", unitPrice: "200.00", catalogPrice: "200.00", amount: "200.00", structureColor: "Piano Black", swingArmColor: "Piano Black", upholsteryColor: "Black", plateHolderType: null, plateHolderColor: null }
const structureColors = ["Piano Black", "Matte Graphite Black", "Light Grey", "Performance Red"]
const swingArmColors = [...structureColors, "Hermès Orange", "Apple Green"]
const upholsteryColors = ["Black", "Saddle Brown", "Reddish Brown", "Mocha"]
const finishes = [
  { label: "Braços", field: "swingArmColor", initial: "Piano Black", selected: "Apple Green", photoCount: 6 },
  { label: "Estofado", field: "upholsteryColor", initial: "Black", selected: "Mocha", photoCount: 4 },
]

for (const finish of finishes) for (const width of [320, 390]) test(`proposta mostra fotos de ${finish.label.toLowerCase()} do catálogo e conserva a escolha em ${width}px`, async ({ context, page }, info) => {
  await installFrontendFixture(context)
  await page.route("**/api/erp/commercial/tables/**", route => route.fulfill({ json: { tenantId: tenant, data: null } }))
  await page.route(`**/api/erp/parties/${customerId}`, route => route.fulfill({ json: { tenantId: tenant, data: { id: customerId, personType: "fisica", fiscal: null, addresses: [] } } }))
  await page.setViewportSize({ width, height: 844 })
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["sales.proposals.read", "sales.proposals.manage"] } }))
  let saved: Record<string, unknown> | undefined
  await page.route(`**/api/erp/proposals/${record}`, route => {
    if (route.request().method() === "PUT") saved = route.request().postDataJSON()
    return route.fulfill({ headers: { ETag: '"1"' }, json: { tenantId: tenant, canEdit: true, data: proposal, items: [{ ...item, [finish.field]: saved ? finish.selected : finish.initial }], versions: [proposal] } })
  })
  await page.route(`**/api/erp/products/${productId}`, route => route.fulfill({ json: { tenantId: tenant, data: { id: productId, finishingPalette: "dhz-hammerforce-pro", structureColors, swingArmColors, upholsteryColors, upholsteryConfigurable: true, plateHolderColors: [], plateHolderTypes: [], hasPhoto: false } } }))
  await page.goto(`/vendas/propostas/${record}/editar`)
  const finishes = page.getByRole("region", { name: `Item da proposta: ${name}`, exact: true }).locator("details")
  await expect(finishes).not.toHaveAttribute("open", "")
  await finishes.locator("summary").click()
  const color = page.getByRole("combobox", { name: `${finish.label} de ${name}`, exact: true })
  await expect(color).toContainText(finish.initial)
  await color.click()
  const photos = page.getByRole("listbox", { name: `${finish.label} de ${name}`, exact: true })
  await expect(photos.locator("[data-catalog-color-photo]")).toHaveCount(finish.photoCount)
  await expect(photos.getByRole("option", { name: finish.selected, exact: true })).toBeVisible()
  await expect(photos.locator("[data-catalog-color-photo]").first()).toHaveCSS("width", "46px")
  await expect(photos.locator("[data-catalog-color-photo]").first()).toHaveCSS("background-image", /dhz-hammerforce-pro-original-colors\.jpeg/)
  await expect(photos.getByRole("option", { name: "Amarelo", exact: true })).toHaveCount(0)
  await photos.getByRole("option", { name: finish.selected, exact: true }).focus()
  await page.keyboard.press("Space")
  await expect(color).toContainText(finish.selected)
  await color.click()
  await expect(photos.getByRole("option", { name: finish.selected, exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(photos.getByRole("option", { name: finish.initial, exact: true })).toHaveAttribute("aria-selected", "false")
  if (finish.label === "Braços") {
    await expect(photos.getByRole("option", { name: "Apple Green", exact: true })).toHaveCount(1)
    await expect(page.getByRole("combobox", { name: `Estofado de ${name}`, exact: true })).toContainText("Black")
  } else {
    await expect(page.getByRole("combobox", { name: `Braços de ${name}`, exact: true })).toContainText("Piano Black")
  }
  await page.keyboard.press("Escape")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath(`proposal-catalog-finishes-${finish.label}-${width}.png`) })
  await finishes.locator("summary").click()
  await expect(finishes.locator("summary")).toContainText(finish.selected)
  await page.getByRole("button", { name: "Salvar proposta", exact: true }).click()
  await expect.poll(() => saved).toMatchObject({ items: [{ productId, structureColor: "Piano Black", swingArmColor: finish.label === "Braços" ? finish.selected : "Piano Black", upholsteryColor: finish.label === "Estofado" ? finish.selected : "Black", unitPrice: "200.00" }] })
})
