import { expect, test } from "@playwright/test"
import { installFrontendFixture, record, tenant } from "./helpers/frontend-fixture"

const customer = { id: record, legalName: "Cliente de serviços" }
const contract = { id: record, number: "CTS-000001", title: "Manutenção mensal", customerName: customer.legalName, status: "draft", periodicity: "monthly", amountCents: 100000, startOn: "2026-01-10", endOn: "2026-12-31", revision: 1 }
const order = { id: record, number: "OS-000001", title: "Revisão do equipamento", customerName: customer.legalName, serialNumber: "SER-1", technicianName: null, status: "in_progress", scheduledAt: null, slaDueAt: null, laborCents: 0, partsCents: 0, chargeStatus: "none", chargeMessage: null, underWarranty: false, revision: 3, checklist: [{ label: "Limpeza", required: true, done: false }], hours: [], parts: [], photos: [] }

test.beforeEach(async ({ context, page }) => {
  await installFrontendFixture(context)
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant, legalName: "Empresa de teste" }, permissions: [] } }))
  await page.route(/\/api\/erp\/parties\?/, route => route.fulfill({ json: { data: [customer] } }))
})

test("contrato recorrente: lista, alerta e ativação do rascunho", async ({ page }) => {
  const posts: { url: string; revision: string | undefined; key: string | undefined }[] = []
  await page.route(/\/api\/erp\/service-contracts\/alerts/, route => route.fulfill({ json: { data: [{ contractId: record, number: "CTS-000001", customerName: customer.legalName, kind: "adjustment", date: "2026-01-10", overdue: true, message: "Reajuste do ciclo 1 vencido desde 10/01/2026" }] } }))
  await page.route(/\/api\/erp\/service-contracts(\?.*)?$/, route => route.fulfill({ json: { tenantId: tenant, canEdit: true, total: 1, data: [contract] } }))
  await page.route(/\/api\/erp\/service-contracts\/[a-f0-9-]{36}\/transition$/, route => {
    posts.push({ url: route.request().url(), revision: route.request().headers()["if-match"], key: route.request().headers()["idempotency-key"] })
    return route.fulfill({ json: { data: { ...contract, status: "active", revision: 2 } } })
  })
  await page.goto("/servicos/contratos/recorrentes")
  await expect(page.getByText("Reajuste do ciclo 1 vencido desde 10/01/2026")).toBeVisible()
  await expect(page.getByText("CTS-000001")).toBeVisible()
  await page.getByRole("button", { name: "Ativar" }).click()
  await expect.poll(() => posts.length).toBe(1)
  expect(posts[0]!.revision).toBe('"1"')
  expect(posts[0]!.key).toMatch(/^[a-f0-9-]{36}$/)
})

test("ordem de serviço no celular: checklist, horas e fechamento exigem assinatura do cliente", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const calls: string[] = []
  await page.route(/\/api\/erp\/warranty-service-orders/, route => route.fulfill({ json: { data: [] } }))
  await page.route(/\/api\/erp\/service-orders(\?.*)?$/, route => route.fulfill({ json: { tenantId: tenant, canEdit: true, total: 1, data: [order] } }))
  await page.route(/\/api\/erp\/service-orders\/[a-f0-9-]{36}$/, route => route.fulfill({ json: { data: order } }))
  await page.route(/\/api\/erp\/service-orders\/[a-f0-9-]{36}\/(checklist|hours|close)$/, route => { calls.push(new URL(route.request().url()).pathname.split("/").pop()!); return route.fulfill({ json: { data: order } }) })
  await page.goto("/servicos/ordens")
  await page.getByRole("button", { name: /OS-000001/ }).click()
  await page.getByLabel("Limpeza *").check()
  await expect.poll(() => calls).toContain("checklist")
  await page.getByLabel("Minutos").fill("45"); await page.getByLabel("R$/hora").fill("120,00")
  await page.getByRole("button", { name: "Lançar horas" }).click()
  await expect.poll(() => calls).toContain("hours")
  await page.getByLabel("Nome de quem assina").fill("Maria Cliente")
  page.once("dialog", dialog => dialog.accept())
  await page.getByRole("button", { name: "Fechar com assinatura" }).click()
  expect(calls).not.toContain("close")
  const pad = page.getByLabel("Assinatura do cliente"), box = (await pad.boundingBox())!
  await page.mouse.move(box.x + 20, box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + 120, box.y + 60, { steps: 6 }); await page.mouse.up()
  await page.getByRole("button", { name: "Fechar com assinatura" }).click()
  await expect.poll(() => calls).toContain("close")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
