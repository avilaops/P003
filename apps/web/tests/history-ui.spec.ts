import { expect, test } from "@playwright/test"
import { installFrontendFixture, record, tenant } from "./helpers/frontend-fixture"

const category = { id: record, code: "LINHA", name: "Linha Hammer", status: "active", notes: null, parentId: null, sortOrder: 1, revision: 2 }

test("Histórico mostra quem alterou, quando e o quê (antes/depois) na tela do cadastro", async ({ page, context }) => {
  await installFrontendFixture(context)
  await context.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["catalog.categories.read", "catalog.categories.manage"] } }))
  await context.route(`**/api/erp/product-categories/${record}`, route => route.fulfill({ headers: { ETag: '"2"' }, json: { tenantId: tenant, canEdit: true, data: category } }))
  await context.route(`**/api/erp/history/product-categories/${record}`, route => route.fulfill({ json: { tenantId: tenant, entity: "product-categories", nextCursor: null, data: [
    { id: "a1", occurredAt: "2026-11-19T12:30:00.000000Z", actor: "Ana Gestora", action: "product_categories.updated", revision: 2, changes: { name: { before: "Hammer", after: "Linha Hammer" }, sortOrder: { before: 0, after: 1 } } },
    { id: "a0", occurredAt: "2026-11-18T09:00:00.000000Z", actor: "Ana Gestora", action: "product_categories.created", revision: 1, changes: {} },
  ] } }))
  await page.goto(`/cadastros/categorias-produtos/${record}`)
  const history = page.getByRole("region", { name: "Histórico de alterações" })
  await expect(history).toBeVisible()
  await expect(history.getByRole("row", { name: /Ana Gestora Alterado • revisão 2 Nome: Hammer → Linha Hammer Ordem: 0 → 1/ })).toBeVisible()
  await expect(history.getByRole("row", { name: /Criado • revisão 1/ })).toBeVisible()
})

test("Histórico vazio e erro de permissão não quebram a tela", async ({ page, context }) => {
  await installFrontendFixture(context)
  await context.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["catalog.categories.read"] } }))
  await context.route(`**/api/erp/product-categories/${record}`, route => route.fulfill({ headers: { ETag: '"1"' }, json: { tenantId: tenant, canEdit: false, data: { ...category, revision: 1 } } }))
  await context.route(`**/api/erp/history/product-categories/${record}`, route => route.fulfill({ status: 403, json: { title: "Acesso não autorizado para esta empresa" } }))
  await page.goto(`/cadastros/categorias-produtos/${record}`)
  await expect(page.getByRole("heading", { name: "Linha Hammer", level: 1 })).toBeVisible()
  await expect(page.getByRole("region", { name: "Histórico de alterações" }).getByText("Acesso não autorizado para esta empresa")).toBeVisible()
})
