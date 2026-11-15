import { expect, test, type Page } from "@playwright/test"

import { installFrontendFixture, tenant, record } from "./helpers/frontend-fixture"



const hash = "a".repeat(64)

const account = { id: record, orderId: record, customerName: "Cliente financeiro", amount: "200.00", receivedAmount: "50.00", outstandingAmount: "150.00", status: "open", dueDate: "2026-12-01", revision: 3 }

const status = { tenantId: tenant, canSend: true, emailReady: true, recipient: "financeiro@example.test", documentTitle: "Título financeiro", scope: "Título registrado • recebido declarado não representa conciliação bancária", recordCount: 1, snapshotHash: hash, deliveries: [] }



async function sources(page: Page) {

  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["finance.receivables.read", "finance.receivables.manage", "finance.payables.read", "finance.payables.manage"] } }))

  await page.route(`**/api/erp/receivables/${record}`, route => route.fulfill({ headers: { ETag: '"3"' }, json: { tenantId: tenant, canEdit: true, data: account, payments: [] } }))

  await page.route("**/api/erp/receivables?*", route => route.fulfill({ json: { tenantId: tenant, data: [account] } }))

  await page.route("**/api/erp/financial-payables?*", route => route.fulfill({ json: { tenantId: tenant, data: [] } }))

}



test.beforeEach(async ({ context, page, baseURL }) => { await installFrontendFixture(context, baseURL); await sources(page) })



for (const kind of ["title", "report"] as const) test(`${kind} confirma destinatário e envia apenas mensagem e hash do servidor`, async ({ page }) => {

  let sends = 0

  const path = kind === "title" ? `/api/erp/receivables/${record}/email` : "/api/erp/financial-report/email"

  await page.route(`**${path}`, route => {

    if (route.request().method() === "GET") return route.fulfill({ headers: { ETag: '"3"' }, json: { ...status, recipient: kind === "title" ? status.recipient : null, scope: kind === "title" ? status.scope : "Primeiros 100 recebíveis e 100 pagáveis • ordenação por vencimento", recordCount: kind === "title" ? 1 : 2 } })

    sends++

    expect(route.request().headers()["if-match"]).toBe('"3"')

    expect(route.request().headers()["idempotency-key"]).toMatch(/^[a-f0-9-]{36}$/)

    expect(route.request().postDataJSON()).toEqual({ recipient: "financeiro@example.test", subject: "Documento conferido", message: "Confira os valores em anexo.", snapshotHash: hash })

    return route.fulfill({ headers: { ETag: '"3"' }, json: { tenantId: tenant, revision: 3, delivery: { id: record, status: "sent", recipient: status.recipient, createdAt: "2026-11-15T12:00:00Z" } } })

  })

  await page.goto(kind === "title" ? `/financeiro/contas-receber/${record}` : "/relatorios/financeiro")

  await page.getByRole("button", { name: "Enviar por e-mail", exact: true }).click()

  const composer = page.getByRole("dialog")

  await expect(composer.getByLabel("Destinatário", { exact: true })).toHaveValue(kind === "title" ? status.recipient : "")

  await expect(composer).toContainText(kind === "title" ? "recebido declarado" : "100 recebíveis")

  await composer.getByLabel("Destinatário", { exact: true }).fill(status.recipient)

  await composer.getByLabel("Assunto", { exact: true }).fill("Documento conferido")

  await composer.getByLabel("Mensagem", { exact: true }).fill("Confira os valores em anexo.")

  expect(sends).toBe(0)

  await composer.getByRole("button", { name: "Enviar e-mail com anexo", exact: true }).click()

  await expect(composer).toContainText("Aceito pelo servidor de e-mail")

  expect(sends).toBe(1)

})



test("resultado incerto sobrevive a fechar e reabrir e consulta o mesmo comando", async ({ page }) => {

  const requests: { key: string; body: unknown }[] = []

  await page.route(`**/api/erp/receivables/${record}/email`, route => {

    if (route.request().method() === "GET") return route.fulfill({ headers: { ETag: '"3"' }, json: status })

    requests.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() })

    return requests.length === 1 ? route.abort("failed") : route.fulfill({ headers: { ETag: '"3"' }, json: { tenantId: tenant, revision: 3, delivery: { id: record, status: "sent", recipient: status.recipient, createdAt: "2026-11-15T12:00:00Z" } } })

  })

  await page.goto(`/financeiro/contas-receber/${record}`)

  await page.getByRole("button", { name: "Enviar por e-mail", exact: true }).click()

  await page.getByRole("dialog").getByRole("button", { name: "Enviar e-mail com anexo", exact: true }).click()

  await expect(page.getByRole("button", { name: "Consultar resultado do envio", exact: true })).toBeEnabled()

  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()

  await page.getByRole("button", { name: "Enviar por e-mail", exact: true }).click()

  await expect(page.getByRole("dialog").getByLabel("Destinatário", { exact: true })).toBeDisabled()

  await page.getByRole("button", { name: "Consultar resultado do envio", exact: true }).click()

  await expect(page.getByRole("dialog")).toContainText("Aceito pelo servidor de e-mail")

  expect(requests).toHaveLength(2)

  expect(requests[1]).toEqual(requests[0])

})



for (const mode of ["permission", "smtp", "tenant"] as const) test(`${mode} bloqueia envio financeiro`, async ({ page }) => {

  await page.route("**/api/erp/financial-report/email", route => route.fulfill({ headers: { ETag: '"1"' }, json: { ...status, recipient: null, canSend: mode !== "permission", emailReady: mode !== "smtp", tenantId: mode === "tenant" ? record : tenant } }))

  await page.goto("/relatorios/financeiro")

  await page.getByRole("button", { name: "Enviar por e-mail", exact: true }).click()

  await expect(page.getByRole("dialog").getByRole("button", { name: "Enviar e-mail com anexo", exact: true })).toBeDisabled()

})



test("412 exige recarregar o snapshot e envia novo hash somente após conferência", async ({ page }) => {


  const sends: { hash: string; revision: string }[] = []

  await page.route("**/api/erp/financial-report/email", route => {

    if (route.request().method() === "GET") { return route.fulfill({ headers: { ETag: '"1"' }, json: { ...status, snapshotHash: sends.length === 0 ? hash : "b".repeat(64) } }) }

    sends.push({ hash: route.request().postDataJSON().snapshotHash, revision: route.request().headers()["if-match"] })

    return sends.length === 1 ? route.fulfill({ status: 412, json: { title: "Fontes alteradas" } }) : route.fulfill({ headers: { ETag: '"1"' }, json: { tenantId: tenant, revision: 1, delivery: { id: record, status: "sent", recipient: status.recipient, createdAt: "2026-11-15T12:00:00Z" } } })

  })

  await page.goto("/relatorios/financeiro")

  await page.getByRole("button", { name: "Enviar por e-mail", exact: true }).click()

  await page.getByRole("dialog").getByLabel("Destinatário", { exact: true }).fill(status.recipient)

  await page.getByRole("button", { name: "Enviar e-mail com anexo", exact: true }).click()

  await page.getByRole("button", { name: "Recarregar documento para conferência", exact: true }).click()

  await page.getByRole("button", { name: "Enviar e-mail com anexo", exact: true }).click()

  await expect(page.getByRole("dialog")).toContainText("Aceito pelo servidor de e-mail")

  expect(sends).toEqual([{ hash, revision: '"1"' }, { hash: "b".repeat(64), revision: '"1"' }])

})

test("comando em andamento continua montado ao fechar e reabrir", async ({ page }) => {

  let release!: () => void

  const waiting = new Promise<void>(resolve => { release = resolve })

  let sends = 0

  await page.route(`**/api/erp/receivables/${record}/email`, async route => {

    if (route.request().method() === "GET") return route.fulfill({ headers: { ETag: '"3"' }, json: status })

    sends++

    await waiting

    return route.fulfill({ headers: { ETag: '"3"' }, json: { tenantId: tenant, revision: 3, delivery: { id: record, status: "sent", recipient: status.recipient, createdAt: "2026-11-15T12:00:00Z" } } })

  })

  await page.goto(`/financeiro/contas-receber/${record}`)

  await page.getByRole("button", { name: "Enviar por e-mail", exact: true }).click()

  await page.getByRole("dialog").getByLabel("Mensagem", { exact: true }).fill("Mensagem em andamento")

  await page.getByRole("dialog").getByRole("button", { name: "Enviar e-mail com anexo", exact: true }).click()

  await expect.poll(() => sends).toBe(1)

  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()

  await page.getByRole("button", { name: "Enviar por e-mail", exact: true }).click()

  await expect(page.getByRole("dialog").getByLabel("Mensagem", { exact: true })).toHaveValue("Mensagem em andamento")

  await expect(page.getByRole("button", { name: "Confirmando envio…", exact: true })).toBeDisabled()

  release()

  await expect(page.getByRole("dialog")).toContainText("Aceito pelo servidor de e-mail")

  expect(sends).toBe(1)

})

test("troca da empresa ativa ao reabrir exige nova conferência", async ({ page }) => {
  let activeTenant = tenant
  let sends = 0
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: activeTenant }, permissions: [] } }))
  await page.route("**/api/erp/financial-report/email", route => {
    if (route.request().method() !== "GET") sends++
    return route.fulfill({ headers: { ETag: '"1"' }, json: status })
  })
  await page.goto("/relatorios/financeiro")
  await page.getByRole("button", { name: "Enviar por e-mail", exact: true }).click()
  await expect(page.getByRole("dialog").getByRole("button", { name: "Enviar e-mail com anexo", exact: true })).toBeEnabled()
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
  activeTenant = record
  await page.getByRole("button", { name: "Enviar por e-mail", exact: true }).click()
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("empresa ativa")
  await expect(page.getByRole("dialog").getByRole("button", { name: "Enviar e-mail com anexo", exact: true })).toBeDisabled()
  expect(sends).toBe(0)
})
