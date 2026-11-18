import { test,expect } from "@playwright/test"
import { createCipheriv,createHash,randomBytes,randomUUID } from "node:crypto"

test("estoque • análise valorizada, Kardex, CSV completo e impressão",async({page,context})=>{
  const tenant="11111111-1111-4111-8111-111111111111",origin=process.env.ERP_TEST_WEB_ORIGIN!
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
  await page.getByLabel("Análise",{exact:true}).selectOption("stock_kardex")
  await expect(page.getByRole("table",{name:"Kardex por produto"})).toContainText("Saldo sem movimentos")
})
