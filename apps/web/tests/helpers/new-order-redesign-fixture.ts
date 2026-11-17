import { expect, type Page } from "@playwright/test"
import type { MixedSimulationInput, Simulation } from "../../src/features/sales/negotiation-types"
import { installFrontendFixture, tenant } from "./frontend-fixture"

const models = [
  "Remada articulada", "Cadeira extensora", "Banco regulável", "Supino convergente",
  "Mesa flexora", "Leg press inclinado", "Pulley frente e costas", "Cadeira abdutora",
  "Puxada articulada", "Agachamento guiado",
]

const versions = {
  imported: "11111111-1111-4111-8111-111111111112",
  national: "11111111-1111-4111-8111-111111111113",
}

export const orderEquipment = Array.from({ length: 40 }, (_, index) => {
  const line = index % 4 === 3 ? "national" : "imported"
  const sequence = String(index + 1).padStart(3, "0")
  const productId = `33000000-0123-3000-2000-${sequence.padStart(12, "0")}`
  const name = `${models[index % models.length]} ${sequence}`
  const priceWithoutIpiCents = 2_000_000 + index * 6500
  const ipiBps = line === "imported" ? 1300 : 0
  const colors = line === "national" ? [] : index % 4 === 1 ? ["Cinza"] : ["Preto", "Cinza"]
  return {
    line,
    price: { productId, name, sku: `TEST-${sequence}`, unit: "UN", available: true, ipiBps, priceWithoutIpiCents, priceWithIpiCents: Math.round(priceWithoutIpiCents * (1 + ipiBps / 10_000)) },
    details: {
      id: productId, name, weight: String(45 + index), structureColors: colors, swingArmColors: colors,
      finishingPalette: "", upholsteryColors: line === "imported" ? ["Preto", "Vermelho"] : [],
      upholsteryConfigurable: line === "imported", plateHolderColors: [], plateHolderTypes: [],
    },
  }
})

const catalog = new Map(orderEquipment.map(({ details }) => [details.id, details]))
const prices = new Map(orderEquipment.map(({ price }) => [price.productId, price]))

function simulation(input: MixedSimulationInput): Simulation {
  const items = input.items.map(({ productId, quantity }) => {
    const price = prices.get(productId)
    if (!price) throw new Error(`Equipamento fora da fixture: ${productId}`)
    const netCents = price.priceWithoutIpiCents * quantity
    const totalCents = price.priceWithIpiCents * quantity
    return { productId, quantity, name: price.name, sku: price.sku, tableUnitCents: price.priceWithoutIpiCents, netCents, ipiCents: totalCents - netCents, totalCents }
  })
  const netSaleCents = items.reduce((sum, item) => sum + item.netCents, 0)
  const totalCents = items.reduce((sum, item) => sum + item.totalCents, 0)
  const minimumDownPaymentCents = Math.ceil(totalCents * 0.7)
  return {
    tenantId: tenant, digest: "a".repeat(64), director: null,
    sale: {
      calculatorVersion: "pedido-fixture", items, tableTotalCents: netSaleCents, netSaleCents,
      discountCents: 0, discountBps: 0, ipiBps: null, ipiCents: totalCents - netSaleCents, totalCents,
      freeDiscountBps: 2000, minimumDownPaymentBps: 7000, minimumDownPaymentCents,
      downPaymentCents: input.downPaymentCents ?? minimumDownPaymentCents, freightCents: input.freightCents, approvalReasons: [],
    },
  }
}

export async function installNewOrderRedesignFixture(page: Page, baseURL?: string) {
  await installFrontendFixture(page.context(), baseURL)
  const batches: string[][] = []
  const individualReads: string[] = []
  const writes: string[] = []
  const simulations: MixedSimulationInput[] = []
  let batchUnavailable = false
  let batchTenant = tenant
  let simulationUnavailable = false

  await page.context().route("**/api/erp/**", async route => {
    const request = route.request()
    const { pathname, searchParams } = new URL(request.url())
    const resource = pathname.slice("/api/erp/".length)
    if (request.method() !== "GET") {
      writes.push(resource)
      if (request.method() === "POST" && resource === "commercial/mixed/simulate") {
        const input = request.postDataJSON() as MixedSimulationInput
        simulations.push(input)
        if (!simulationUnavailable) return route.fulfill({ json: simulation(input) })
        return route.fulfill({ status: 503, json: { title: "Cálculo temporariamente indisponível" } })
      }
      return route.fallback()
    }

    switch (resource) {
      case "me":
        return route.fulfill({ json: {
          tenant: { id: tenant, legalName: "Empresa de teste" },
          permissions: ["sales.orders.read", "sales.orders.manage", "catalog.products.read", "catalog.parties.read", "catalog.parties.manage"],
        } })
      case "company":
        return route.fulfill({ json: { tenantId: tenant, data: { legalName: "Empresa de teste" } } })
      case "parties":
        return route.fulfill({ json: { tenantId: tenant, data: [], total: 0 } })
      case "commercial/tables/imported":
      case "commercial/tables/national": {
        const line = resource.endsWith("imported") ? "imported" : "national"
        return route.fulfill({ json: {
          tenantId: tenant, line, authority: "seller", canManage: false, canCreateOrder: true,
          paymentMethods: [],
          data: {
            id: versions[line], version: 1, publishedAt: "2026-11-16T12:00:00Z", originState: "SP",
            freeDiscountBps: 2000, minimumDownPaymentBps: 7000,
            items: orderEquipment.filter(item => item.line === line).map(item => item.price),
          },
        } })
      }
      case "products/finishes": {
        const ids = (searchParams.get("ids") || "").split(",").filter(Boolean)
        batches.push(ids)
        if (batchUnavailable) return route.fulfill({ status: 503, json: { title: "Acabamentos temporariamente indisponíveis" } })
        return route.fulfill({ json: { tenantId: batchTenant, data: ids.flatMap(id => catalog.get(id) ?? []), missingIds: ids.filter(id => !catalog.has(id)) } })
      }
    }

    const product = /^products\/([^/]+)(?:\/catalog)?$/.exec(resource)
    if (product && catalog.has(product[1])) {
      individualReads.push(resource)
      return route.fulfill({ json: { tenantId: tenant, data: catalog.get(product[1]) } })
    }
    return route.fallback()
  })

  return {
    batches, individualReads, simulations, writes,
    setBatchUnavailable: (unavailable: boolean) => { batchUnavailable = unavailable },
    setBatchTenant: (id: string) => { batchTenant = id },
    setSimulationUnavailable: (unavailable: boolean) => { simulationUnavailable = unavailable },
  }
}

export async function addNewOrderEquipment(page: Page, count: number) {
  const search = page.getByLabel("Buscar equipamento", { exact: true })
  for (const { price } of orderEquipment.slice(0, count)) {
    await search.fill(price.sku)
    await search.press("Enter")
  }
  await expect(page.getByRole("textbox", { name: /^Quantidade de / })).toHaveCount(count)
}
