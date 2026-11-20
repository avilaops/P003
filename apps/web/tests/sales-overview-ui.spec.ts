import { expect, test, type Page } from "@playwright/test"
import { installFrontendFixture, tenant } from "./helpers/frontend-fixture"

const orderId = "22222222-2222-4222-8222-222222222222"
const proposalId = "33333333-3333-4333-8333-333333333333"
const customer = "Academia Horizonte • Equipamentos e Condicionamento Físico LTDA"

async function fixtures(page: Page, canEdit = true, failOrders = false, pricingOrigin = false) {
  const requests: string[] = []
  await page.route(/\/api\/erp\/(orders|proposals)\?/, async route => {
    const url = new URL(route.request().url())
    requests.push(url.pathname + url.search)
    const orders = url.pathname.endsWith("orders")
    const filtered = url.searchParams.get("status") === "draft"
    if (failOrders && orders && !filtered) return route.fulfill({ status: 503, json: { title: "Pedidos temporariamente indisponíveis" } })
    const item = { id: orders ? orderId : proposalId, number: orders ? "4" : "9", customerName: customer, amount: "1234567.89", status: "draft", version: 1, expired: false, updatedAt: "2026-11-16T12:30:00Z", pricingOrigin: orders && pricingOrigin }
    return route.fulfill({ json: { tenantId: tenant, canEdit, data: filtered ? [] : [item], total: filtered ? (orders ? 42 : 17) : 90 } })
  })
  return requests
}

test.beforeEach(async ({ context, baseURL }) => { await installFrontendFixture(context, baseURL) })

test("o indicador abre a população da conversão dos últimos 90 dias", async ({page})=>{
  await fixtures(page)
  const section={group:"conversion",total:4,converted:1,amountCents:"50050"}
  await page.route("**/api/erp/sales/overview*",route=>{
    const group=new URL(route.request().url()).searchParams.get("group")
    return route.fulfill({json:{tenantId:tenant,sections:[{...section,data:group?[{kind:"propostas",id:proposalId,number:"9",customer,amount:50050,converted:true,status:"accepted"}]:[]}]}})
  })
  await page.goto("/vendas",{waitUntil:"domcontentloaded"})
  const card=page.getByRole("link",{name:/Conversão em 90 dias.*25%/})
  await expect(card).toHaveAttribute("href","/vendas/indicadores/conversion")
  await card.click()
  await expect(page.getByRole("heading",{name:"Conversão em 90 dias"})).toBeVisible()
  await expect(page.getByRole("link",{name:"Proposta 9"})).toHaveAttribute("href","/vendas/propostas/"+proposalId)
  await expect(page.getByText("25% • 4 registro(s) • 1 convertido(s)")).toBeVisible()
})

test("resumo usa totais filtrados e recentes separados com retomada direta", async ({ page }) => {
  const requests = await fixtures(page)
  await page.goto("/vendas")
  const orders = page.getByRole("link", { name: /42 Pedidos em rascunho/ })
  await expect(orders).toHaveAttribute("href", "/vendas/pedidos?status=draft")
  await expect(page.getByRole("link", { name: /17 Propostas em rascunho/ })).toHaveAttribute("href", "/vendas/propostas?status=draft")
  const section = page.getByRole("region", { name: "Pedidos de venda", exact: true })
  await expect(section.getByRole("link", { name: "PV-000004", exact: true })).toHaveAttribute("href", `/vendas/pedidos/${orderId}`)
  await expect(section.getByRole("link", { name: "Continuar", exact: true })).toHaveAttribute("href", `/vendas/pedidos/${orderId}/editar`)
  const name = section.locator(".sales-customer-column").getByText(customer, { exact: true })
  await expect(name).toBeVisible()
  await expect(name.locator("xpath=ancestor::a")).toHaveCount(0)
  await expect(section.getByText("R$ 1.234.567,89", { exact: true })).toBeVisible()
  expect(new Set(requests.filter(r => r.includes("status=draft"))).size).toBe(2)
  expect(new Set(requests.filter(r => r.includes("sort=updated") && r.includes("limit=5"))).size).toBe(2)
  const headings = await page.locator("#conteudo-principal h2").allTextContents()
  expect(headings.indexOf("Pedidos de venda")).toBeLessThan(headings.indexOf("Propostas"))
})

test("consulta abre detalhes e não oferece editar nem criar", async ({ page }) => {
  await fixtures(page, false)
  await page.goto("/vendas")
  const section = page.getByRole("region", { name: "Pedidos de venda", exact: true })
  await expect(section.getByRole("link", { name: "Abrir", exact: true })).toHaveAttribute("href", `/vendas/pedidos/${orderId}`)
  await expect(page.getByRole("link", { name: "Continuar", exact: true })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Novo pedido", exact: true })).toHaveCount(0)
  await expect(page.getByRole("link", { name: "Nova proposta", exact: true })).toHaveCount(0)
})

test("pedido com preços preservados abre o detalhe sem prometer edição indisponível", async ({ page }) => {
  await fixtures(page, true, false, true)
  await page.goto("/vendas")
  const orders = page.getByRole("region", { name: "Pedidos de venda", exact: true })
  await expect(orders.getByRole("link", { name: "Abrir", exact: true })).toHaveAttribute("href", `/vendas/pedidos/${orderId}`)
  await expect(orders.getByRole("link", { name: "Continuar", exact: true })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Propostas", exact: true }).getByRole("link", { name: "Continuar", exact: true })).toBeVisible()
})

test("menu de novo pedido funciona por teclado, fecha e devolve foco", async ({ page }) => {
  await fixtures(page)
  await page.goto("/vendas")
  const trigger = page.getByRole("button", { name: "Mais opções de novo pedido", exact: true })
  await trigger.focus()
  await page.keyboard.press("Enter")
  const option = page.getByRole("menuitem", { name: "Pedido pelo catálogo", exact: true })
  await expect(option).toHaveAttribute("href", "/vendas/pedidos/novo?modo=catalogo")
  await page.keyboard.press("Escape")
  await expect(option).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test("falha de pedidos preserva propostas e oferece repetição do bloco", async ({ page }) => {
  await fixtures(page, true, true)
  await page.goto("/vendas")
  await expect(page.getByRole("region", { name: "Propostas", exact: true }).getByRole("link", { name: "Proposta 9", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Tentar consultar pedidos novamente", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: /42 Pedidos em rascunho/ })).toBeVisible()
})

test("resumo carregando reserva espaço sem anunciar zero", async ({ page }) => {
  await fixtures(page)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(/\/api\/erp\/(orders|proposals)\?.*status=draft/, async route => { await gate; await route.fulfill({ json: { tenantId: tenant, canEdit: true, data: [], total: 0 } }) })
  await page.goto("/vendas")
  const summary = page.getByRole("region", { name: "Resumo de vendas", exact: true })
  try {
    await expect(summary.getByText("Carregando…", { exact: true })).toHaveCount(2)
    await expect(summary.getByText("0", { exact: true })).toHaveCount(0)
  } finally { release() }
  await expect(page.getByRole("link", { name: /0 Pedidos em rascunho/ })).toBeVisible()
})

for (const width of [320, 640, 1366]) test(`cabeçalho, valor e ação acessíveis em ${width}px`, async ({ page }) => {
  await fixtures(page)
  await page.setViewportSize({ width, height: 900 })
  await page.goto("/vendas")
  await expect(page.getByRole("heading", { name: "Vendas", exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "Novo pedido", exact: true })).toBeVisible()
  const section = page.getByRole("region", { name: "Pedidos de venda", exact: true })
  await expect(section.getByRole("link", { name: "Continuar", exact: true })).toBeVisible()
  const amount = section.getByText("R$ 1.234.567,89", { exact: true })
  const bounds = await amount.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

for (const scheme of ["light", "dark"] as const) test(`contraste dos textos operacionais no tema ${scheme}`, async ({ page }) => {
  await fixtures(page)
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" })
  await page.goto("/vendas")
  await expect(page.getByRole("region", { name: "Pedidos de venda", exact: true }).getByRole("link", { name: "Continuar", exact: true })).toBeVisible()
  if (scheme === "dark") await expect(page.locator("html")).toHaveClass(/dark/)
  for (const selector of ["h1", ".sales-summary-number", ".sales-panel-heading a", ".sales-record-identity > a", ".sales-recent-table th", ".sales-record-action"]) {
    await expect(page.locator(".sales-overview").locator(selector).first(), selector).toBeAttached()
  }
  const ratios = await page.locator(".sales-overview").filter({ hasNotText: "Carregando" }).first().evaluate(root => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const paint = canvas.getContext("2d")!
    const luminance = (rgb: number[]) => rgb.slice(0, 3).map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
    return ["h1", ".sales-summary-number", ".sales-panel-heading a", ".sales-record-identity > a", ".sales-recent-table th", ".sales-record-action"].map(selector => {
      const element = root.querySelector(selector)!
      paint.fillStyle = "white"; paint.fillRect(0, 0, 1, 1)
      const ancestors: Element[] = []
      for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current)
      for (const parent of ancestors) { paint.fillStyle = getComputedStyle(parent).backgroundColor; paint.fillRect(0, 0, 1, 1) }
      const background = luminance([...paint.getImageData(0, 0, 1, 1).data])
      paint.fillStyle = getComputedStyle(element).color; paint.fillRect(0, 0, 1, 1)
      const foreground = luminance([...paint.getImageData(0, 0, 1, 1).data])
      return { selector, ratio: (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05) }
    })
  })
  for (const sample of ratios) expect(sample.ratio, sample.selector).toBeGreaterThanOrEqual(4.5)
})

test("refluxo equivalente a 200% mantém valor e ação em uma janela de 1280px físicos", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 640, height: 450 }, deviceScaleFactor: 2 })
  try {
    await installFrontendFixture(context, baseURL)
    const page = await context.newPage()
    await fixtures(page)
    await page.goto("/vendas")
    await expect(page.getByRole("region", { name: "Pedidos de venda", exact: true }).getByRole("link", { name: "Continuar", exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const amount = await page.getByRole("region", { name: "Pedidos de venda", exact: true }).getByText("R$ 1.234.567,89", { exact: true }).boundingBox()
    expect(amount!.x + amount!.width).toBeLessThanOrEqual(640)
  } finally { await context.close() }
})
