import { expect, test, type Locator, type Page } from "@playwright/test"
import { addNewOrderEquipment, installNewOrderRedesignFixture, orderEquipment } from "./helpers/new-order-redesign-fixture"

const sizes = [{ width: 375, height: 812 }, { width: 1280, height: 800 }]
const counts = [1, 14, 40]
const newOrder = "/vendas/pedidos/novo"

function finishesTrigger(page: Page, index: number) {
  return page.getByRole("button", { name: `Acabamentos de ${orderEquipment[index].price.name}`, exact: true })
}

function quantityField(page: Page, index: number) {
  return page.getByRole("textbox", { name: `Quantidade de ${orderEquipment[index].price.name}`, exact: true })
}

async function expectPageFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
}

function orderAmount(count: number, firstQuantity = 1) {
  const cents = orderEquipment.slice(0, count).reduce((sum, item, index) => sum + item.price.priceWithIpiCents * (index === 0 ? firstQuantity : 1), 0)
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100).replace(/\s+/g, " ")
}

function summaryLocators(page: Page, mobile: boolean) {
  const summary = mobile ? page.getByRole("region", { name: "Resumo rápido do pedido" }) : page.getByRole("complementary", { name: "Revisão e totais" })
  const totals = mobile ? summary : summary.getByRole("region", { name: "Totais do pedido" })
  return { summary, totals }
}

async function expectSummaryWhileScrolling(page: Page, width: number, count: number, calculated: boolean) {
  const mobile = width < 768
  const { summary, totals } = summaryLocators(page, mobile)
  const label = totals.getByText(calculated ? "Total do pedido" : "Total de tabela", { exact: true }).first()
  const total = totals.getByText(orderAmount(count), { exact: true }).first()
  const pendencies = summary.getByText(/^\d+ pendências?(?: para salvar)?$/).first()
  await expect(label).toBeVisible()
  if (mobile) {
    const navigation = page.getByRole("navigation", { name: "Seções do pedido" })
    expect((await navigation.boundingBox())?.height ?? Infinity).toBeLessThanOrEqual(48)
  }
  for (const fraction of [0, 0.5, 1]) {
    await page.evaluate(fraction => window.scrollTo({ top: (document.documentElement.scrollHeight - innerHeight) * fraction, behavior: "instant" }), fraction)
    await expect(label).toBeInViewport({ ratio: 0.95 })
    await expect(total).toBeInViewport({ ratio: 0.95 })
    await expect(pendencies).toBeInViewport({ ratio: 0.95 })
    await expectPageFits(page)
  }
}

async function verifyLongListControls(page: Page, list: Locator) {
  const filter = page.getByRole("searchbox", { name: "Filtrar equipamentos do pedido", exact: true })
  const { name, sku } = orderEquipment[39].price
  await filter.fill(sku)
  await expect(list.getByRole("rowheader")).toHaveCount(1)
  await expect(list.getByRole("rowheader")).toContainText(name)
  await page.getByRole("button", { name: "Recolher lista", exact: true }).click()
  await expect(list).toBeHidden()
  await expect(page.getByText(/Peso 2\.580 kg.*Total de tabela/)).toBeVisible()
  await page.getByRole("button", { name: "Exibir 40 equipamentos", exact: true }).click()
  await expect(filter).toHaveValue(sku)
  await filter.clear()
  await expect(list.getByRole("rowheader")).toHaveCount(40)
}

function structureColor(dialog: Locator, index: number) {
  return dialog.getByRole("combobox", { name: `Cor da estrutura de ${orderEquipment[index].price.name}`, exact: true })
}

async function chooseStructureColor(page: Page, dialog: Locator, index: number, color: string) {
  await structureColor(dialog, index).click()
  await page.getByRole("option", { name: color, exact: true }).click()
  await expect(structureColor(dialog, index)).toHaveText(color)
}

async function finishOrderInBulk(page: Page, walkthrough: boolean) {
  const drawer = page.getByRole("dialog", { name: "Acabamentos", exact: true })
  const previous = drawer.getByRole("button", { name: "Item anterior", exact: true })
  const next = drawer.getByRole("button", { name: "Próximo item", exact: true })

  await finishesTrigger(page, 0).click()
  await expect(previous).toBeDisabled()
  await next.click()
  await chooseStructureColor(page, drawer, 1, "Cinza")
  await previous.click()
  await chooseStructureColor(page, drawer, 0, "Preto")
  await drawer.getByRole("button", { name: "Aplicar estas cores a todos os itens compatíveis", exact: true }).click()
  await expect(drawer.getByRole("status").getByText(/6 equipamentos.*7 equipamentos.*partes sem a cor selecionada/)).toBeVisible()

  await next.click()
  await expect(structureColor(drawer, 1)).toHaveText("Cinza")
  await next.click()
  await expect(structureColor(drawer, 2)).toHaveText("Preto")
  await next.click()
  await expect(drawer.getByText("Sem cores disponíveis.", { exact: true })).toBeVisible()
  await expect(drawer.getByRole("combobox", { name: /^Cor / })).toHaveCount(0)

  if (walkthrough) {
    for (let index = 4; index < 14; index++) {
      await next.click()
      await expect(drawer).toHaveAccessibleDescription(new RegExp(`${orderEquipment[index].price.name}.*${index + 1} de 14`))
    }
    await expect(next).toBeDisabled()
    await previous.click()
    await expect(drawer).toHaveAccessibleDescription(/13 de 14$/)
  }
  await page.keyboard.press("Escape")
  await expect(drawer).toBeHidden()
  await expect(finishesTrigger(page, 0)).toBeFocused()
}

function expectNoPersistence(writes: string[]) {
  expect(writes.filter(path => path !== "commercial/mixed/simulate")).toEqual([])
}

export function registerNewOrderRedesignCases() {
  test.describe("Novo pedido • redesenho", () => {
    for (const size of sizes) for (const count of counts) {
      const viewport = `${size.width}x${size.height}`
      const items = count === 1 ? "1 equipamento" : `${count} equipamentos`
      test(`${items} em ${viewport} • resumo e largura`, async ({ page, baseURL }, info) => {
        const fixture = await installNewOrderRedesignFixture(page, baseURL)
        const calculated = size.width !== 375 || count !== 1
        fixture.setSimulationUnavailable(!calculated)
        await page.setViewportSize(size)
        await page.goto(newOrder)
        await addNewOrderEquipment(page, count)
        const list = page.getByRole("table", { name: "Equipamentos do pedido", exact: true })
        await expect(list.getByRole("rowheader")).toHaveCount(count)
        await expect(list.getByRole("button", { name: /^Acabamentos de / })).toHaveCount(count)
        expect(new Set(fixture.batches.flat())).toEqual(new Set(orderEquipment.slice(0, count).map(item => item.price.productId)))
        expect(fixture.individualReads).toEqual([])

        await expectSummaryWhileScrolling(page, size.width, count, calculated)
        if (count === 1 && calculated) {
          await addNewOrderEquipment(page, 1)
          await expect(quantityField(page, 0)).toHaveValue("2")
          const { totals } = summaryLocators(page, false)
          await expect(totals.getByText(orderAmount(1, 2), { exact: true })).toBeVisible()
          await expect.poll(() => fixture.simulations.at(-1)?.items[0].quantity).toBe(2)
          expect(fixture.batches).toHaveLength(1)
        }
        if (count === 40 && size.width === 1280) await verifyLongListControls(page, list)
        if (count === 14) {
          await finishOrderInBulk(page, size.width === 1280)
          const { totals } = summaryLocators(page, size.width < 768)
          await expect(totals.getByText(orderAmount(count), { exact: true }).first()).toBeVisible()
          const bounds = await list.boundingBox()
          const listHeight = Math.round(bounds?.height ?? Infinity)
          const metrics = { viewport, count, listHeight, listScreens: listHeight / size.height, individualReads: fixture.individualReads.length, batchReads: fixture.batches.length }
          await info.attach(`geometria-${viewport}.json`, { body: JSON.stringify(metrics, null, 2), contentType: "application/json" })
          expect(listHeight).toBeLessThanOrEqual(size.height * (size.width < 768 ? 4 : 2))
          await page.screenshot({ path: info.outputPath(`after-${viewport}.png`), fullPage: true, animations: "disabled" })
          await list.evaluate(element => window.scrollBy({ top: element.getBoundingClientRect().top - 195, behavior: "instant" }))
          await page.screenshot({ path: info.outputPath(`after-viewport-${viewport}.png`), animations: "disabled" })
        }
        expectNoPersistence(fixture.writes)
      })
    }

    test("Tab e Shift+Tab ficam no painel e Esc restaura o acionador", async ({ page, baseURL }) => {
      await installNewOrderRedesignFixture(page, baseURL)
      await page.setViewportSize(sizes[0])
      await page.goto(newOrder)
      await addNewOrderEquipment(page, 1)
      const trigger = finishesTrigger(page, 0)
      await trigger.press("Enter")
      const drawer = page.getByRole("dialog", { name: "Acabamentos", exact: true })
      await expect(drawer.getByRole("button", { name: "Fechar acabamentos", exact: true })).toBeFocused()
      const focused = new Set<string>()
      for (const key of ["Tab", "Shift+Tab"]) {
        for (let step = 0; step < 8; step++) {
          await page.keyboard.press(key)
          await expect.poll(() => drawer.evaluate(element => element.contains(document.activeElement))).toBe(true)
          focused.add(await drawer.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? ""))
        }
      }
      expect(focused.size).toBeGreaterThan(1)
      await page.keyboard.press("Escape")
      await expect(drawer).toBeHidden()
      await expect(trigger).toBeFocused()
      await expect(trigger).toBeInViewport()
    })

    test("o cliente vazio gera uma pendência e a revisão foca o equipamento correto", async ({ page, baseURL }) => {
      const fixture = await installNewOrderRedesignFixture(page, baseURL)
      await page.setViewportSize(sizes[0])
      await page.goto(newOrder)
      await addNewOrderEquipment(page, 2)
      const quantity = quantityField(page, 1)
      await quantity.fill("0")
      await page.getByRole("button", { name: "Revisar pedido", exact: true }).click()
      const pending = page.getByRole("region", { name: "Pendências do pedido", exact: true })
      await expect(pending.getByText(/^Cliente • 1 pendência$/)).toBeVisible()
      await expect(pending.getByRole("button", { name: /Selecione ou cadastre o cliente/ })).toBeVisible()
      await pending.getByRole("button", { name: new RegExp(orderEquipment[1].price.name) }).click()
      await expect(quantity).toBeFocused()
      await expect(quantity).toBeInViewport({ ratio: 1 })
      expect(await quantity.evaluate(element => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return document.elementFromPoint(x + width / 2, y + height / 2) === element
      })).toBe(true)
      expectNoPersistence(fixture.writes)
    })

    test("recarregar 14 acabamentos usa um lote e preserva as quantidades", async ({ page, baseURL }) => {
      const fixture = await installNewOrderRedesignFixture(page, baseURL)
      fixture.setBatchUnavailable(true)
      await page.setViewportSize(sizes[1])
      await page.goto(newOrder)
      await addNewOrderEquipment(page, 14)
      await expect(page.getByText("Acabamentos indisponíveis em 14 equipamentos.", { exact: true })).toBeVisible()
      const quantity = quantityField(page, 0)
      await quantity.fill("3")
      const beforeRetry = fixture.batches.length
      fixture.setBatchUnavailable(false)
      await page.getByRole("button", { name: "Recarregar todos os acabamentos", exact: true }).click()
      const list = page.getByRole("table", { name: "Equipamentos do pedido", exact: true })
      await expect(list.getByRole("button", { name: /^Acabamentos de / })).toHaveCount(14)
      expect(fixture.batches.slice(beforeRetry)).toEqual([orderEquipment.slice(0, 14).map(item => item.price.productId)])
      expect(fixture.individualReads).toEqual([])
      await expect(quantity).toHaveValue("3")
      await expect(page.getByRole("region", { name: "Peso do pedido", exact: true })).toContainText("811 kg")
      expectNoPersistence(fixture.writes)
    })

    test("lista, navegação e painel cabem em 768, 1024 e 1440 px", async ({ page, baseURL }) => {
      await installNewOrderRedesignFixture(page, baseURL)
      await page.goto(newOrder)
      await addNewOrderEquipment(page, 1)
      const trigger = finishesTrigger(page, 0)
      for (const width of [768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 800 })
        await expectPageFits(page)
        await expect(page.getByRole("navigation", { name: "Seções do pedido" })).toBeInViewport()
        await trigger.click()
        const drawer = page.getByRole("dialog", { name: "Acabamentos", exact: true })
        await expect(drawer).toBeInViewport({ ratio: 0.99 })
        await expectPageFits(page)
        await page.keyboard.press("Escape")
        await expect(drawer).toBeHidden()
        await expect(trigger).toBeFocused()
      }
    })
  })
}
