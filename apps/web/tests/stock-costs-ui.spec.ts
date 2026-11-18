import { test,expect } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { createCipheriv,createHash,randomBytes } from "node:crypto"

test("estoque registra custo médio, exibe valor na grade e fecha a competência", async ({page,context})=>{
  const tenant="11111111-1111-4111-8111-111111111111"
  const origin=process.env.ERP_TEST_WEB_ORIGIN!
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",createHash("sha256").update(process.env.ERP_SESSION_SECRET!).digest(),iv)
  cipher.setAAD(Buffer.from("erp-session"))
  const contents=Buffer.concat([cipher.update(JSON.stringify({accessToken:"fixture-editor-token",tenantId:tenant,expiresAt:Date.now()+3600000})),cipher.final()])
  await context.addCookies([{name:"erp_session",value:Buffer.concat([iv,cipher.getAuthTag(),contents]).toString("base64url"),url:origin,httpOnly:true,sameSite:"Lax"}])
  const name="Peça de valoração "+randomUUID().slice(0,6)
  const created=await context.request.post("/api/erp/products",{headers:{Origin:origin,"X-Tenant-Id":tenant,"Idempotency-Key":randomUUID()},
    data:{sku:randomUUID(),name,unit:"UN",basePrice:"0.10",ncm:null,cest:null,status:"active"}})
  expect(created.status(),await created.text()).toBe(201)
  await page.goto("/estoque/lancamentos/novo")
  await page.getByRole("link",{name:new RegExp("^Lançar movimento de "+name)}).click()
  await page.getByLabel("Quantidade (vírgula ou ponto)").fill("2")
  await page.getByLabel("Data efetiva").fill("2025-03-11")
  await page.getByLabel("Custo unitário de entrada").fill("12,50")
  await page.getByLabel("Motivo",{exact:true}).fill("Lote de abertura valorado")
  await page.getByRole("button",{name:"Confirmar lançamento"}).click()
  await expect(page.getByRole("status").filter({hasText:"Movimento confirmado"})).toBeVisible()
  await page.goto("/estoque/saldos")
  await expect(page.getByRole("row").filter({hasText:name})).toContainText("25,00")
  await page.getByRole("link",{name:"Custos e fechamento mensal"}).click()
  await page.getByRole("button",{name:"Recalcular custos pendentes"}).click()
  await expect(page.getByRole("status").filter({hasText:"Recálculo concluído"})).toBeVisible()
  await page.getByLabel("Competência",{exact:true}).fill("2025-03")
  await page.getByRole("button",{name:"Fechar mês"}).click()
  await expect(page.getByRole("status").filter({hasText:"Competência fechada"})).toBeVisible()
  await expect(page.getByRole("table",{name:"Competências de estoque"})).toContainText("2025-03")
})
