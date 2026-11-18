import { expect,test } from "@playwright/test"
import { installFrontendFixture,record,tenant } from "./helpers/frontend-fixture"

test("execução financeira da garantia preserva aprovação, conta e referência após resposta perdida",async({page,context})=>{
  await installFrontendFixture(context)
  await page.setViewportSize({width:390,height:844})
  const approval="33333333-3333-4333-8333-333333333333",bank="44444444-4444-4444-8444-444444444444"
  let done=false
  const rev=()=>done?8:7
  await page.route("**/api/erp/warranty-cases/"+record,route=>route.fulfill({headers:{ETag:'"'+rev()+'"'},json:{
    tenantId:tenant,canEdit:true,canApprove:false,data:{id:record,revision:rev(),protocol:"GAR-70",title:"Garantia de equipamento",description:"Atendimento da venda documentada.",criticality:"normal",status:"treatment",coverageStatus:"eligible",queue:"geral",
      timeline:[],serviceOrders:[],parts:[],approvals:[{id:approval,action:"refund",decision:"approved",amountCents:50005}],rmas:[],quarantines:[]}}}))
  await page.route("**/warranty-cases/"+record+"/settlements?**",route=>route.fulfill({headers:{ETag:'"'+rev()+'"'},json:{tenantId:tenant,revision:rev(),canBank:true,canReview:false,canStock:false,canCredit:false,originReady:true,custody:"0.000000",reviews:[],accounts:[{id:bank,name:"Banco principal"}],receivables:[],totalBills:0,movements:done?[{id:bank,approvalId:approval,kind:"refund",reference:"Comprovante 70",occurredOn:"2026-11-18",amountCents:50005,accountEntryId:bank}]:[]}}))
  const calls:{key:string,etag:string,input:unknown}[]=[]
  await page.route("**/warranty-cases/"+record+"/settlements",route=>{
    calls.push({key:route.request().headers()["idempotency-key"],etag:route.request().headers()["if-match"],input:route.request().postDataJSON()})
    if(calls.length===1)return route.abort("failed")
    done=true;return route.fulfill({headers:{ETag:'"8"'},json:{tenantId:tenant,data:{id:bank,revision:8}}})
  })
  await page.goto("/vendas/garantias/"+record)
  const area=page.getByRole("region",{name:"Financeiro e logística da garantia"})
  await area.getByRole("combobox",{name:"Operação",exact:true}).selectOption("refund")
  await area.getByRole("combobox",{name:"Documento da operação",exact:true}).selectOption(approval)
  await area.getByRole("combobox",{name:"Conta do lançamento",exact:true}).selectOption(bank)
  await area.getByLabel("Referência do comprovante").fill("Comprovante 70")
  await area.getByLabel("Data da operação").fill("2026-11-18")
  await area.getByRole("button",{name:"Registrar operação"}).click()
  await expect(area.getByRole("combobox",{name:"Conta do lançamento",exact:true})).toBeDisabled()
  await area.getByRole("button",{name:"Conferir operação anterior"}).click()
  await expect(area.getByText("Lançamento • "+bank)).toBeVisible()
  expect(calls.length).toBe(2)
  expect(calls[1]).toEqual(calls[0])
  expect(calls[0].etag).toBe('"7"')
  expect(calls[0].input).toEqual({kind:"refund",reference:"Comprovante 70",occurredOn:"2026-11-18",approvalId:approval,accountId:bank})
})
