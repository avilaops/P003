import { expect, test } from "@playwright/test"
import { installFrontendFixture, tenant } from "./helpers/frontend-fixture"

test.beforeEach(async ({ context, page, baseURL }) => {
  await installFrontendFixture(context, baseURL)
  await page.route("**/api/erp/me", route => route.fulfill({ json: { tenant: { id: tenant }, permissions: [] } }))
  await page.route("**/api/erp/company", route => route.fulfill({ json: { tenantId: tenant, data: { legalName: "Empresa do relatório", taxId: "12345678000190" } } }))
})

test("estoque apresenta documento da página atual e preserva CSV", async ({ page }) => {
  await page.route("**/api/erp/stock?*", route => route.fulfill({ json: { tenantId: tenant, offset: 0, limit: 100, total: 125, data: [{ productId: "one", sku: "EST-1", name: "Produto registrado", unit: "UN", quantity: "8", reserved: "2", available: "6", status: "active" }] } }))
  await page.goto("/relatorios/estoque")
  await expect(page.getByRole("button", { name: "Exportar CSV" })).toBeEnabled()
  await page.getByRole("button", { name: "Visualizar impressão/PDF" }).click()
  const document = page.locator("[data-report-document]")
  await expect(document).toContainText("Empresa do relatório")
  await expect(document).toContainText("Página 1")
  await expect(document).toContainText("100 registros")
  await expect(document).toContainText("Produto registrado")
  await expect(page.getByRole("button", { name: "Imprimir / salvar PDF" })).toBeEnabled()
  await page.emulateMedia({ media: "print" })
  await expect(page.getByRole("button", { name: "Exportar CSV" })).toBeHidden()
  await expect(document).toBeVisible()
})

test("estoque longo mantém as linhas e o padrão no PDF A4", async ({ page, browserName }, info) => {
  test.skip(browserName !== "chromium", "Exportação PDF do navegador disponível no Chromium")
  const data = Array.from({ length: 55 }, (_, index) => ({ productId: `product-${index}`, sku: `EST-${String(index + 1).padStart(3, "0")}`, name: `Equipamento registrado ${index + 1} com descrição e acabamento para conferência`, unit: "UN", quantity: "8", reserved: "2", available: "6", status: "active" }))
  await page.route("**/api/erp/stock?*", route => route.fulfill({ json: { tenantId: tenant, offset: 0, limit: 100, total: 55, data } }))
  await page.goto("/relatorios/estoque")
  await page.getByRole("button", { name: "Visualizar impressão/PDF" }).click()
  const report = page.locator("[data-report-document]")
  await expect(report).toContainText("EST-055")
  await expect(report).toContainText("Empresa do relatório")
  await page.emulateMedia({ media: "print" })
  await expect(page.getByRole("button", { name: "Exportar CSV" })).toBeHidden()
  await page.pdf({ path: info.outputPath("relatorio-estoque-padrao.pdf"), preferCSSPageSize: true, printBackground: true })
})

test("emissor de outra empresa impede a impressão", async ({ page }) => {
  await page.route("**/api/erp/company", route => route.fulfill({ json: { tenantId: "other", data: { legalName: "Outra empresa" } } }))
  await page.route("**/api/erp/stock?*", route => route.fulfill({ json: { tenantId: tenant, offset: 0, limit: 100, total: 1, data: [{ productId: "one", sku: "EST-1", name: "Produto registrado", unit: "UN", quantity: "8", reserved: "2", available: "6", status: "active" }] } }))
  await page.goto("/relatorios/estoque")
  await page.getByRole("button", { name: "Visualizar impressão/PDF" }).click()
  await expect(page.getByRole("region", { name: "Visualização do relatório" }).getByRole("alert")).toContainText("empresa ativa")
  await expect(page.locator("[data-report-document]")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Imprimir / salvar PDF" })).toBeDisabled()
})

test("análise indisponível não oferece impressão", async ({ page }) => {
  await page.goto("/dashboards/curva-abc")
  await expect(page.getByRole("button", { name: "Visualizar impressão/PDF" })).toHaveCount(0)
})

for (const kind of ["financeiro", "servicos"]) {
  test(`${kind} imprime os registros persistidos e mantém a exportação`, async ({ page }) => {
    await page.route("**/api/erp/receivables?*", route => route.fulfill({ json: { tenantId: tenant, data: [{ id: "r1", customerName: "Cliente registrado", amount: "120.00", outstandingAmount: "80.00", status: "open", dueDate: "2026-12-01" }] } }))
    await page.route("**/api/erp/financial-payables?*", route => route.fulfill({ json: { tenantId: tenant, data: [] } }))
    await page.route("**/api/erp/warranty-service-orders?*", route => route.fulfill({ json: { tenantId: tenant, data: [{ id: "s1", protocol: "OS-123", title: "Reparo registrado", status: "completed", laborCents: 15000, updatedAt: "2026-11-15" }] } }))
    await page.goto(`/relatorios/${kind}`)
    await page.getByRole("button", { name: "Visualizar impressão/PDF" }).click()
    const document = page.locator("[data-report-document]")
    await expect(document).toContainText(kind === "financeiro" ? "Cliente registrado" : "Reparo registrado")
    await expect(document).toContainText("100 registros")
    await expect(document).toContainText("Empresa do relatório")
    await expect(page.getByRole("button", { name: "Exportar CSV" })).toBeEnabled()
    await expect(page.getByRole("button", { name: "Imprimir / salvar PDF" })).toBeEnabled()
  })
}

for (const kind of ["executivo"]) {
  test(`relatório ${kind} inclui o período e preserva indicadores sem permissão`, async ({ page }) => {
    await page.route("**/api/erp/dashboard?*", route => route.fulfill({ json: { tenantId: tenant, startDate: "2026-06-01", endDate: "2026-11-15", products: null, customers: null, receivables: null, purchasePayables: null, sales: { orders: 2, amount: "500.00", average: "250.00", cancelled: 1 }, salesSeries: [{ month: "2026-11", orders: 2, amount: "500.00", average: "250.00" }] } }))
    await page.goto(`/relatorios/${kind}`)
    await page.getByRole("button", { name: "Visualizar impressão/PDF" }).click()
    const document = page.locator("[data-report-document]")
    await expect(document).toContainText("01/06/2026 a 15/11/2026")
    await expect(document).toContainText("11/2026")
    await expect(document).toContainText("500,00")
    if (kind === "executivo") await expect(document).toContainText("Sem permissão")
  })
}

test("falha na consulta impede CSV e impressão", async ({ page }) => {
  await page.route("**/api/erp/stock?*", route => route.fulfill({ status: 403, json: { title: "Sem acesso ao estoque" } }))
  await page.goto("/relatorios/estoque")
  await expect(page.getByRole("button", { name: "Visualizar impressão/PDF" })).toBeDisabled()
  await expect(page.getByRole("button", { name: "Exportar CSV" })).toBeDisabled()
  await expect(page.locator("[data-report-document]")).toHaveCount(0)
})

test("dados de outra empresa não são emitidos com o cadastro ativo", async ({ page }) => {
  await page.route("**/api/erp/stock?*", route => route.fulfill({ json: { tenantId: "other", offset: 0, limit: 100, total: 1, data: [{ productId: "one", sku: "EST-1", name: "Produto de outra empresa", unit: "UN", quantity: "8", reserved: "2", available: "6", status: "active" }] } }))
  await page.goto("/relatorios/estoque")
  await page.getByRole("button", { name: "Visualizar impressão/PDF" }).click()
  await expect(page.getByRole("region", { name: "Visualização do relatório" }).getByRole("alert")).toContainText("empresa ativa")
  await expect(page.locator("[data-report-document]")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Imprimir / salvar PDF" })).toBeDisabled()
})
for (const kind of ["produtos", "clientes"]) {
  test(`dashboard ${kind} imprime somente os indicadores correspondentes`, async ({ page }) => {
    await page.route("**/api/erp/dashboard?*", route => route.fulfill({ json: { tenantId: tenant, startDate: "2026-06-01", endDate: "2026-11-15", products: 12, customers: 7, receivables: null, purchasePayables: null, sales: null, salesSeries: null } }))
    await page.goto(`/dashboards/${kind}`)
    await page.getByRole("button", { name: "Visualizar impressão/PDF" }).click()
    const document = page.locator("[data-report-document]")
    await expect(document).toContainText(kind === "produtos" ? "Produtos ativos" : "Clientes ativos")
    await expect(document).toContainText(kind === "produtos" ? "12" : "7")
    await expect(document.getByRole("columnheader", { name: "Pedidos", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Imprimir / salvar PDF" })).toBeEnabled()
  })
}

test("relatório de vendas conserva filtros, concilia as três datas e protege as exportações de margem",async({page})=>{
 const seller="33333333-3333-4333-8333-333333333333",id="22222222-2222-4222-8222-222222222222"
 const report="/relatorios/vendas?from=2026-06-01&to=2026-11-15&seller="+seller+"&channel=loja&origin=invoiced"
 let authorized=false
 await page.route("**/api/erp/commercial/policies/performance?*",route=>{
  const q=new URL(route.request().url()).searchParams
  expect(q.get("from")).toBe("2026-06-01");expect(q.get("to")).toBe("2026-11-15");expect(q.get("seller")).toBe(seller);expect(q.get("channel")).toBe("loja")
  return route.fulfill({json:{tenantId:tenant,manage:authorized,channels:["loja"],sellers:[{id:seller,name:"Ana"}],goals:[],totals:{orders:0,cancelled:0,orderedCents:"0",averageCents:"0",invoicedCents:"11501",returnedCents:"0",receivedCents:"3000"},
   orders:[{id,number:"45",customer:"Cliente conciliado",date:"2026-01-02",status:"confirmed",createdInPeriod:false,seller:"Ana",channel:"loja",cents:"0",invoicedCents:"11501",returnedCents:"0",receivedCents:"3000"}],
   abc:[{id,sku:"SKU-1",name:"Equipamento",quantityMicros:"1000000",cents:"11501",accumulatedBps:10000,class:"A"}],margins:authorized?[{id,number:"45",customer:"Cliente conciliado",forecastGrossCents:"4100",forecastNetCents:"3500",actualRevenueCents:"10001",actualCostCents:"6000",actualGrossCents:"4001"}]:null}})
 })
 await page.goto(report)
 const order=page.getByRole("table",{name:"Pedidos"})
 await expect(order.getByRole("row",{name:/Cliente conciliado/})).toContainText("115,01")
 await expect(order).toContainText("30,00")
 await expect(page.getByRole("button",{name:"Margem por pedido"})).toHaveCount(0)
 await order.getByRole("link",{name:"45",exact:true}).click()
 const back=page.getByRole("link",{name:"Voltar ao relatório com os filtros"})
 await expect(back).toHaveAttribute("href",/channel=loja/,{timeout:45000})
 await back.click()
 await page.getByRole("button",{name:"Curva ABC",exact:true}).click()
 await expect(page.getByRole("table",{name:"Curva ABC"})).toContainText("SKU-1")
 await page.getByRole("button",{name:"Visualizar impressão/PDF"}).click()
 await expect(page.locator("[data-report-document]")).toContainText("01/06/2026 a 15/11/2026")
 await expect(page.locator("[data-report-document]")).toContainText("loja • Ana")
 await page.goto(report+"&view=margins")
 await expect(page.getByRole("button",{name:"Exportar CSV"})).toHaveCount(0)
 authorized=true
 await page.getByRole("button",{name:"Atualizar",exact:true}).click()
 await expect(page.getByRole("table",{name:"Margem por pedido"})).toContainText("40,01")
 const download=page.waitForEvent("download");await page.getByRole("button",{name:"Exportar CSV"}).click()
 const stream=await (await download).createReadStream(),chunks=[]
 for await(const chunk of stream!)chunks.push(Buffer.from(chunk))
 const csv=Buffer.concat(chunks).toString("utf8")
 expect(csv).toContain("Margem bruta realizada");expect(csv).toContain("40,01");expect(csv).toContain("Ana")
})
