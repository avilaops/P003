import { test, expect, type BrowserContext } from "@playwright/test"
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto"

const origin = process.env.ERP_TEST_WEB_ORIGIN || "http://127.0.0.1:3202"
const tenant = "11111111-1111-4111-8111-111111111111"
const headers = { Origin: origin, "X-Tenant-Id": tenant }

async function session(context: BrowserContext, reader = false) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(process.env.ERP_SESSION_SECRET!).digest(), iv)
  cipher.setAAD(Buffer.from("erp-session"))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ accessToken: reader ? "fixture-reader-token" : "fixture-editor-token", tenantId: tenant, expiresAt: Date.now() + 3600_000 })), cipher.final()])
  await context.addCookies([{ name: "erp_session", value: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url"), url: origin, httpOnly: true, sameSite: "Lax" }])
}

async function product(context: BrowserContext, name: string) {
  const response = await context.request.post("/api/erp/products", {
    headers: { ...headers, "Idempotency-Key": randomUUID() },
    data: { sku: randomUUID(), name, unit: "UN", basePrice: "0.10", ncm: null, cest: null, status: "active" },
  })
  expect(response.status()).toBe(201)
  return (await response.json()).data.id as string
}

test("estoque confirma entrada, recusa saldo negativo e estorna com histórico persistido", async ({ page, context }) => {
  await session(context)
  const name = "Parafuso de estoque persistido"
  const id = await product(context, name)
  await page.setViewportSize({ width: 375, height: 844 })
  await page.goto("/estoque/saldos")
  await page.getByRole("link", { name: new RegExp(`^Ver movimentos de ${name} • SKU `) }).click()
  await page.getByRole("link", { name: "Novo lançamento", exact: true }).click()
  const quantity = page.getByRole("textbox", { name: "Quantidade (vírgula ou ponto)", exact: true })
  const reason = page.getByRole("textbox", { name: "Motivo", exact: true })
  await quantity.fill("10.000001")
  await reason.fill("Contagem inicial conferida")
  await page.getByRole("button", { name: "Confirmar lançamento", exact: true }).click()
  await expect(page.getByRole("status").filter({ hasText: "Saldo após o lançamento: 10,000001" })).toBeVisible()
  await page.getByRole("combobox", { name: "Direção", exact: true }).selectOption("issue")
  await quantity.fill("11")
  await reason.fill("Tentativa de saída superior ao saldo")
  await page.getByRole("button", { name: "Confirmar lançamento", exact: true }).click()
  await expect(page.getByRole("alert").filter({ hasText: "Saldo insuficiente" })).toBeVisible()
  await expect(quantity).toHaveValue("11")
  await quantity.fill("2.000001")
  await reason.fill("Separação de material")
  await page.getByRole("button", { name: "Confirmar lançamento", exact: true }).click()
  await expect(page.getByRole("status").filter({ hasText: "Saldo após o lançamento: 8 UN" })).toBeVisible()
  await page.getByRole("button", { name: "Preparar estorno de 2,000001", exact: true }).click()
  await expect(quantity).toHaveValue("2.000001")
  await expect(quantity).toBeDisabled()
  await reason.fill("Cancelamento da separação")
  await page.getByRole("button", { name: "Confirmar estorno", exact: true }).click()
  await expect(page.getByRole("status").filter({ hasText: "Saldo após o lançamento: 10,000001" })).toBeVisible()
  await page.reload()
  await expect(page.getByText("Cancelamento da separação", { exact: true })).toBeVisible()
  const history = await context.request.get(`/api/erp/stock/movements?productId=${id}`)
  expect((await history.json()).total).toBe(3)
  await expect(page.getByRole("button", { name: "Preparar estorno de 2,000001", exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const nextPage = await page.getByRole("button", { name: "Próxima", exact: true }).boundingBox()
  expect(nextPage).not.toBeNull()
  expect(nextPage!.y + nextPage!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: test.info().outputPath("estoque-mobile.png"), fullPage: true })
})

test("resposta perdida repete a mesma chave sem duplicar o movimento", async ({ page, context }) => {
  await session(context)
  const name = "Produto de confirmação interrompida"
  const id = await product(context, name)
  await page.goto("/estoque/lancamentos/novo")
  await page.getByRole("link", { name: new RegExp(`^Lançar movimento de ${name} • SKU `) }).click()
  await page.getByRole("textbox", { name: "Quantidade (vírgula ou ponto)", exact: true }).fill("3.000001")
  await page.getByRole("textbox", { name: "Motivo", exact: true }).fill("Entrada com resposta interrompida")
  let lost = false
  const keys: string[] = []
  await page.route("**/api/erp/stock/movements", async route => {
    if (route.request().method() !== "POST") return route.continue()
    keys.push(route.request().headers()["idempotency-key"])
    if (!lost) {
      const committed = await route.fetch()
      expect(committed.status()).toBe(201)
      lost = true
      return route.abort("failed")
    }
    return route.continue()
  })
  await page.getByRole("button", { name: "Confirmar lançamento", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Motivo", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Repetir confirmação", exact: true }).click()
  await expect(page.getByRole("status").filter({ hasText: "Saldo após o lançamento: 3,000001" })).toBeVisible()
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBe(keys[1])
  const history = await context.request.get(`/api/erp/stock/movements?productId=${id}`)
  expect((await history.json()).total).toBe(1)
})

test("estoque libera correção após resposta incerta e recusa definitiva", async ({ page, context }) => {
  await session(context)
  const name = "Peça com correção de lançamento"
  const id = await product(context, name)
  await page.goto("/estoque/lancamentos/novo")
  await page.getByRole("link", { name: new RegExp("^Lançar movimento de " + name) }).click()
  const reason = page.getByRole("textbox", { name: "Motivo", exact: true })
  await page.getByRole("textbox", { name: "Quantidade (vírgula ou ponto)" }).fill("1")
  await reason.fill("Entrada a conferir")
  const keys: string[] = []
  await page.route("**/api/erp/stock/movements", async route => {
    if (route.request().method() !== "POST") return route.continue()
    keys.push(route.request().headers()["idempotency-key"])
    if (keys.length > 2) return route.continue()
    return route.fulfill({ status: keys.length === 1 ? 503 : 422, json: { title: "Confira o motivo" } })
  })
  await page.getByRole("button", { name: "Confirmar lançamento" }).click()
  await expect(reason).toBeDisabled()
  await page.getByRole("button", { name: "Repetir confirmação" }).click()
  await expect(reason).toBeEnabled()
  await reason.fill("Entrada conferida e corrigida")
  await page.getByRole("button", { name: "Confirmar lançamento" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Saldo após o lançamento: 1 UN" })).toBeVisible()
  expect(keys).toHaveLength(3)
  expect(keys[0]).toBe(keys[1])
  expect(keys[2]).not.toBe(keys[1])
  const history = await context.request.get("/api/erp/stock/movements?productId=" + id)
  expect((await history.json()).total).toBe(1)
})

test("estoque calcula uma sugestão de compra pela regra salva no produto", async ({ page, context }) => {
  await session(context)
  const name = "Equipamento para reposição"
  await product(context, name)
  await page.goto("/compras/sugestoes")
  await page.getByRole("combobox", { name: "Exibir" }).selectOption("all")
  await page.getByRole("link", { name: new RegExp(name + " • SKU") }).click()
  await page.getByLabel("Estoque mínimo (UN)").fill("9")
  await page.getByLabel("Ponto de pedido (UN)").fill("12")
  await page.getByLabel("Lote de compra (UN)").fill("5")
  await page.getByLabel("Prazo do fornecedor (dias)").fill("7")
  await page.getByRole("button", { name: "Salvar regra" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Regra de reposição salva" })).toBeVisible()
  await page.goto("/compras/sugestoes")
  const row = page.getByRole("listitem").filter({ hasText: name })
  await expect(row.getByText("Compra sugerida • 10 UN")).toBeVisible()
})

test("estoque respeita consulta e cabe no celular", async ({ page, context }) => {
  await session(context)
  const name = "Consulta de estoque no celular"
  await product(context, name)
  await session(context, true)
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto("/estoque")
  await page.getByRole("link", { name: new RegExp(`^Ver movimentos de ${name} • SKU `) }).click()
  await expect(page.getByText("Somente consulta. Você não pode movimentar o estoque.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Confirmar lançamento", exact: true })).toHaveCount(0)
  expect((await context.request.post("/api/erp/stock/movements", {
    headers: { ...headers, "Idempotency-Key": randomUUID() },
    data: { productId: randomUUID(), direction: "receipt", quantity: "1", reason: "Tentativa sem direito", reversesId: null },
  })).status()).toBe(403)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test("estoque conserva depósito e SKU entre saldos, Kardex e transferência", async ({page,context}) => {
  await session(context)
  const name = "Produto para transferência", id = await product(context,name)
  const command = () => ({...headers,"Idempotency-Key":randomUUID()})
  const warehouse = await context.request.post("/api/erp/warehouses", {headers:command(),data:{
    code:"SHOWROOM",name:"Showroom",status:"active",location:null,notes:null,
  }})
  expect(warehouse.status(),await warehouse.text()).toBe(201)
  const second = (await warehouse.json()).data.id as string
  const opening = await context.request.post("/api/erp/stock/movements", {headers:command(),data:{
    productId:id,direction:"receipt",quantity:"10.000000",reason:"Posição inicial conferida",
  }})
  expect(opening.status(),await opening.text()).toBe(201)
  await page.goto("/estoque/transferencias")
  await page.getByRole("checkbox",{name:"Controlar saldos por depósito"}).check()
  await page.getByRole("button",{name:"Salvar parâmetros"}).click()
  await expect(page.getByRole("status").filter({hasText:"Parâmetros de depósito salvos."})).toBeVisible()
  await page.getByRole("combobox",{name:"Destino",exact:true}).selectOption(second)
  await page.getByLabel("Buscar produto ou SKU na origem").fill(name)
  await page.getByRole("button",{name:/^Adicionar /}).click()
  await page.getByLabel(/^Quantidade •/).fill("2")
  await page.getByLabel("Motivo",{exact:true}).fill("Exposição na loja")
  await page.getByRole("button",{name:"Confirmar transferência"}).click()
  await expect(page.getByRole("status").filter({hasText:"Transferência registrada."})).toBeVisible()
  await page.goto("/estoque/saldos")
  await page.getByRole("combobox",{name:"Depósito",exact:true}).selectOption(second)
  const row = page.getByRole("row").filter({hasText:name})
  await expect(row.getByRole("cell",{name:"Showroom",exact:true})).toBeVisible()
  await row.getByRole("link",{name:/Ver movimentos/}).click()
  await expect(page).toHaveURL(new RegExp("warehouseId="+second))
  await expect(page.getByRole("heading",{name})).toBeVisible()
  await expect(page.getByText("Exposição na loja",{exact:true})).toBeVisible()
  await expect(page.getByText("Saldo após o movimento • 2 UN",{exact:true})).toBeVisible()
  await page.getByRole("link",{name:"Voltar à consulta"}).click()
  await expect(page.getByRole("combobox",{name:"Depósito",exact:true})).toHaveValue(second)
  await expect(row.getByRole("link",{name:/Ver movimentos/})).toBeFocused()
})
