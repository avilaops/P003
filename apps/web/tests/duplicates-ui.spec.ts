import { expect, test } from "@playwright/test"
import { installFrontendFixture, tenant } from "./helpers/frontend-fixture"

const a = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Agachamento Pêndulo", code: "P1", revision: 1 }
const b = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Agachamento Pendulum", code: "P2", revision: 3 }
const access = { identity: { subject: "fixture", email: "fixture@example.test", name: "Fixture" }, tenant: { id: tenant, legalName: "Empresa sintética", tradeName: null }, roles: [], permissions: ["catalog.products.read", "catalog.products.manage", "catalog.parties.read"] }

test("A tela de duplicados lista os pares suspeitos e a mesclagem envia principal, secundário e revisões", async ({ page, context }) => {
  await installFrontendFixture(context)
  await context.route("**/api/erp/me", route => route.fulfill({ json: access }))
  let merged: Record<string, unknown> | null = null, mergeKey = ""
  await context.route("**/api/erp/data-quality/party/duplicates", route => route.fulfill({ json: { tenantId: tenant, entity: "party", canMerge: false, truncated: false, data: [] } }))
  await context.route("**/api/erp/data-quality/*/completeness", route => route.fulfill({ json: { tenantId: tenant, entity: "product", total: 2, incomplete: 2, counts: { photo: { label: "Sem foto", total: 2 }, ncm: { label: "Sem NCM", total: 1 } }, data: [{ id: a.id, name: a.name, missing: ["photo", "ncm"] }] } }))
  await context.route("**/api/erp/data-quality/product/duplicates", route => route.fulfill({ json: { tenantId: tenant, entity: "product", canMerge: true, truncated: false, data: merged ? [] : [{ a, b, reasons: ["similar_name"], score: 0.89 }] } }))
  await context.route("**/api/erp/data-quality/merge", route => { merged = route.request().postDataJSON(); mergeKey = route.request().headers()["idempotency-key"] ?? ""; return route.fulfill({ json: { tenantId: tenant, entity: "product", primaryId: b.id, secondaryId: a.id, primaryRevision: 4, moved: {} }, headers: { etag: '"4"' } }) })

  await page.goto("/cadastros/duplicados")
  await expect(page.getByRole("heading", { name: "Duplicados e qualidade" })).toBeVisible()
  await expect(page.getByText("Nenhum par suspeito encontrado.")).toBeVisible()
  await page.getByRole("tab", { name: "Produtos" }).click()
  await expect(page.getByText("Sem foto: 2")).toBeVisible()
  await expect(page.getByText("Nome parecido • similaridade 89%")).toBeVisible()
  await page.getByRole("radio").nth(1).check()
  await page.getByRole("button", { name: "Confirmar mesclagem" }).click()
  await expect(page.getByText("“Agachamento Pêndulo” foi mesclado em “Agachamento Pendulum”.")).toBeVisible()
  expect(merged).toEqual({ entity: "product", primaryId: b.id, secondaryId: a.id, primaryRevision: 3, secondaryRevision: 1 })
  expect(mergeKey).toMatch(/^[0-9a-f-]{36}$/)
  await expect(page.getByText("Nenhum par suspeito encontrado.")).toBeVisible()
})

test("sem permissão de gestão a tela só consulta", async ({ page, context }) => {
  await installFrontendFixture(context)
  await context.route("**/api/erp/me", route => route.fulfill({ json: access }))
  await context.route("**/api/erp/data-quality/*/completeness", route => route.fulfill({ json: { tenantId: tenant, entity: "party", total: 0, incomplete: 0, counts: {}, data: [] } }))
  await context.route("**/api/erp/data-quality/party/duplicates", route => route.fulfill({ json: { tenantId: tenant, entity: "party", canMerge: false, truncated: false, data: [{ a, b, reasons: ["same_email"], score: 1 }] } }))
  await page.goto("/cadastros/duplicados")
  await expect(page.getByText("Você pode consultar, mas não mesclar.")).toBeVisible()
  await expect(page.getByRole("radio").first()).toBeDisabled()
})
