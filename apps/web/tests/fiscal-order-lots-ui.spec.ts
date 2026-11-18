import { expect, test } from "@playwright/test"
import { installFrontendFixture, tenant, record } from "./helpers/frontend-fixture"

test("preparação parcial mantém as quatro unidades e o ambiente liberado pelo pedido", async ({page,context})=>{
  await installFrontendFixture(context)
  const lot="33333333-3333-4333-8333-333333333333"
  await page.route("**/api/erp/me",r=>r.fulfill({json:{tenant:{id:tenant},permissions:["sales.orders.read","fiscal.nfe.read","fiscal.nfe.manage"]}}))
  await page.route("**/api/erp/fiscal/readiness",r=>r.fulfill({json:{tenantId:tenant,profileConfigured:true,certificateVerified:true,blockers:[],environment:"homologation",productionEnabled:false,canTransmit:true}}))
  await page.route("**/api/erp/fiscal/order-preparations/*",r=>r.fulfill({json:{tenantId:tenant,customerId:record,orderId:record,orderRevision:2,
    recipient:{taxId:"11222333000181",legalName:"Cliente",state:"SP"},productsTotal:"1000.00",
    items:[{code:"TESTE",unit:"UN",description:"Produto do lote",quantity:"10.0000",unitPrice:"100.00",grossTotal:"1000.00"}]}}))
  await page.route("**/api/erp/fiscal/order-lots/*?*",r=>r.fulfill({json:{tenantId:tenant,orderId:record,lots:[{id:lot,status:"reserved",environment:"production",items:[{sku:"TESTE",quantity:"4000000"}]}]}}))
  await page.goto(`/fiscal/notas-saida/nova?pedido=${record}&lote=${lot}&ambiente=production`)
  await expect(page.getByText("Esta preparação corresponde às quantidades reservadas no lote.",{exact:false})).toBeVisible()
  await expect(page.getByLabel("Ambiente do rascunho",{exact:true})).toBeDisabled()
  await page.getByRole("button",{name:"3. Produtos",exact:true}).click()
  await expect(page.getByLabel("Quantidade",{exact:true})).toHaveValue("4.0000")
  await expect(page.getByLabel("Quantidade",{exact:true})).not.toBeEditable()
  await expect(page.getByRole("cell",{name:"R$ 400,00",exact:true})).toBeVisible()
})

test("V5 • salvar a política envia o prazo e a alçada em centavos",async({page,context,baseURL})=>{
  await installFrontendFixture(context,baseURL)
  let revision=1
  await page.route("**/api/erp/fiscal/return-policy",async route=>{
    const snapshot=()=>({tenantId:tenant,revision,windowDays:revision===1?null:15,approvalAboveCents:revision===1?null:"12345",canEdit:true})
    if(route.request().method()==="PUT"){
      expect(route.request().headers()["x-tenant-id"]).toBe(tenant)
      expect(route.request().headers()["if-match"]).toBe('"1"')
      expect(route.request().headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/)
      expect(route.request().postDataJSON()).toEqual({windowDays:15,approvalAboveCents:"12345"})
      revision++
    }
    await route.fulfill({headers:{etag:'"'+revision+'"'},json:snapshot()})
  })
  await page.goto("/preferencias/politicas-vendas#devolucoes")
  await page.getByLabel("Prazo em dias corridos após a entrega").fill("15")
  await page.getByLabel("Exigir aprovação para valores acima de", {exact:false}).fill("123,45")
  await page.getByRole("button",{name:"Salvar política de devoluções"}).click()
  await expect(page.getByText("Política salva.",{exact:true})).toBeVisible()
  expect(revision).toBe(2)
})

test("V5 • entrega as séries do lote, concilia a nota do cliente e prepara entrada própria",async({page,context,baseURL})=>{
  await installFrontendFixture(context,baseURL)
  const lot="33333333-3333-4333-8333-333333333333",actions:string[]=[]
  let revision=1,delivered=false
  const permissions=["sales.orders.read","sales.orders.manage","fiscal.nfe.read","fiscal.nfe.manage","fiscal.received_nfe.manage","inventory.stock.manage","finance.receivables.manage"]
  await page.route("**/api/erp/me",route=>route.fulfill({json:{tenant:{id:tenant},permissions}}))
  await page.route("**/api/erp/orders/"+record+"*",route=>route.fulfill({headers:{etag:'"1"'},json:{tenantId:tenant,canEdit:true,items:[],data:{id:record,number:"24",customerName:"Pessoa consumidora",customerTaxId:"52998224725",amount:"100.00",dueDate:"2026-11-30",status:"confirmed",revision:1}}}))
  await page.route("**/api/erp/fiscal/order-lots/"+record+"*",async route=>{
    if(route.request().method()==="POST"){
      const data=route.request().postDataJSON()
      expect(route.request().headers()["if-match"]).toBe('"'+revision+'"')
      expect(route.request().headers()["x-tenant-id"]).toBe(tenant)
      expect(route.request().headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/)
      if(data.action==="deliver")delivered=true
      expect(data).toEqual(data.action==="deliver" ? {action:"deliver",environment:"production",lotId:lot,serials:[{lineNumber:1,serials:["SN-1","SN-2","SN-3","SN-4"]}]} : data.action==="return" ? {action:"return",environment:"production",lotId:lot,receivedId:"17",reason:"Produto devolvido",destination:"service",serials:[{lineNumber:1,serials:["SN-1","SN-2"]}]}:
        {action:"prepareOwnReturn",environment:"production",lotId:lot,reason:"Produto devolvido",destination:"stock",taxRuleReference:"Instrução fiscal validada",consumerDeclaration:true,serials:[{lineNumber:1,serials:["SN-3","SN-4"]}],items:[{lineNumber:1,quantityMicros:"2000000",cfop:"1202"}]})
      actions.push(data.action)
      revision++
      return route.fulfill({headers:{etag:'"'+revision+'"'},json:{tenantId:tenant,orderId:record,id:lot,revision}})
    }
    return route.fulfill({headers:{etag:'"'+revision+'"'},json:{tenantId:tenant,orderId:record,status:"confirmed",environment:"production",lines:[],returns:[],lots:[{id:lot,draftId:lot,status:"authorized",environment:"production",number:24,deliveredAt:delivered?"2026-11-17":null,items:[{lineNumber:1,sku:"V5-CPF",quantity:"4000000",tracked:true}]}]}})
  })
  await page.goto("/vendas/pedidos/"+record)
  await page.getByText("Faturamento por item e devoluções",{exact:true}).click()
  await page.getByLabel("Séries entregues • V5-CPF • uma por linha").fill("SN-1\nSN-2\nSN-3\nSN-4")
  page.once("dialog",dialog=>dialog.accept())
  await page.getByRole("button",{name:"Registrar entrega",exact:true}).click()
  await expect.poll(()=>actions).toEqual(["deliver"])
  await page.goto("/vendas/pedidos/"+record+"?devolucao="+lot+"&ambiente=production#faturamento-devolucoes")
  await page.getByRole("button",{name:"Vincular NF-e recebida do cliente"}).click()
  await page.getByLabel("Séries devolvidas • V5-CPF • uma por linha").fill("SN-1\nSN-2")
  const external=page.locator("form").filter({has:page.getByLabel("Registro da NF-e de entrada")})
  await external.getByLabel("Registro da NF-e de entrada").fill("17")
  await external.getByLabel("Motivo",{exact:true}).fill("Produto devolvido")
  await external.getByLabel("Destino dos itens").selectOption("service")
  await external.getByRole("button",{name:"Conciliar devolução"}).click()
  await expect.poll(()=>actions).toEqual(["deliver","return"])
  await page.goto("/vendas/pedidos/"+record+"?devolucao="+lot+"&ambiente=production#faturamento-devolucoes")
  await page.getByLabel("Séries devolvidas • V5-CPF • uma por linha").fill("SN-3\nSN-4")
  await page.getByLabel("V5-CPF • quantidade da devolução").fill("2")
  await page.getByLabel("CFOP de entrada • V5-CPF").fill("1202")
  await page.getByLabel("Motivo da devolução").fill("Produto devolvido")
  await page.getByLabel("Instrução do responsável fiscal").fill("Instrução fiscal validada")
  await page.getByRole("checkbox",{name:"O consumidor não emite a nota de devolução."}).check()
  await page.getByRole("button",{name:"Preparar nota de entrada"}).click()
  await expect.poll(()=>actions).toEqual(["deliver","return","prepareOwnReturn"])
  await expect(page.getByRole("link",{name:"Lista de devoluções"})).toHaveAttribute("href","/vendas/devolucoes")
})
