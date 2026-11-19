import { expect, test } from "@playwright/test"
import { installFrontendFixture, tenant } from "./helpers/frontend-fixture"

const id="22222222-2222-4222-8222-222222222222"
const orderId="33333333-3333-4333-8333-333333333333"
test("importação mapeia as colunas, confirma pedidos válidos e exporta o resultado", async ({context,page})=>{
  await installFrontendFixture(context)
  let confirmed=false, creates=0
  const job=()=>({id,channel:"loja",filename:"pedidos.csv",status:confirmed?"confirmed":"previewed",revision:confirmed?2:1,results:[
    {line:2,external:"EXT-1",status:confirmed?"imported":"ready",message:confirmed?"Pedido em rascunho":"Pronto para importar",...(confirmed?{orderId,orderNumber:"17"}:{})},
    {line:3,external:"EXT-2",status:"invalid",message:"SKU ativo não encontrado"}
  ]})
  const response=()=>({headers:{etag:confirmed?'"2"':'"1"'},json:{tenantId:tenant,canEdit:true,data:job()}})
  await page.route("**/api/erp/sales-imports",r=>r.fulfill({json:{tenantId:tenant,canEdit:true,data:[]}}))
  await page.route("**/api/erp/sales-imports/preview",r=>{
    const body=r.request().postDataJSON()
    expect(body).toMatchObject({channel:"loja",filename:"pedidos.csv",rows:[{line:2,external:"EXT-1",quantity:"3"},{line:3,external:"EXT-2",sku:"UNKNOWN"}]})
    expect(r.request().headers()["idempotency-key"]).toBeTruthy()
    return r.fulfill({...response(),status:201})
  })
  await page.route("**/api/erp/sales-imports/"+id,r=>r.fulfill(response()))
  await page.route("**/api/erp/sales-imports/"+id+"/confirm",r=>{
    expect(r.request().headers()["if-match"]).toEqual('"1"')
    expect(r.request().postDataJSON()).toEqual({})
    confirmed=true
    creates++
    return r.fulfill(response())
  })
  await page.goto("/vendas/importacao")
  const template=page.waitForEvent("download")
  await page.getByRole("button",{name:"Baixar modelo CSV"}).click()
  expect((await template).suggestedFilename()).toBe("modelo-pedidos.csv")
  await page.getByLabel("Canal de origem").fill("loja")
  await page.getByLabel("Arquivo CSV").setInputFiles({name:"pedidos.csv",mimeType:"text/csv",buffer:Buffer.from("referencia;documento_cliente;vencimento;sku;quantidade\nEXT-1;52998224725;2027-01-31;SKU-A;3\nEXT-2;52998224725;2027-01-31;UNKNOWN;1")})
  await page.getByRole("button",{name:"Validar e gerar prévia"}).click()
  await expect(page.getByText("Mapeie cada campo obrigatório",{exact:false})).toBeVisible()
  await page.getByRole("combobox",{name:"Pedido externo"}).selectOption("0")
  await page.getByRole("button",{name:"Validar e gerar prévia"}).click()
  await expect(page.getByRole("heading",{name:"Prévia • pedidos.csv"})).toBeVisible()
  await expect(page.getByText("SKU ativo não encontrado")).toBeVisible()
  await page.getByRole("button",{name:"Confirmar pedidos válidos"}).click()
  await expect(page.getByRole("heading",{name:"Resultado • pedidos.csv"})).toBeVisible()
  await expect(page.getByRole("link",{name:"PV-17"})).toHaveAttribute("href","/vendas/pedidos/"+orderId)
  await page.reload()
  await expect(page.getByRole("button",{name:"Confirmar pedidos válidos"})).toHaveCount(0)
  const report=page.waitForEvent("download")
  await page.getByRole("button",{name:"Baixar relatório CSV"}).click()
  expect((await report).suggestedFilename()).toBe("resultado-importacao.csv")
  expect(creates).toBe(1)
})

test("loja e anúncios confirmam comando, aguardam o conector e exibem referências conciliadas",async({page,context,baseURL})=>{
 await installFrontendFixture(context,baseURL)
 let pending=false
 const operations:object[]=[]
 const listing=()=>({id,title:"Banco local",productId:orderId,product:"Banco",sku:"BN",reference:"WEB-42",channel:"site",status:"draft",revision:pending?2:1,delivery:pending?{action:"publish",status:"pending",reference:null}:null})
 const source=()=>({tenantId:tenant,canEdit:true,canConfigure:true,keys:[],connectors:[{code:"site",name:"Loja site",enabled:true,keyActive:true,revision:1,keyId:id}],listings:[listing()],orders:[{id:orderId,number:"42",external:"WEB-42",channel:"site",status:"confirmed",reservedMicros:"2500000"}],events:[{id:"E1",kind:"order",external:"WEB-42",channel:"site",status:"confirmed",orderId,importId:id,availableReturns:null}],more:false})
 await page.route("**/api/erp/commercial/policies/store**",r=>{
  if(r.request().method()==="GET")return r.fulfill({json:source()})
  operations.push(r.request().postDataJSON());pending=true
  return r.fulfill({headers:{etag:'"2"'},json:{tenantId:tenant,id,revision:2}})
 })
 await page.goto("/vendas/loja-virtual")
 await expect(page.getByRole("heading",{name:"Loja virtual",exact:true})).toBeVisible()
 await expect(page.getByText(/2,5 reservados/)).toBeVisible()
 await expect(page.getByRole("link",{name:"Conferir importação"})).toHaveAttribute("href","/vendas/importacao?job="+id)
 await page.getByRole("navigation",{name:"Canais de venda"}).getByRole("link",{name:"Anúncios",exact:true}).click()
 await page.getByRole("link",{name:"Banco local"}).click()
 await page.getByRole("button",{name:"Publicar",exact:true}).click()
 expect(operations).toEqual([])
 await page.getByRole("button",{name:"Confirmar operação"}).click()
 await expect(page.getByText(/Aguardando conector/)).toBeVisible()
 expect(operations).toEqual([{kind:"delivery",id,action:"publish",revision:1}])
 await expect(page.getByRole("button",{name:"Publicar",exact:true})).toHaveCount(0)
})
