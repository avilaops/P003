import { expect, test, type Page } from "@playwright/test"
import { installFrontendFixture, record, tenant } from "./helpers/frontend-fixture"

const service = "33333333-3333-4333-8333-333333333333"
const product = "44444444-4444-4444-8444-444444444444"
async function caseFixture(page: Page) {
  let revision = 7
  await page.route("**/api/erp/warranty-cases/" + record, route => route.fulfill({ headers: { ETag: '"' + revision + '"' }, json: {
    tenantId: tenant, canEdit:true,canApprove:true,data: { id: record, revision, protocol: "GAR-001", title: "Ajuste de equipamento", description: "Revisar componente do equipamento.",
      status: "opened", queue: "geral", criticality: "normal", coverageStatus: "pending", assignedTo: null, slaDueAt: null,
      timeline: [], serviceOrders: [{ id: service, revision: 2 }], parts: [], approvals: [], rmas: [], quarantines: [] },
  } }))
  await page.route("**/api/erp/products?**", route => route.fulfill({json: { tenantId: tenant, data: [{ id: product, name: "Rolamento", sku: "P-01", unit: "UN" }], total: 1 } }))
  await page.route("**/api/erp/warranty-cases/" + record + "/assignment", route => {
    revision++
    return route.fulfill({ headers: { ETag: '"' + revision + '"' }, json: { tenantId: tenant, data: { revision } } })
  })
}

test.beforeEach(async ({ context, page }) => { await installFrontendFixture(context); await caseFixture(page) })

test("garantia aberta pela nota recupera a série e grava o protocolo com a origem",async({page})=>{
  const doc="55555555-5555-4555-8555-555555555555"
  await page.route("**/api/erp/warranty-cases?**",r=>r.fulfill({json:{tenantId:tenant,canEdit:true,data:[],total:0}}))
  await page.route("**/api/erp/warranty-origins?**",r=>r.fulfill({json:{tenantId:tenant,data:[{documentId:doc,invoiceNumber:"28",lineNumber:1,productId:product,productName:"Banco",orderId:service,orderNumber:"12",customerName:"Cliente",availableUnits:1}]}}))
  await page.route("**/api/erp/orders/"+service,r=>r.fulfill({json:{data:{number:"12",customerName:"Cliente"},items:[{productId:product,name:"Banco"}]}}))
  await page.route("**/api/erp/warranty-equipment?**",r=>r.fulfill({json:{tenantId:tenant,data:{customerName:"Cliente",productName:"Banco",invoiceNumber:"28",expiresOn:"2027-11-01",remainingDays:180}}}))
  let body:unknown
  await page.route("**/api/erp/warranty-cases",r=>{body=r.request().postDataJSON();return r.fulfill({headers:{ETag:'"1"'},json:{tenantId:tenant,data:{id:record}}})})
  await page.goto("/vendas/garantias/novo?documentId="+doc,{waitUntil:"domcontentloaded"})
  await page.getByLabel("Título",{exact:true}).fill("Falha mecânica")
  await page.getByLabel("Descrição",{exact:true}).fill("Avaliar funcionamento do equipamento.")
  await page.getByLabel("Número de série").fill("SE-28")
  await page.getByRole("button",{name:"Consultar série"}).click()
  await expect(page.getByText(/180 dias restantes/)).toBeVisible()
  await page.getByRole("combobox",{name:"Nota e item"}).selectOption(doc+":1")
  await page.getByRole("button",{name:"Abrir garantia"}).click()
  await expect.poll(()=>body).toMatchObject({serialNumber:"SE-28",productId:product,orderId:service,documentId:doc,lineNumber:1})
})

test("valor da aprovação financeira é independente da mão de obra", async ({ page }) => {
  let body: unknown
  await page.route("**/api/erp/warranty-cases/*/approval", route => {
    body = route.request().postDataJSON()
    return route.fulfill({ headers: { ETag: '"8"' }, json: { tenantId: tenant } })
  })
  await page.goto("/vendas/garantias/" + record)
  await page.getByLabel("Mão de obra (R$)").fill("100,00")
  await page.getByRole("combobox", { name: "Ação", exact: true }).selectOption("refund")
  await page.getByLabel("Valor da decisão (R$)").fill("500,05")
  await page.getByRole("button", { name: "Registrar decisão" }).click()
  await expect.poll(() => body).toMatchObject({ action: "refund", amountCents: 50005 })
})

test("seleção de ordem para peça usa a revisão da ordem", async ({ page }) => {
  let revision = ""
  await page.route("**/api/erp/warranty-service-orders/*/parts", route => {
    revision = route.request().headers()["if-match"]
    return route.fulfill({ headers: { ETag: '"3"' }, json: { tenantId: tenant } })
  })
  await page.goto("/vendas/garantias/" + record)
  await page.getByLabel("Ordem de serviço da peça").selectOption(service)
  await page.getByLabel("Buscar produto da peça").fill("Rolamento")
  await page.getByRole("button", { name: /Rolamento/ }).click()
  await page.getByRole("button", { name: "Registrar peça" }).click()
  await expect.poll(() => revision).toBe('"2"')
})

test("a transição após salvar a triagem usa a revisão atualizada do caso", async ({ page }) => {
  let revision = ""
  await page.route("**/api/erp/warranty-cases/*/transition", route => {
    revision = route.request().headers()["if-match"]
    return route.fulfill({ headers: { ETag: '"9"' }, json: { tenantId: tenant } })
  })
  await page.goto("/vendas/garantias/" + record)
  await page.getByLabel("Fila", { exact: true }).fill("Retornos")
  await page.getByRole("button", { name: "Salvar triagem" }).click()
  await expect(page.getByText("8", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Avançar para Triagem" }).click()
  await expect.poll(() => revision).toBe('"8"')
})

test("admissão de garantia seleciona lote fiscal e limita a política à origem identificada",async({page})=>{
 const doc="55555555-5555-4555-8555-555555555555",policy="66666666-6666-4666-8666-666666666666"
 const original={documentId:doc,orderId:service,orderNumber:"81",invoiceNumber:"29",customerName:"Cliente",lineNumber:1,productId:product,productName:"Banco",category:"Bancos",channel:"site",availableUnits:2}
 await page.route("**/api/erp/warranty-cases?**",r=>r.fulfill({json:{tenantId:tenant,canEdit:true,data:[],total:0}}))
 await page.route("**/api/erp/warranty-origins?**",r=>r.fulfill({json:{tenantId:tenant,data:[original]}}))
 await page.route("**/api/erp/orders/"+service,r=>r.fulfill({json:{data:{number:"81",customerName:"Cliente"},items:[{productId:product,name:"Banco"}]}}))
 await page.route("**/api/erp/warranty-policies?**",r=>{
  const q=new URL(r.request().url()).searchParams
  expect(q.get("documentId")).toBe(doc)
  return r.fulfill({json:{tenantId:tenant,receipts:[],lots:[{lot:"L-29",availableUnits:2}],data:q.get("brand")==="Marca A"?[{id:policy,name:"Cobertura por marca",durationDays:365,status:"active"}]:[]}})
 })
 let bound:unknown
 await page.route("**/api/erp/warranty-equipment",r=>{bound=r.request().postDataJSON();return r.fulfill({headers:{ETag:'"1"'},json:{tenantId:tenant,data:{id:record,revision:1}}})})
 await page.goto("/vendas/garantias/novo?documentId="+doc)
 await page.getByRole("combobox",{name:"Nota e item"}).selectOption(doc+":1")
 await page.getByRole("combobox",{name:"Lote da NF-e"}).selectOption("L-29")
 await page.getByLabel("Unidades identificadas no lote").fill("2")
 await page.getByLabel("Marca identificada").fill("Marca A")
 await page.getByLabel("Referência de procedência").fill("Etiqueta e certificado 29")
 await page.getByRole("button",{name:"Consultar políticas aplicáveis"}).click()
 await page.getByRole("combobox",{name:"Política de garantia"}).selectOption(policy)
 await page.getByRole("button",{name:"Vincular série ou lote à nota"}).click()
 await expect.poll(()=>bound).toEqual({lot:"L-29",units:2,documentId:doc,lineNumber:1,policyId:policy,trace:{brand:"Marca A",reference:"Etiqueta e certificado 29"}})
})
