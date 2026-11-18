import { test, expect, type BrowserContext } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { installSessionCookie, tenant } from "./helpers/frontend-fixture"

const origin = process.env.ERP_TEST_WEB_ORIGIN || "http://127.0.0.1:34242"
const session = (ctx: BrowserContext, user: string) => installSessionCookie(ctx, origin, tenant, "fixture-" + user + "-token")

test("estoque • contagem cega por SKU no celular e aprovação em sessão independente", async ({ context, page }) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(25_000)
  await session(context, "editor")
  await page.setViewportSize({ width: 390, height: 844 })
  const headers = () => ({ Origin: origin, "X-Tenant-Id": tenant, "Idempotency-Key": randomUUID() })
  const category = await context.request.post("/api/erp/product-categories", {
    headers: headers(),
    data: {
      code: "C" + randomUUID().slice(0, 7),
      name: "Categoria conferida",
      status: "active",
      notes: null,
      parentId: null,
      sortOrder: 0,
    },
  })
  expect(category.status(), await category.text()).toBe(201)
  const categoryId = (await category.json()).data.id as string,
    sku = "MOV/" + randomUUID().slice(0, 8).toUpperCase()
  const product = await context.request.post("/api/erp/products", {
    headers: headers(),
    data: {
      sku,
      name: "Peça conferida",
      unit: "KG",
      basePrice: "1.00",
      categoryId,
      ncm: null,
      cest: null,
      status: "active",
    },
  })
  expect(product.status(), await product.text()).toBe(201)
  const productId = (await product.json()).data.id as string
  const nextProduct = await context.request.post("/api/erp/products", {
    headers: headers(),
    data: {sku: sku+"-B", name: "Segunda peça", unit: "UN", basePrice: "1.00", categoryId, ncm: null, cest: null, status: "active"}
  })
  expect(nextProduct.status(), await nextProduct.text()).toBe(201)
  await page.goto("/estoque/inventarios")
  await page.getByRole("link", { name: "Criar inventário" }).click()
  await page.getByRole("textbox", { name: "Referência", exact: true }).fill("Inventário físico mobile")
  await page.getByRole("combobox", { name: "Categoria", exact: true }).selectOption(categoryId)
  await page.getByRole("checkbox", { name: /Contagem cega/ }).check()
  await page.getByRole("spinbutton", { name: /Recontar divergências/ }).fill("5")
  await page.getByRole("button", { name: "Abrir sessão" }).click()
  await expect(page.getByRole("heading", { name: "Inventário físico mobile" })).toBeVisible({timeout:60_000})
  const detailUrl = page.url()
  await expect(page.getByText(/^Esperado •/)).toHaveCount(0)
  await page.getByLabel("Ler código ou SKU").fill(sku)
  await page.getByLabel("Ler código ou SKU").press("Enter")
  await expect(page.getByLabel("Quantidade contada")).toBeFocused()
  await page.getByLabel("Quantidade contada").fill("0,250001")
  await page.getByRole("button", { name: "Registrar quantidade" }).click()
  await expect(page.getByText("Recontagem pendente", { exact: true })).toBeVisible()
  await expect(page.getByLabel("Ler código ou SKU")).toBeFocused()
  await expect(page.getByRole("region",{name:"Registrar contagem"})).toContainText("Segunda peça")
  await page.getByLabel("Quantidade contada").fill("0")
  await page.getByRole("button", { name: "Registrar quantidade" }).click()
  await page.getByLabel("Segunda contagem").fill("0.250001")
  await page.getByRole("button", { name: "Confirmar recontagem" }).click()
  await expect(page.getByText("Contado • 0,250001 KG", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Aprovar ajustes" })).toHaveCount(0)
  await session(context, "reader")
  await page.goto(detailUrl)
  await expect(page.getByRole("heading", { name: "Inventário físico mobile" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Registrar quantidade" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Aprovar ajustes" })).toHaveCount(0)
  await session(context, "visitor")
  await page.goto(detailUrl)
  await page.getByRole("button", { name: "Aprovar ajustes" }).click()
  await expect(page.getByText("Aprovado por visitor", { exact: true })).toBeVisible()
  await session(context, "editor")
  const response = await context.request.get("/api/erp/stock/movements?productId=" + productId)
  const movements = await response.json()
  expect(movements.data).toHaveLength(1)
  expect(movements.data[0]).toMatchObject({
    sourceInventoryCountId: new URL(detailUrl).pathname.split("/").pop(),
    quantity: "0.250001",
    direction: "receipt",
    canReverse: false,
  })
})
