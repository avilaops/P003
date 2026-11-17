import type { Page } from "@playwright/test"
import type { ProductFinishes } from "../../src/features/sales/order-product-details"

export async function installProductFinishesFixture(page: Page, tenantId: string, products: (Pick<ProductFinishes, "id" | "name"> & Partial<ProductFinishes>)[]) {
  const catalog = new Map(products.map(product => [product.id, {
    structureColors: [], swingArmColors: [], upholsteryColors: [], plateHolderColors: [], plateHolderTypes: [],
    finishingPalette: "", upholsteryConfigurable: false, weight: null, ...product,
  }]))
  await page.route("**/api/erp/products/finishes?*", route => {
    const ids = (new URL(route.request().url()).searchParams.get("ids") || "").split(",")
    return route.fulfill({ json: { tenantId, data: ids.flatMap(id => catalog.get(id) ?? []), missingIds: ids.filter(id => !catalog.has(id)) } })
  })
}
