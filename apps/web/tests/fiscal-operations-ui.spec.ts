import { expect, test } from "@playwright/test"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { once } from "node:events"
import { installFrontendFixture, tenant, record } from "./helpers/frontend-fixture"
import { origin } from "../playwright.danfe.config"
import { allocateAmount, amountTotal, reallocateAmounts } from "../src/features/fiscal/nfe-amount-allocation"

const draft = { environment: "homologation", model: 55, operationNature: "Venda", taxRuleReference: "Instrução de teste", recipient: { taxId: "11222333000181", legalName: "Cliente de teste", state: "SP", municipalityCode: "3549805", postalCode: "15035000", street: "Rua Teste", number: "1", district: "Centro" }, items: [{ code: "P1", description: "Produto", unit: "UN", ncm: "95069100", cfop: "5102", quantity: "1.0000", unitPrice: "100.0000000000", grossTotal: "100.00", origin: 0, csosn: "102", icmsCst: null, pisCst: "07", cofinsCst: "07" }], productsTotal: "100.00", payments: [{ code: "17", amount: "100.00", description: null }] }
const nfceKey = `${"35261012345678000195550010000001231482917364".slice(0, 20)}65${"35261012345678000195550010000001231482917364".slice(22)}`
const nfceXml = "<nfeProc xmlns=\"http://www.portalfiscal.inf.br/nfe\"><NFe><infNFe><ide><mod>65</mod></ide></infNFe></NFe></nfeProc>"
const nfcePdf = Buffer.from("%PDF-1.7 NFC-e synthetic")
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")

test.beforeEach(async ({ context }) => installFrontendFixture(context))

test("rateio preserva centavos, proporções e os demais valores dos itens", () => {
  const items = ["10", "20", "30"].map(unitPrice => ({ ...draft.items[0], unitPrice, insuranceAmount: "2.00" }))
  const allocated = allocateAmount(items, "freightAmount", "10,01")
  expect(allocated.map(item => item.freightAmount)).toEqual(["1.67", "3.34", "5.00"])
  expect(amountTotal(allocated, "freightAmount")).toBe("10.01")
  expect(amountTotal(allocated, "insuranceAmount")).toBe("6.00")
  expect(items[0]).not.toHaveProperty("freightAmount")
  expect(allocateAmount(items, "discountAmount", "0").map(item => item.discountAmount)).toEqual(["0.00", "0.00", "0.00"])
  expect(() => allocateAmount(items, "discountAmount", "61")).toThrow("desconto")
  expect(() => allocateAmount(items, "freightAmount", "-1")).toThrow()
  expect(() => allocateAmount([{ ...items[0], unitPrice: "0" }], "freightAmount", "1")).toThrow("preços")
})

test("rateio acompanha produtos e preserva os ajustes individuais", () => {
  const items = ["100", "200", "300"].map(unitPrice => ({ ...draft.items[0], unitPrice, freightAmount: "5.00" }))
  const rules = { freightAmount: { total: "60", locked: [0] } }
  const allocated = reallocateAmounts(items, rules)
  expect(allocated.map(item => item.freightAmount)).toEqual(["5.00", "22.00", "33.00"])
  expect(amountTotal(reallocateAmounts(allocated.slice(0, 2), rules), "freightAmount")).toBe("60.00")
  expect(() => reallocateAmounts([{ ...items[0], freightAmount: "61" }, items[1]], rules)).toThrow("superam")
  expect(() => reallocateAmounts([items[0]], rules)).toThrow("Todos")
  expect(() => reallocateAmounts([{ ...items[1], unitPrice: "" }], { freightAmount: { total: "60", locked: [] } })).toThrow()
})

test("tributação em linhas e totais da nota atualizam os itens sem accordions", async ({ page }) => {
  await page.route("**/api/erp/registration-settings/tax-profiles", route => route.fulfill({ json: { tenantId: tenant, revision: 1, data: { profiles: [] } } }))
  await page.route("**/api/erp/fiscal/readiness", route => route.fulfill({ json: { tenantId: tenant, environment: "homologation", profileConfigured: true, canTransmit: false, blockers: [] } }))
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["fiscal.nfe.read", "fiscal.nfe.manage"] } }))
  await page.route(`**/api/erp/fiscal/nfe/${record}`, route => route.fulfill({ headers: { ETag: '"1"' }, json: { tenantId: tenant, canEdit: true, data: { id: record, revision: 1, input: { ...draft, items: [draft.items[0], { ...draft.items[0], description: "Segundo produto", unitPrice: "200.00" }] }, issuer: { legalName: "Empresa teste" } } } }))
  await page.route(`**/api/erp/fiscal/nfe/${record}/emission`, route => route.fulfill({ status: 404, json: {} }))
  await page.goto(`/fiscal/notas-saida/${record}`)
  await page.getByRole("button", { name: "2. Destinatário", exact: true }).click()
  await expect(page.getByRole("combobox", { name: "Tipo de pessoa", exact: true })).toHaveCount(0)
  await expect(page.getByLabel("CPF/CNPJ", { exact: true })).toBeHidden()
  await page.getByRole("button", { name: "Editar dados desta nota", exact: true }).click()
  await expect(page.getByLabel("CPF/CNPJ", { exact: true })).toHaveValue("11222333000181")
  await page.getByRole("button", { name: "Concluir edição do destinatário", exact: true }).click()
  await page.getByRole("button", { name: "3. Produtos", exact: true }).click()
  await page.getByLabel("Frete total (R$)", { exact: true }).fill("10")
  await page.getByRole("button", { name: "6. Revisão e emissão", exact: true }).click()
  await expect(page.getByRole("button", { name: "Salvar rascunho", exact: true })).toBeDisabled()
  await expect(page.getByText("Volte à etapa Produtos para aplicar ou descartar os totais digitados antes de salvar.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "3. Produtos", exact: true }).click()
  await page.getByRole("button", { name: "Aplicar totais aos itens", exact: true }).click()
  await page.getByRole("button", { name: "Ajustar valores por item", exact: true }).click()
  await expect(page.getByLabel("Frete do item 1 (R$)", { exact: true })).toHaveValue("3.33")
  await expect(page.getByLabel("Frete do item 2 (R$)", { exact: true })).toHaveValue("6.67")
  await expect(page.getByLabel("Totais da nota", { exact: true })).toContainText("310,00")
  await page.getByLabel("Frete do item 1 (R$)", { exact: true }).fill("4")
  await expect(page.getByLabel("Frete do item 2 (R$)", { exact: true })).toHaveValue("6.00")
  await page.getByLabel("Preço unitário do item 2", { exact: true }).fill("300")
  await expect(page.getByLabel("Frete do item 1 (R$)", { exact: true })).toHaveValue("4")
  await expect(page.getByLabel("Totais da nota", { exact: true })).toContainText("410,00")
  await page.getByRole("button", { name: "4. Tributação", exact: true }).click()
  const table = page.getByRole("table", { name: "Tributação dos itens", exact: true })
  await expect(table.locator("tbody tr")).toHaveCount(2)
  await expect(table.getByRole("columnheader")).toHaveCount(8)
  await page.getByLabel("CFOP do item 2", { exact: true }).fill("6102")
  await expect(page.getByLabel("CFOP", { exact: true })).toHaveValue("5102")
  await page.getByLabel("CFOP do item 2", { exact: true }).fill("")
  await page.getByRole("button", { name: "6. Revisão e emissão", exact: true }).click()
  await expect(page.getByText("Preenchimento avulso • sem pedido vinculado", { exact: false })).toBeVisible()
  await page.getByRole("button", { name: "Corrigir • CFOP do item 2", exact: true }).click()
  await expect(page.getByLabel("CFOP do item 2", { exact: true })).toBeFocused()
  await page.getByLabel("CFOP do item 2", { exact: true }).fill("6102")
  await expect(page.locator('[data-editor-step="3"] details')).toHaveCount(0)
  await page.getByRole("button", { name: "Adicionar declaração tributária CRT 3", exact: true }).click()
  await expect(page.getByLabel("Alíquota do ICMS (%)", { exact: true })).toBeVisible()
  await page.screenshot({ path: "../../artifacts/nfe-tax-compact-desktop.png", fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(table).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
  await page.screenshot({ path: "../../artifacts/nfe-tax-compact-mobile.png", fullPage: true })
})

test("nova nota mostra a transmissão e salvar abre a nota sem transmitir", async ({ page }) => {
  let saved = draft, creates = 0, issues = 0
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["fiscal.nfe.read", "fiscal.nfe.manage", "fiscal.nfe.issue"] } }))
  await page.route("**/api/erp/fiscal/readiness", route => route.fulfill({ json: { tenantId: tenant, environment: "homologation", profileConfigured: true, certificateVerified: true, canTransmit: true, productionEnabled: false, blockers: [] } }))
  const snapshot = () => ({ tenantId: tenant, canEdit: true, data: { id: record, revision: 1, input: saved, issuer: { legalName: "Empresa teste" } } })
  await page.route("**/api/erp/fiscal/nfe", route => {
    creates++; saved = route.request().postDataJSON()
    return route.fulfill({ headers: { ETag: '"1"' }, json: snapshot() })
  })
  await page.route(`**/api/erp/fiscal/nfe/${record}`, route => route.fulfill({ headers: { ETag: '"1"' }, json: snapshot() }))
  await page.route(`**/api/erp/fiscal/nfe/${record}/emission`, route => route.fulfill({ status: 404, json: { title: "Sem emissão" } }))
  await page.route(`**/api/erp/fiscal/nfe/${record}/issue`, route => { issues++; return route.fulfill({ status: 500, json: {} }) })
  await page.goto("/fiscal/notas-saida/nova")
  await page.getByRole("button", { name: "6. Revisão e emissão", exact: true }).click()
  await expect(page.getByRole("button", { name: "Transmitir NF-e à SEFAZ em homologação", exact: true })).toBeDisabled()
  await expect(page.getByText("Salve o rascunho para habilitar a transmissão à SEFAZ.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Corrigir • Natureza da operação", exact: true }).click()
  await expect(page.getByLabel("Natureza da operação", { exact: true })).toBeFocused()
  await page.getByRole("button", { name: "1. Dados da nota", exact: true }).click()
  await page.getByLabel("Natureza da operação", { exact: true }).fill("Venda")
  await page.getByLabel("Referência da instrução fiscal", { exact: true }).fill("Instrução de teste")
  await page.getByRole("button", { name: "2. Destinatário", exact: true }).click()
  for (const [label, value] of [["CPF/CNPJ", "11222333000181"], ["Nome ou razão social", "Cliente de teste"], ["Código IBGE do município", "3549805"], ["CEP", "15035000"], ["Logradouro", "Rua Teste"], ["Número", "1"], ["Bairro", "Centro"]]) await page.getByLabel(label, { exact: true }).fill(value)
  await page.getByLabel("UF do destinatário", { exact: true }).selectOption("SP")
  await page.getByRole("button", { name: "3. Produtos", exact: true }).click()
  for (const [label, value] of [["Descrição do produto", "Produto"], ["Código do produto", "P1"], ["Unidade", "UN"], ["Preço unitário", "100"]]) await page.getByLabel(label, { exact: true }).fill(value)
  await page.getByRole("button", { name: "4. Tributação", exact: true }).click()
  for (const [label, value] of [["NCM", "95069100"], ["CFOP", "5102"], ["CSOSN", "102"], ["CST do PIS", "07"], ["CST da COFINS", "07"]]) await page.getByLabel(label, { exact: true }).fill(value)
  await page.getByLabel("Origem da mercadoria", { exact: true }).selectOption("0")
  await page.getByRole("button", { name: "5. Pagamento", exact: true }).click()
  await page.getByRole("button", { name: "Adicionar forma de pagamento", exact: true }).click()
  await page.getByLabel("Forma de pagamento 1", { exact: true }).selectOption("17")
  await page.getByLabel("Valor do pagamento 1", { exact: true }).fill("100")
  await page.getByRole("button", { name: "6. Revisão e emissão", exact: true }).click()
  await page.getByRole("button", { name: "Salvar rascunho", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/fiscal/notas-saida/${record}$`))
  await expect(page.getByRole("button", { name: "Transmitir NF-e à SEFAZ em homologação", exact: true })).toBeEnabled()
  expect(creates).toBe(1)
  expect(issues).toBe(0)
})

test("consulta fiscal mantém endereço e ajustes individuais acessíveis e identifica devolução", async ({ page }) => {
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["fiscal.nfe.read"] } }))
  await page.route("**/api/erp/fiscal/readiness", route => route.fulfill({ json: { tenantId: tenant, profileConfigured: true, blockers: [] } }))
  await page.route(`**/api/erp/fiscal/nfe/${record}`, route => route.fulfill({ headers: { ETag: '"1"' }, json: { tenantId: tenant, canEdit: false, data: { id: record, revision: 1, input: { ...draft, sourceReturnId: record, items: [{ ...draft.items[0], freightAmount: "10.00", additionalInfo: "Detalhe preservado" }] }, issuer: { legalName: "Empresa teste" } } } }))
  await page.route(`**/api/erp/fiscal/nfe/${record}/emission`, route => route.fulfill({ status: 404, json: {} }))
  await page.goto(`/fiscal/notas-saida/${record}`)
  await page.getByRole("button", { name: "2. Destinatário", exact: true }).click()
  await expect(page.getByLabel("CEP", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "3. Produtos", exact: true }).click()
  await expect(page.getByLabel("Frete do item 1 (R$)", { exact: true })).toBeVisible()
  await expect(page.getByLabel("Informações do item 1", { exact: true })).toHaveValue("Detalhe preservado")
  await page.getByRole("button", { name: "6. Revisão e emissão", exact: true }).click()
  await expect(page.getByText(`Devolução vinculada ${record}`, { exact: false })).toBeVisible()
})

for (const environment of ["homologation", "production"]) {
  test(`transmissão mantém os pré-requisitos fiscais em ${environment}`, async ({ page }) => {
    await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["fiscal.nfe.read", "fiscal.nfe.issue"] } }))
    await page.route("**/api/erp/fiscal/readiness", route => route.fulfill({ json: { tenantId: tenant, environment: "homologation", profileConfigured: true, certificateVerified: environment === "production", canTransmit: environment === "production", productionEnabled: false, blockers: environment === "production" ? [] : ["a1_certificate_missing_expired_or_unavailable", "production_emission_disabled"] } }))
    await page.route(`**/api/erp/fiscal/nfe/${record}`, route => route.fulfill({ headers: { ETag: '"1"' }, json: { tenantId: tenant, canEdit: false, data: { id: record, revision: 1, input: { ...draft, environment }, issuer: { legalName: "Empresa teste" } } } }))
    await page.route(`**/api/erp/fiscal/nfe/${record}/emission`, route => route.fulfill({ status: 404, json: { title: "Sem emissão" } }))
    await page.goto(`/fiscal/notas-saida/${record}`)
    await expect(page.getByRole("button", { name: /Transmitir NF-e à SEFAZ em/ })).toBeDisabled()
    await expect(page.getByRole("heading", { name: "Pendências para emitir", exact: true })).toBeVisible()
  })
}

test("homologação permite transmitir após salvar com produção bloqueada", async ({ page }) => {
  let current = draft, revision = 1, issues = 0
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["fiscal.nfe.read", "fiscal.nfe.manage", "fiscal.nfe.issue"] } }))
  await page.route("**/api/erp/fiscal/readiness", route => route.fulfill({ json: { tenantId: tenant, environment: "production", profileConfigured: true, certificateVerified: true, canTransmit: false, productionEnabled: false, blockers: ["production_emission_disabled"] } }))
  await page.route(`**/api/erp/fiscal/nfe/${record}`, route => {
    if (route.request().method() === "PUT") { current = route.request().postDataJSON(); revision++ }
    return route.fulfill({ headers: { ETag: `"${revision}"` }, json: { tenantId: tenant, canEdit: true, data: { id: record, revision, input: current, issuer: { legalName: "Empresa teste" } } } })
  })
  await page.route(`**/api/erp/fiscal/nfe/${record}/emission`, route => route.fulfill({ status: 404, json: { title: "Sem emissão" } }))
  await page.route(`**/api/erp/fiscal/nfe/${record}/issue`, route => {
    issues++
    expect(route.request().headers()["if-match"]).toBe('"2"')
    return route.fulfill({ headers: { ETag: '"3"' }, json: { tenantId: tenant, id: record, status: "rejected", revision: 3 } })
  })
  await page.goto(`/fiscal/notas-saida/${record}`)
  const transmit = page.getByRole("button", { name: "Transmitir NF-e à SEFAZ em homologação", exact: true })
  await expect(transmit).toBeEnabled()
  await expect(page.getByText("Pendências para emitir", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "2. Destinatário", exact: true }).click()
  await page.getByRole("button", { name: "Editar dados desta nota", exact: true }).click()
  await page.getByLabel("Nome ou razão social", { exact: true }).fill("Cliente revisado")
  await page.getByRole("button", { name: "6. Revisão e emissão", exact: true }).click()
  await expect(transmit).toBeDisabled()
  await page.getByRole("button", { name: "Salvar rascunho", exact: true }).click()
  await expect(transmit).toBeEnabled()
  expect(issues).toBe(0)
  page.once("dialog", dialog => dialog.dismiss())
  await transmit.click()
  expect(issues).toBe(0)
  page.once("dialog", dialog => dialog.accept())
  await transmit.click()
  await expect.poll(() => issues).toBe(1)
})

test("transmissão explica a falta de permissão", async ({ page }) => {
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["fiscal.nfe.read", "fiscal.nfe.manage"] } }))
  await page.route("**/api/erp/fiscal/readiness", route => route.fulfill({ json: { tenantId: tenant, environment: "homologation", profileConfigured: true, certificateVerified: true, canTransmit: true, blockers: [] } }))
  await page.goto("/fiscal/notas-saida/nova")
  await page.getByRole("button", { name: "6. Revisão e emissão", exact: true }).click()
  await expect(page.getByText("Você não tem permissão para transmitir notas à SEFAZ (fiscal.nfe.issue).", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Transmitir NF-e à SEFAZ em homologação", exact: true })).toBeDisabled()
})

test("NFC-e usa o fluxo fiscal persistente de modelo 65", async ({ page }) => {
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["fiscal.nfe.read", "fiscal.nfe.manage"] } }))
  await page.route("**/api/erp/fiscal/nfe?*", route => route.fulfill({ json: { tenantId: tenant, data: [], nextCursor: null } }))
  await page.route("**/api/erp/fiscal/readiness", route => route.fulfill({ json: { tenantId: tenant, profileConfigured: true, certificateVerified: true, canTransmit: false, productionEnabled: false, blockers: [] } }))
  await page.goto("/fiscal/nfce")
  await expect(page.getByRole("heading", { name: "Rascunhos de NFC-e", exact: true })).toBeVisible()
  await expect(page.getByText("Nenhum rascunho cadastrado nesta empresa.", { exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Preparar NFC-e", exact: true })).toHaveAttribute("href", "/fiscal/notas-saida/nova?modelo=65")
})

test("NFC-e autorizada gera DANFE e valida XML e PDF pelo BFF", async ({ page }) => {
  const danfeRequests: string[] = []
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["fiscal.nfe.read", "fiscal.nfe.issue"] } }))
  await page.route("**/api/erp/fiscal/readiness", route => route.fulfill({ json: { tenantId: tenant, profileConfigured: true, certificateVerified: true, canTransmit: true, productionEnabled: false, blockers: [] } }))
  await page.route(`**/api/erp/fiscal/nfe/${record}`, route => route.fulfill({ headers: { ETag: '"3"' }, json: { tenantId: tenant, canEdit: false, data: { id: record, revision: 3, status: "draft", input: { ...draft, model: 65 }, issuer: { legalName: "Empresa teste" } } } }))
  await page.route(`**/api/erp/fiscal/nfe/${record}/emission`, route => route.fulfill({ headers: { ETag: '"4"' }, json: { tenantId: tenant, id: record, status: "authorized", environment: "homologation", model: 65, revision: 4, number: 1, series: 1, accessKey: nfceKey, protocol: "135260000000001", result: {} } }))
  await page.route(`**/api/erp/fiscal/nfe/${record}/xml`, route => route.fulfill({ headers: { "Content-Type": "application/xml; charset=utf-8" }, body: nfceXml }))
  await page.route("**/api/erp/fiscal/danfe", async route => {
    const body = route.request().postDataJSON() as { xml: string }
    danfeRequests.push(body.xml)
    return route.fulfill({
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="DANFE-${nfceKey}.pdf"`,
        "X-XML-SHA256": digest(nfceXml),
        "X-PDF-SHA256": digest(nfcePdf),
      },
      body: nfcePdf,
    })
  })
  await page.goto(`/fiscal/nfce/${record}`)
  await expect(page.getByText("Situação fiscal: Autorizada em homologação", { exact: true })).toBeVisible()
  const downloading = page.waitForEvent("download")
  await page.getByRole("button", { name: "Gerar DANFE NFC-e", exact: true }).click()
  const downloaded = await downloading
  expect(downloaded.suggestedFilename()).toBe(`DANFE-${nfceKey}.pdf`)
  expect(await downloaded.failure()).toBeNull()
  await expect(page.locator("#fiscal-emission iframe")).toHaveCount(0)
  await expect(page.getByText("Download do DANFE iniciado.", { exact: true })).toBeVisible()
  expect(danfeRequests).toEqual([nfceXml])
  await page.route(`**/api/erp/fiscal/nfe/${record}/email`, route => route.fulfill({ headers: { ETag: '"4"' }, json: {
    tenantId: tenant, recipientEmail: "fiscal@example.test", status: "ready", smtpConfigured: true, attachments: ["XML autorizado da NFC-e"],
  } }))
  await page.getByRole("button", { name: "Enviar por e-mail" }).click()
  await expect(page.getByRole("region", { name: "Envio da NFC-e por e-mail" })).toContainText("Anexos • XML autorizado da NFC-e")
})

test("NFS-e emitida oferece o XML autorizado e confirma o destinatário", async ({ page }) => {
  let sent = false
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant } } }))
  await page.route("**/api/erp/fiscal/outgoing-nfses?offset=0", route => route.fulfill({ json: {
    tenantId: tenant, canSend: true, hasMore: false, data: [{ id: record, number: "12", environment: "homologation", accessKey: "1".repeat(50) }],
  } }))
  await page.route(`**/api/erp/fiscal/outgoing-nfses/${record}/email`, route => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ recipientEmail: "tomador@example.test" })
      sent = true
    }
    return route.fulfill({ headers: { ETag: '"1"' }, json: { tenantId: tenant, recipientEmail: "tomador@example.test",
      status: sent ? "sent" : "ready", smtpConfigured: true, attachments: ["XML autorizado da NFS-e"] } })
  })
  await page.goto("/fiscal/nfses/emitidas")
  await page.getByRole("button", { name: "Enviar por e-mail" }).click()
  const panel = page.getByRole("region", { name: "Envio da NFS-e por e-mail" })
  await expect(panel).toContainText("Anexos • XML autorizado da NFS-e")
  await panel.getByRole("button", { name: "Confirmar envio" }).click()
  await expect(panel.getByRole("status")).toHaveText("O serviço de e-mail aceitou a mensagem com o XML.")
})

test("envio da NF-e exibe o destinatário e exige confirmação para enviar os anexos", async ({ page }) => {
  const recipientEmail = "fiscal@example.test"
  const url = `**/api/erp/fiscal/nfe/${record}`
  let sent = 0
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["fiscal.nfe.read", "fiscal.nfe.issue"] } }))
  await page.route("**/api/erp/fiscal/readiness", route => route.fulfill({ json: { tenantId: tenant, environment: "homologation", blockers: [] } }))
  await page.route(url, route => route.fulfill({ headers: { ETag: '"1"' }, json: { tenantId: tenant, canEdit: false, data: { id: record, revision: 1, input: draft, issuer: { legalName: "Empresa teste" } } } }))
  await page.route(`${url}/emission`, route => route.fulfill({ headers: { ETag: '"3"' }, json: {
    tenantId: tenant, id: record, status: "authorized", environment: "homologation", model: 55,
    revision: 3, number: 4, series: 1, accessKey: "35261012345678000195550010000001231482917364", result: {},
  } }))
  await page.route(`${url}/email`, route => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ recipientEmail })
      expect(route.request().headers()["idempotency-key"]).toBeTruthy()
      expect(route.request().headers()["if-match"]).toBe('"3"')
      sent++
    }
    return route.fulfill({ headers: { ETag: '"3"' }, json: { tenantId: tenant, recipientEmail, smtpConfigured: true, status: sent ? "sent" : "ready" } })
  })
  await page.goto(`/fiscal/notas-saida/${record}`)
  await page.getByRole("button", { name: "Enviar por e-mail" }).click()
  const panel = page.getByRole("region", { name: "Envio da NF-e por e-mail" })
  await expect(panel.getByText(recipientEmail, { exact: true })).toBeVisible()
  expect(sent).toBe(0)
  await panel.getByRole("button", { name: "Confirmar envio" }).click()
  await expect(panel.getByRole("status")).toHaveText("O serviço de e-mail aceitou a mensagem com os dois anexos.")
  await expect(panel.getByRole("button", { name: "Confirmar envio" })).toHaveCount(0)
  expect(sent).toBe(1)
})

test("lista de NF-e distingue emissão em homologação da produção indisponível", async ({ page }) => {
  await page.route("**/api/erp/fiscal/certificate", route => route.fulfill({ json: { tenantId: tenant, status: "active" } }))
  await page.route("**/api/erp/fiscal/issued-nfes?*", route => route.fulfill({ json: { tenantId: tenant, data: [], nextCursor: null } }))
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["fiscal.nfe.read", "fiscal.nfe.manage"] } }))
  await page.route("**/api/erp/fiscal/nfe?*", route => route.fulfill({ json: { tenantId: tenant, data: [], nextCursor: null } }))
  await page.route("**/api/erp/fiscal/readiness", route => route.fulfill({ json: { tenantId: tenant, profileConfigured: true, certificateVerified: true, canTransmit: true, productionEnabled: false, blockers: [] } }))
  await page.goto("/fiscal/notas-saida")
  await expect(page.getByText("Ambiente: Homologação · sem valor fiscal", { exact: true })).toBeVisible()
  await expect(page.getByText("A transmissão à SEFAZ permanece indisponível.", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Preparar nota", exact: true })).toBeVisible()
})

test("emissão conserva comando em resposta incerta e eventos usam a revisão fiscal", async ({ page }) => {
  const calls: { key: string; revision: string; body: unknown }[] = []
  let issued = false, cancelled = false
  page.on("dialog", dialog => dialog.accept())
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["fiscal.nfe.read", "fiscal.nfe.manage", "fiscal.nfe.issue", "fiscal.nfe.cancel", "fiscal.nfe.correction"] } }))
  await page.route("**/api/erp/fiscal/readiness", route => route.fulfill({ json: { tenantId: tenant, profileConfigured: true, certificateVerified: true, canTransmit: true, productionEnabled: false, blockers: [] } }))
  await page.route(`**/api/erp/fiscal/nfe/${record}`, route => route.fulfill({ headers: { ETag: '"1"' }, json: { tenantId: tenant, canEdit: true, data: { id: record, revision: 1, status: "draft", input: draft, issuer: { legalName: "Empresa teste" } } } }))
  await page.route(`**/api/erp/fiscal/nfe/${record}/emission`, route => issued ? route.fulfill({ headers: { ETag: cancelled ? '"4"' : '"3"' }, json: { tenantId: tenant, id: record, status: cancelled ? "cancelled" : "authorized", revision: cancelled ? 4 : 3, number: 1, series: 1, accessKey: "35261012345678000195550010000001231482917364", protocol: "135260000000001", result: {} } }) : route.fulfill({ status: 404, json: { title: "Sem emissão" } }))
  await page.route(`**/api/erp/fiscal/nfe/${record}/issue`, route => {
    calls.push({ key: route.request().headers()["idempotency-key"], revision: route.request().headers()["if-match"], body: route.request().postDataJSON() })
    issued = true
    return calls.length === 1 ? route.abort("failed") : route.fulfill({ headers: { ETag: '"3"' }, json: { tenantId: tenant, id: record, status: "authorized", revision: 3 } })
  })
  await page.route(`**/api/erp/fiscal/nfe/${record}/cancel`, route => {
    expect(route.request().headers()["if-match"]).toBe('"3"')
    expect(route.request().postDataJSON()).toEqual({ text: "Cancelamento solicitado pelo cliente" })
    cancelled = true
    return route.fulfill({ headers: { ETag: '"4"' }, json: { tenantId: tenant, status: "registered", revision: 4 } })
  })
  await page.goto(`/fiscal/notas-saida/${record}`)
  await page.getByRole("button", { name: "5. Pagamento", exact: true }).click()
  await expect(page.getByRole("combobox", { name: "Forma de pagamento 1", exact: true })).toHaveValue("17")
  await page.getByRole("button", { name: "6. Revisão e emissão", exact: true }).click()
  await page.getByRole("button", { name: "Transmitir NF-e à SEFAZ em homologação", exact: true }).click()
  await page.getByRole("button", { name: "5. Pagamento", exact: true }).click()
  await expect(page.getByRole("combobox", { name: "Forma de pagamento 1", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "6. Revisão e emissão", exact: true }).click()
  await page.getByRole("button", { name: "Conferir mesma operação fiscal", exact: true }).click()
  expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1])
  await expect(page.getByText("Situação fiscal: Autorizada em homologação", { exact: true })).toBeVisible()
  await page.getByRole("combobox", { name: "Evento fiscal", exact: true }).selectOption("cancel")
  await page.getByLabel("Texto do evento", { exact: true }).fill("Cancelamento solicitado pelo cliente")
  await page.getByRole("button", { name: "Transmitir evento fiscal", exact: true }).click()
  await expect(page.getByText("Situação fiscal: Cancelada na SEFAZ", { exact: true })).toBeVisible()
})

for (const scenario of [
  { name: "emissor", grants: ["fiscal.nfe.issue"], cancel: false, correction: false },
  { name: "cancelador", grants: ["fiscal.nfe.cancel"], cancel: true, correction: false },
  { name: "corretor", grants: ["fiscal.nfe.correction"], cancel: false, correction: true },
  { name: "leitor", grants: [], cancel: false, correction: false },
]) {
  test(`eventos fiscais respeitam permissão exclusiva de ${scenario.name} em cinco tamanhos`, async ({ page }) => {
    const commands: string[] = []
    await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: ["fiscal.nfe.read", ...scenario.grants] } }))
    await page.route("**/api/erp/fiscal/readiness", route => route.fulfill({ json: { tenantId: tenant, profileConfigured: true, certificateVerified: true, canTransmit: false, productionEnabled: false, blockers: [] } }))
    await page.route(`**/api/erp/fiscal/nfe/${record}`, route => route.fulfill({ headers: { ETag: '"1"' }, json: { tenantId: tenant, canEdit: false, data: { id: record, revision: 1, status: "draft", input: draft, issuer: { legalName: "Empresa teste" } } } }))
    await page.route(`**/api/erp/fiscal/nfe/${record}/*`, route => {
      if (route.request().method() !== "GET") {
        commands.push(route.request().url())
        expect(route.request().headers()["if-match"]).toBe('"3"')
        expect(route.request().postDataJSON()).toEqual({ text: "Evento sintético da permissão exclusiva" })
      }
      return route.fulfill({ headers: { ETag: '"3"' }, json: { tenantId: tenant, id: record, status: "authorized", revision: 3, number: 1, series: 1, accessKey: "35261012345678000195550010000001231482917364", protocol: "135260000000001", result: {} } })
    })
    await page.route(`**/api/erp/fiscal/nfe/${record}/events`, route => route.fulfill({ json: { tenantId: tenant, data: [] } }))
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/fiscal/notas-saida/${record}`)
      await expect(page.getByText("Situação fiscal: Autorizada em homologação", { exact: true })).toBeVisible()
      const control = page.getByRole("combobox", { name: "Evento fiscal", exact: true })
      if (scenario.cancel || scenario.correction) {
        await expect(control).toBeVisible()
        await expect(control.locator('option[value="cancel"]')).toHaveCount(scenario.cancel ? 1 : 0)
        await expect(control.locator('option[value="correction"]')).toHaveCount(scenario.correction ? 1 : 0)
        await expect(control).toHaveValue(scenario.correction ? "correction" : "cancel")
        const bounds = await control.boundingBox()
        expect(bounds?.height).toBeGreaterThanOrEqual(44)
      } else {
        await expect(control).toHaveCount(0)
      }
      await expect(page.getByRole("button", { name: "Baixar XML da emissão", exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `Largura do documento em ${width}px`).toBeLessThanOrEqual(width)
    }
    expect(commands).toEqual([])
    if (scenario.cancel || scenario.correction) {
      page.on("dialog", dialog => dialog.accept())
      await page.getByLabel("Texto do evento", { exact: true }).fill("Evento sintético da permissão exclusiva")
      await page.getByRole("button", { name: "Transmitir evento fiscal", exact: true }).click()
      await expect(page.getByText("Resultado registrado. Confira a situação fiscal atualizada abaixo.", { exact: true })).toBeVisible()
      expect(commands).toEqual([`${origin}/api/erp/fiscal/nfe/${record}/${scenario.cancel ? "cancel" : "correction"}`])
    }
  })
}

test("BFF encaminha empresa revisão e idempotência e recusa origem ou sessão divergente", async ({ context }) => {
  const seen: { path: string; key?: string; revision?: string; tenant?: string }[] = []
  const backend = createServer((request, response) => {
    seen.push({ path: request.url || "", key: String(request.headers["idempotency-key"] || ""), revision: String(request.headers["if-match"] || ""), tenant: String(request.headers["x-tenant-id"] || "") })
    response.writeHead(202, { "Content-Type": "application/json", ETag: '"2"' }); response.end(JSON.stringify({ status: "unknown", tenantId: tenant }))
  })
  backend.listen(33119, "127.0.0.1"); await once(backend, "listening")
  try {
    const headers = { Origin: origin, "X-Tenant-Id": tenant, "Idempotency-Key": record, "If-Match": '"1"' }
    const result = await context.request.post(`${origin}/api/erp/fiscal/nfe/${record}/issue`, { headers, data: {} })
    expect(result.status()).toBe(202); expect(result.headers()["etag"]).toBe('"2"')
    expect(seen).toEqual([{ path: `/api/v1/fiscal/nfe/${record}/issue`, key: record, revision: '"1"', tenant }])
    expect((await context.request.post(`${origin}/api/erp/fiscal/nfe/${record}/issue`, { headers: { ...headers, Origin: "https://untrusted.example" }, data: {} })).status()).toBe(403)
    expect((await context.request.post(`${origin}/api/erp/fiscal/nfe/${record}/issue`, { headers: { ...headers, "X-Tenant-Id": record }, data: {} })).status()).toBe(409)
    expect(seen).toHaveLength(1)
    const production = await context.request.post(`${origin}/api/erp/production/orders/${record}/consumptions`, { headers, data: { productId: record, quantity: "1.000000", unitCost: "1.00", reason: "Consumo de teste" } })
    expect(production.status()).toBe(202)
    const commission = await context.request.put(`${origin}/api/erp/orders/${record}/commission`, { headers, data: { sellerStaffId: record, commissionRate: "5.0000", ipiRate: "0.0000", paymentDay: 10 } })
    expect(commission.status()).toBe(202)
    expect(seen.slice(1)).toEqual([
      { path: `/api/v1/production/orders/${record}/consumptions`, key: record, revision: '"1"', tenant },
      { path: `/api/v1/orders/${record}/commission`, key: record, revision: '"1"', tenant },
    ])
    expect((await context.request.post(`${origin}/api/erp/commissions/${record}`, { headers, data: {} })).status()).toBe(400)
    expect((await context.request.get(`${origin}/api/erp/production/orders?unknown=1`)).status()).toBe(400)
    expect(seen).toHaveLength(3)
  } finally { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())) }
})
