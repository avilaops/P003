import type { Page } from "@playwright/test"

export async function chooseCatalogColor(page: Page, label: string, color: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click()
  await page.getByRole("listbox", { name: label, exact: true }).getByRole("option", { name: color, exact: true }).click()
}
