import { test,expect } from "@playwright/test"
import { createCipheriv,createHash,randomBytes,randomUUID } from "node:crypto"
import { installSessionCookie, tenant as reportTenant } from "./helpers/frontend-fixture"

test("estoque • análise valorizada, Kardex, CSV completo e impressão",async({page,context})=>{
  const tenant="11111111-1111-4111-8111-111111111111",origin=process.env.ERP_TEST_WEB_ORIGIN!
  await page.route("**/api/erp/me",route=>route.fulfill({json:{tenant:{id:tenant}}}))
  await page.route("**/api/erp/company",route=>route.fulfill({json:{tenantId:tenant,data:{legalName:"Empresa do relatório de estoque"}}}))
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",createHash("sha256").update(process.env.ERP_SESSION_SECRET!).digest(),iv)
  cipher.setAAD(Buffer.from("erp-session"))
  const encrypted=Buffer.concat([cipher.update(JSON.stringify({accessToken:"fixture-editor-token",tenantId:tenant,expiresAt:Date.now()+3600000})),cipher.final()])
  await context.addCookies([{name:"erp_session",value:Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString("base64url"),url:origin,httpOnly:true,sameSite:"Lax"}])
  const sku="REL-"+randomUUID().slice(0,8).toUpperCase(),name="=Relatório "+randomUUID().slice(0,6)
  const response=await context.request.post("/api/erp/products",{headers:{Origin:origin,"X-Tenant-Id":tenant,"Idempotency-Key":randomUUID()},data:{
    sku,name,unit:"UN",basePrice:"0.10",ncm:null,cest:null,status:"active"}})
  expect(response.status(),await response.text()).toBe(201)
  await page.goto("/relatorios/estoque")
  await page.getByRole("link",{name:"Análises de estoque",exact:true}).click()
  await page.getByLabel("Buscar produto ou SKU").fill(sku)
  const selected=page.getByRole("combobox",{name:"Produto",exact:true})
  await expect(selected.locator("option").filter({hasText:sku})).toHaveCount(1)
  await selected.selectOption({label:sku+" • "+name})
  await expect(page.getByRole("table",{name:"Posição valorizada"}).getByText(name,{exact:true})).toBeVisible()
  const download=page.waitForEvent("download")
  await page.getByRole("button",{name:"Exportar CSV completo"}).click()
  const stream=await (await download).createReadStream(),chunks:Buffer[]=[]
  for await(const chunk of stream!)chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks).toString("utf8")).toContain('"\''+name+'"')
  await page.getByRole("button",{name:"Visualizar impressão/PDF"}).click()
  await expect(page.getByRole("region",{name:"Visualização do relatório"})).toBeVisible()
  await expect(page.getByRole("region",{name:"Visualização do relatório"})).toContainText(sku)
  await page.getByRole("button",{name:"Fechar visualização"}).click()
  await page.getByRole("combobox",{name:"Análise",exact:true}).selectOption("stock_kardex")
  await expect(page.getByRole("table",{name:"Kardex por produto"})).toContainText("Saldo sem movimentos")
})

test("estoque • catálogo operacional e gráfico de movimentos conciliam com o CSV filtrado no celular", async ({ page, context }) => {
  const origin = process.env.ERP_TEST_WEB_ORIGIN!
  await installSessionCookie(context, origin, reportTenant, "fixture-editor-token")
  await page.route("**/api/erp/me", route => route.fulfill({json: {tenant: {id: reportTenant}}}))
  await page.setViewportSize({width: 390, height: 844})
  const headers = () => ({Origin: origin, "X-Tenant-Id": reportTenant, "Idempotency-Key": randomUUID()})
  const sku = "GRAF-" + randomUUID().slice(0, 8)
  const created = await context.request.post("/api/erp/products", {headers: headers(), data: {
    sku, name: "Cabo para análise", unit: "M", basePrice: "1.00", ncm: null, cest: null, status: "active",
  }})
  expect(created.status(), await created.text()).toBe(201)
  const productId = (await created.json()).data.id
  for (const [direction, quantity] of [["receipt", "8.500000"], ["issue", "2.250000"]]) {
    const response = await context.request.post("/api/erp/stock/movements", {
      headers: headers(), data: {productId, direction, quantity, reason: "Movimento de conferência do gráfico"},
    })
    expect(response.status(), await response.text()).toBe(201)
  }
  await page.goto("/relatorios/estoque")
  const catalog = page.getByRole("navigation", {name: "Catálogo de relatórios de estoque"})
  await expect(catalog.getByRole("link")).toHaveCount(10)
  await catalog.locator('a[href*="dataset=stock_movement_activity"]').click()
  await page.getByLabel("Buscar produto ou SKU").fill(sku)
  await page.getByRole("combobox", {name: "Produto", exact: true}).selectOption(productId)
  await page.getByLabel("Direção do movimento").selectOption("issue")
  await expect(page.getByRole("figure", {name: "Entradas e saídas por unidade"})).toBeVisible()
  await expect(page.getByRole("table").first()).toContainText("2,25")
  const download = page.waitForEvent("download")
  await page.getByRole("button", {name: "Exportar CSV completo"}).click()
  const stream = await (await download).createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  const csv = Buffer.concat(chunks).toString("utf8")
  expect(csv).toContain("2.25")
  expect(csv).not.toContain("8.50")
  await page.reload()
  await expect(page.getByLabel("Direção do movimento")).toHaveValue("issue")
  await page.getByRole("button", {name: "Limpar filtros"}).click()
  await expect(page.getByRole("combobox", {name: "Produto", exact: true})).toHaveValue("")
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  expect(fits).toBe(true)
})
