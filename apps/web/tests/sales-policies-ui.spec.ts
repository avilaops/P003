import { expect, test, type Page, type Route } from "@playwright/test"
import { installFrontendFixture, record, tenant } from "./helpers/frontend-fixture"

const api = "**/api/erp/commercial/policies/"
const seller = "33333333-3333-4333-8333-333333333333"
const method = "44444444-4444-4444-8444-444444444444"
const term = "55555555-5555-4555-8555-555555555555"
const list = "66666666-6666-4666-8666-666666666666"
const credit = "77777777-7777-4777-8777-777777777777"

function receipt(route: Route, id: string, revision: number) {
  expect(route.request().headers()["x-tenant-id"]).toBe(tenant)
  expect(route.request().headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/)
  return route.fulfill({headers:{etag:'"'+revision+'"'},json:{tenantId:tenant,id,revision}})
}
async function chooseCustomer(page: Page) {
  await page.getByLabel("Buscar cliente",{exact:true}).fill("Academia Aurora")
  await page.getByLabel("Buscar cliente",{exact:true}).press("Enter")
  await page.getByRole("button",{name:"Selecionar Academia Aurora"}).click()
}
test.beforeEach(async({context,baseURL})=>{await installFrontendFixture(context,baseURL)})

test("fila de aprovações exige rever valor e revisão alterados antes da decisão em lote",async({page})=>{
  let revision=3,decided=false
  const keys:string[]=[]
  const order=()=>({kind:"order",id:record,documentId:record,number:"180",customer:"Academia Aurora",amountCents:revision===3?150001:147503,revision,level:"manager",reasons:["discount"],dueAt:"2026-11-19T15:00:00Z"})
  const exception={kind:"credit",id:credit,documentId:seller,number:"181",customer:"Academia Norte",amountCents:50010,revision:7,level:"credit",reasons:["Atraso no título"],dueAt:"2026-11-20T15:00:00Z"}
  await page.route(api+"queue",r=>r.fulfill({json:{tenantId:tenant,canManage:true,data:decided?[]:[order(),exception],notifications:[]}}))
  await page.route(api+"decisions",async r=>{
    const body=r.request().postDataJSON()
    keys.push(r.request().headers()["idempotency-key"])
    expect(r.request().headers()["x-tenant-id"]).toBe(tenant)
    if(keys.length===1){
      expect(body).toEqual({approved:true,reason:"Desconto conferido",requests:[{kind:"order",id:record,revision:3}]})
      revision=4
      return r.fulfill({status:412,json:{title:"A solicitação mudou. Atualize a fila"}})
    }
    expect(body).toEqual({approved:false,reason:"Condições revistas com o cliente",requests:[{kind:"order",id:record,revision:4},{kind:"credit",id:credit,revision:7}]})
    decided=true
    return r.fulfill({headers:{etag:'"decisao-lote"'},json:{tenantId:tenant,data:body.requests.map((entry:{id:string;kind:string;revision:number})=>({...entry,tenantId:tenant,approvalStatus:"rejected",revision:entry.kind==="credit"?entry.revision:entry.revision+1,level:entry.kind==="credit"?"credit":"manager"}))}})
  })
  await page.goto("/vendas/aprovacoes")
  const first=page.getByRole("article").filter({hasText:"Academia Aurora"})
  await expect(first).toContainText("1.500,01")
  await expect(first).toContainText("Revisão 3")
  await expect(first.getByRole("link",{name:"Consultar documento"})).toHaveAttribute("href","/vendas/pedidos/"+record)
  await first.getByRole("checkbox").check()
  const approve=page.getByRole("button",{name:"Aprovar selecionados"})
  await expect(approve).toBeDisabled()
  await page.getByLabel("Justificativa").fill("Desconto conferido")
  await approve.click()
  await expect(page.getByRole("alert").filter({hasText:"A solicitação mudou"})).toHaveText("A solicitação mudou. Atualize a fila")
  await page.getByRole("button",{name:"Atualizar fila"}).click()
  await expect(first).toContainText("1.475,03")
  await expect(first).toContainText("Revisão 4")
  await expect(first.getByRole("checkbox")).not.toBeChecked()
  await expect(page.getByLabel("Justificativa")).toHaveValue("")
  const second=page.getByRole("article").filter({hasText:"Academia Norte"})
  await expect(second.getByRole("link")).toHaveAttribute("href","/vendas/pedidos/"+seller)
  await expect(second).toContainText("500,10")
  await first.getByRole("checkbox").check()
  await second.getByRole("checkbox").check()
  await page.getByLabel("Justificativa").fill("Condições revistas com o cliente")
  await page.getByRole("button",{name:"Recusar selecionados"}).click()
  await expect(page.getByText("Decisão registrada.")).toBeVisible()
  await page.reload()
  await expect(page.getByText("Nenhuma solicitação pendente para sua alçada.")).toBeVisible()
  expect(keys).toHaveLength(2)
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
  expect(keys[1]).not.toBe(keys[0])
})

test("preferências grava condição, alçada, crédito e lista do cliente e do canal com suas revisões",async({page})=>{
  let termRevision=2,customerRevision=5,channelRevision=1,routeRevision=3
  const updated:string[]=[]
  await page.route(api+"queue",r=>r.fulfill({json:{tenantId:tenant,canManage:true,notifications:[],data:[]}}))
  await page.route("**/api/erp/parties?*",r=>r.fulfill({json:{tenantId:tenant,total:1,data:[{id:record,legalName:"Academia Aurora",taxId:"52998224725"}]}}))
  await page.route(api+"catalog**",r=>{
    const buyer=new URL(r.request().url()).pathname.endsWith("/"+record)
    return r.fulfill({json:{tenantId:tenant,manage:true,terms:[{id:term,revision:termRevision,name:"Entrada e duas parcelas",entryBps:termRevision===2?2000:3015,days:[30,60],methodId:method,active:true}],
      defaultTermId:buyer?term:null,policy:buyer?{revision:customerRevision,creditLimitCents:customerRevision===5?50250:129987,validUntil:"2027-01-31",overdueDays:3,blocked:customerRevision>5,termId:term,listId:customerRevision>5?list:null}:null,
      methods:[{id:method,name:"Boleto"}],lists:[{id:list,name:"Distribuidores SP"}],people:[{id:seller,name:"Gerente regional"}],
      channels:[{channel:"atacado",listId:channelRevision>1?list:null,revision:channelRevision}],
      routes:[{level:"manager",dueHours:routeRevision===3?48:24,revision:routeRevision,substituteId:routeRevision>3?seller:null,until:routeRevision>3?"2027-01-19":null}]}})
  })
  await page.route(api+"settings",r=>{
    const body=r.request().postDataJSON()
    updated.push(body.kind)
    switch(body.kind) {
      case "term":
        expect(body).toEqual({kind:"term",id:term,revision:2,name:"Entrada e duas parcelas",entryBps:3015,days:[30,60],methodId:method,active:true})
        return receipt(r,term,++termRevision)
      case "routing":
        expect(body).toEqual({kind:"routing",level:"manager",revision:3,dueHours:24,substituteId:seller,until:"2027-01-19"})
        return receipt(r,"manager",++routeRevision)
      case "customer":
        expect(body).toEqual({kind:"customer",id:record,revision:5,creditLimitCents:129987,validUntil:"2027-01-31",overdueDays:3,blocked:true,termId:term,listId:list,sellerId:null,region:null})
        return receipt(r,record,++customerRevision)
      case "channel":
        expect(body).toEqual({kind:"channel",channel:"atacado",revision:1,listId:list})
        return receipt(r,"atacado",++channelRevision)
      default: throw new Error("Política inesperada")
    }
  })
  await page.goto("/vendas/aprovacoes")
  await page.getByRole("link",{name:"Políticas, prazos e substitutos"}).click()
  const conditions=page.locator("form").filter({has:page.getByRole("heading",{name:"Condições de pagamento"})})
  await conditions.getByRole("combobox",{name:"Condição",exact:true}).selectOption(term)
  await expect(conditions.getByLabel("Entrada (%)")).toHaveValue("20")
  await conditions.getByLabel("Entrada (%)").fill("30.15")
  await conditions.getByRole("button",{name:"Salvar condição"}).click()
  await expect(page.getByText("Política salva.")).toBeVisible()
  await conditions.getByRole("combobox",{name:"Condição",exact:true}).selectOption(term)
  await expect(conditions.getByLabel("Entrada (%)")).toHaveValue("30.15")
  const routing=page.locator("form").filter({has:page.getByRole("heading",{name:"Aprovadores e prazos"})})
  await routing.getByLabel("Prazo em horas").fill("24")
  await routing.getByRole("combobox",{name:"Substituto",exact:true}).selectOption(seller)
  await routing.getByLabel("Substituição até").fill("2027-01-19")
  await routing.getByRole("button",{name:"Salvar alçada"}).click()
  await expect.poll(()=>routeRevision).toBe(4)
  await expect(routing.getByLabel("Prazo em horas")).toHaveValue("24")
  await chooseCustomer(page)
  const buyer=page.locator("form").filter({has:page.getByRole("heading",{name:"Crédito e padrões do cliente"})})
  await expect(buyer.getByLabel("Limite de crédito (R$)")).toHaveValue("502.5")
  await buyer.getByLabel("Limite de crédito (R$)").fill("1299.87")
  await buyer.getByLabel("Lista de preços").selectOption(list)
  await buyer.getByLabel("Bloquear crédito").check()
  await buyer.getByRole("button",{name:"Salvar política do cliente"}).click()
  await expect.poll(()=>customerRevision).toBe(6)
  const channel=page.locator("form").filter({has:page.getByRole("heading",{name:"Lista por canal"})})
  await channel.getByLabel("Canal",{exact:true}).fill("atacado")
  await channel.getByRole("combobox",{name:"Lista",exact:true}).selectOption(list)
  await channel.getByRole("button",{name:"Salvar lista do canal"}).click()
  await expect.poll(()=>channelRevision).toBe(2)
  expect(updated).toEqual(["term","routing","customer","channel"])
  await page.reload()
  await chooseCustomer(page)
  await expect(buyer.getByLabel("Bloquear crédito")).toBeChecked()
  await expect(buyer.getByLabel("Limite de crédito (R$)")).toHaveValue("1299.87")
  await expect(buyer.getByLabel("Condição padrão")).toHaveValue(term)
  await expect(buyer.getByLabel("Lista de preços")).toHaveValue(list)
  await channel.getByLabel("Canal",{exact:true}).fill("atacado")
  await expect(channel.getByRole("combobox",{name:"Lista",exact:true})).toHaveValue(list)
})

test("relatório altera a meta pela revisão e mantém vendedor e canal na curva ABC",async({page})=>{
  let goalRevision=4,basisRead=""
  await page.route(api+"performance?*",r=>{
    const query=new URL(r.request().url()).searchParams
    expect(query.get("from")).toBe("2026-11-01")
    expect(query.get("to")).toBe("2026-11-30")
    expect(query.get("seller")).toBe(seller)
    expect(query.get("channel")).toBe("loja")
    basisRead=query.get("basis")??""
    const accepted=basisRead==="accepted"
    return r.fulfill({json:{tenantId:tenant,manage:true,channels:["loja"],sellers:[{id:seller,name:"Ana"}],
      totals:{orders:1,cancelled:0,orderedCents:"150050",averageCents:"150050",invoicedCents:"100000",returnedCents:"0",receivedCents:"60000"},orders:[],
      goals:[{sellerId:seller,seller:"Ana",month:"2026-11",line:"national",basis:"invoiced",revision:goalRevision,targetCents:goalRevision===4?"200000":"213415",targetMicros:goalRevision===4?"10000000":"12000001",achievedCents:"100000",achievedMicros:"5000000",achievedBps:goalRevision===4?5000:4686,quantityBps:5000,alertBps:7500,projectedCents:"170000",alert:true}],
      margins:[{id:record,number:"180",customer:"Academia Aurora",forecastGrossCents:"45000",forecastNetCents:"25000",actualRevenueCents:"90000",actualCostCents:"60000",actualGrossCents:"30000"}],
      abc:[{id:record,sku:"BN-1",name:"Banco nacional",cents:accepted?"150050":"100000",quantityMicros:accepted?"3000000":"2000000",accumulatedBps:10000,class:"A"}]}})
  })
  await page.route(api+"goals",r=>{
    expect(r.request().postDataJSON()).toEqual({sellerId:seller,month:"2026-11",line:"national",basis:"invoiced",targetCents:213415,targetMicros:"12000001",alertBps:7500,revision:4})
    return receipt(r,seller,++goalRevision)
  })
  const filters="?from=2026-11-01&to=2026-11-30&channel=loja&seller="+seller
  await page.goto("/dashboards/metas"+filters)
  const goals=page.getByRole("table",{name:"Metas por vendedor"})
  const goal=goals.getByRole("row",{name:/Ana/})
  await expect(goal).toContainText("2.000,00")
  await expect(goal).toContainText("50%")
  await expect(goal).toContainText("Abaixo de 75%")
  await goal.getByRole("button",{name:"Editar"}).click()
  await page.getByLabel("Meta em reais").fill("2134,15")
  await page.getByLabel("Meta em unidades").fill("12,000001")
  await page.getByRole("button",{name:"Salvar meta"}).click()
  await expect(goal).toContainText("2.134,15")
  await expect(goal).toContainText("12,000001")
  await page.getByRole("button",{name:"Margem por pedido"}).click()
  const margin=page.getByRole("table",{name:"Margem por pedido"}).getByRole("row",{name:/Academia Aurora/})
  await expect(margin).toContainText("450,00")
  await expect(margin).toContainText("300,00")
  await page.getByRole("button",{name:"Curva ABC"}).click()
  const abc=page.getByRole("table",{name:"Curva ABC"}).getByRole("row",{name:/BN-1/})
  await expect(abc).toContainText("1.000,00")
  await page.getByLabel("Base da curva").selectOption("accepted")
  await expect(abc).toContainText("1.500,50")
  await expect(abc.getByRole("cell",{name:"A",exact:true})).toBeVisible()
  await page.reload()
  await expect(abc).toContainText("1.500,50")
  await expect(page.getByRole("combobox",{name:"Vendedor",exact:true})).toHaveValue(seller)
  await expect(page.getByRole("combobox",{name:"Canal",exact:true})).toHaveValue("loja")
  expect(basisRead).toBe("accepted")
})

test("loja cria anúncio, reabre publicação pendente e refaz solicitação recusada pelo conector",async({page})=>{
  let created=false,reconciled=false,revision=1,connectorRevision=2
  let status:"pending"|"failed"|null=null
  const written:string[]=[]
  const listing=()=>({id:record,productId:method,product:"Banco regulável",sku:"BN-1",title:"Banco da academia",channel:"site",reference:"CAT-18",status:"draft",revision,
    delivery:status?{action:"publish",status,reference:status==="failed"?"REC-81":null}:null})
  await page.route("**/api/erp/products?*",r=>r.fulfill({json:{tenantId:tenant,total:1,data:[{id:method,name:"Banco regulável",sku:"BN-1"}]}}))
  await page.route(api+"store**",r=>{
    if(r.request().method()==="GET") return r.fulfill({json:{tenantId:tenant,canConfigure:true,canEdit:true,keys:[{id:term,name:"Chave local"}],
      connectors:[{code:"site",name:"Loja online",enabled:true,keyActive:true,keyId:term,revision:connectorRevision}],
      events:[{id:"RET-18",kind:"return",external:"CAT-18",channel:"site",status:reconciled?"reconciled":"awaiting_reconciliation",importId:null,orderId:record,
        availableReturns:[{id:credit,reason:"Devolução autorizada"}]}],orders:[],listings:created?[listing()]:[],more:false}})
    const body=r.request().postDataJSON()
    written.push(body.kind)
    if(body.kind==="connector"){
      expect(body).toEqual({kind:"connector",channel:"site",name:"Loja online",keyId:term,enabled:true,revision:2})
      return receipt(r,"site",++connectorRevision)
    }
    if(body.kind==="listing"){
      expect(body).toEqual({kind:"listing",productId:method,channel:"site",reference:"CAT-18",title:"Banco da academia",revision:0})
      created=true
      return receipt(r,record,revision)
    }
    if(body.kind==="return"){
      expect(body).toEqual({kind:"return",eventId:"RET-18",channel:"site",returnId:credit})
      reconciled=true
      return receipt(r,credit,1)
    }
    expect(body).toEqual({kind:"delivery",id:record,action:"publish",revision})
    status="pending"
    return receipt(r,record,++revision)
  })
  await page.goto("/vendas/loja-virtual")
  await page.getByText("Configurar conector",{exact:true}).click()
  await page.getByRole("combobox",{name:"Conector",exact:true}).selectOption("site")
  await page.getByRole("button",{name:"Salvar conector"}).click()
  await expect.poll(()=>connectorRevision).toBe(3)
  await page.getByRole("navigation",{name:"Canais de venda"}).getByRole("link",{name:"Anúncios",exact:true}).click()
  await page.getByRole("link",{name:"Novo anúncio"}).click()
  await page.getByRole("combobox",{name:"Canal",exact:true}).selectOption("site")
  const find=page.getByLabel("Buscar produto",{exact:true})
  await find.fill("Banco regulável")
  await find.press("Enter")
  await page.getByRole("button",{name:/Selecionar Banco regulável/}).click()
  await page.getByLabel("Referência externa").fill("CAT-18")
  await page.getByLabel("Título do anúncio").fill("Banco da academia")
  await page.getByRole("button",{name:"Salvar anúncio"}).click()
  await expect(page).toHaveURL(new RegExp("/vendas/anuncios/"+record+"$"))
  await expect(page.getByText("site • CAT-18 • Rascunho")).toBeVisible()
  await page.getByRole("button",{name:"Publicar",exact:true}).click()
  await page.getByRole("button",{name:"Voltar",exact:true}).click()
  expect(written).toEqual(["connector","listing"])
  await page.getByRole("button",{name:"Publicar",exact:true}).click()
  await page.getByRole("button",{name:"Confirmar operação"}).click()
  await expect(page.getByText(/Última operação.*Aguardando conector/)).toBeVisible()
  await page.getByRole("navigation",{name:"Canais de venda"}).getByRole("link",{name:"Anúncios",exact:true}).click()
  await page.getByRole("link",{name:"Banco da academia"}).click()
  await expect(page.getByRole("button",{name:"Publicar",exact:true})).toHaveCount(0)
  await expect(page.getByText(/Última operação.*Aguardando conector/)).toBeVisible()
  status="failed"
  revision++
  await page.reload()
  await expect(page.getByText(/Última operação.*Falhou.*REC-81/)).toBeVisible()
  await expect(page.getByText("site • CAT-18 • Rascunho")).toBeVisible()
  await page.getByRole("button",{name:"Publicar",exact:true}).click()
  await page.getByRole("button",{name:"Confirmar operação"}).click()
  await expect(page.getByText(/Última operação.*Aguardando conector/)).toBeVisible()
  await page.getByRole("navigation",{name:"Canais de venda"}).getByRole("link",{name:"Loja virtual"}).click()
  await page.getByRole("combobox",{name:"Devolução do pedido"}).selectOption(credit)
  await page.getByRole("button",{name:"Conciliar devolução"}).click()
  await expect(page.getByText("Devolução CAT-18 • site • Conciliado")).toBeVisible()
  expect(written).toEqual(["connector","listing","delivery","delivery","return"])
})
