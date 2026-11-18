import {test,expect} from "@playwright/test"
import {randomUUID} from "node:crypto"
import {installSessionCookie,tenant} from "./helpers/frontend-fixture"

test("estoque • estrutura, quadro da fábrica e entrada valorizada por apontamento", async({context,page})=>{
  const origin=process.env.ERP_TEST_WEB_ORIGIN!
  await installSessionCookie(context,origin,tenant,"fixture-editor-token")
  const receive=await context.request.post("/api/erp/stock/movements",{headers:{Origin:origin,"X-Tenant-Id":tenant,"Idempotency-Key":randomUUID()},
    data:{productId:process.env.STOCK_TEST_FACTORY_PART,direction:"receipt",quantity:"10.000000",unitCost:"3.000000",reason:"Saldo inicial da fábrica"}})
  expect(receive.status(),await receive.text()).toBe(201)
  await page.setViewportSize({width:390,height:844})
  await page.goto("/estoque/ordens-producao")
  await expect(page.getByRole("heading",{name:"Ordens de produção",exact:true})).toBeVisible()
  await page.getByText("Estruturas de produto",{exact:true}).click()
  await page.getByLabel("Buscar produto acabado").fill("BNC-OP")
  await page.getByRole("button",{name:"Banco para fábrica • BNC-OP"}).click()
  await page.getByLabel("Buscar componente da estrutura").fill("PRF-OP")
  await page.getByRole("button",{name:"Perfil de bancada • PRF-OP"}).click()
  await page.getByLabel(/Perfil de bancada • Quantidade por/).fill("2")
  await page.getByRole("button",{name:"Publicar versão da estrutura"}).click()
  await expect(page.getByText("Versão da estrutura publicada.")).toBeVisible()
  await page.getByRole("button",{name:"Enviar pedido à produção",exact:true}).click()
  await page.getByLabel("Pedido aceito, reservado ou concluído").selectOption(process.env.STOCK_TEST_FACTORY_ORDER!)
  await page.getByRole("button",{name:"Criar ordens por produto"}).click()
  await page.getByRole("button",{name:"Consultar Banco para fábrica"}).click()
  await expect(page.getByText(/Previsto 6 M • Empenhado 6 M/)).toBeVisible()
  await page.getByLabel("Quantidade produzida").fill("2")
  await page.getByLabel("Perda em unidades").fill("1")
  await page.getByLabel("Tempo de produção (min)").fill("90")
  await page.getByLabel("Custos adicionais (R$)").fill("2,00")
  await page.getByLabel("Motivo do apontamento").fill("Montagem conferida")
  await page.getByRole("button",{name:"Confirmar apontamento"}).click()
  await expect(page.getByText(/Produzido 2 • Perda 1 • 90 min • Custo R\$ 20,00/)).toBeVisible()
  await page.getByRole("link",{name:"Conferir entrada no Kardex"}).click()
  await expect(page.getByRole("heading",{name:"Banco para fábrica"})).toBeVisible()
})
