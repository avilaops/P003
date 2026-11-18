import { expect, test } from "@playwright/test"
import { installFrontendFixture, tenant, record } from "./helpers/frontend-fixture"

const partner = "69696969-6969-4969-8969-696969696969"
const pending = "71717171-7171-4171-8171-717171717171"

test("a ficha permite decidir a renegociação e estornar sem perder o motivo", async ({ context, page, baseURL }) => {
  await installFrontendFixture(context, baseURL)
  let decision: unknown, reversal: unknown
  await page.route("**/api/erp/finance/partners?*", (r) =>
    r.fulfill({
      json: { tenantId: tenant, data: [{ id: partner, name: "Fornecedor piloto", supplier: true, customer: false }] },
    }),
  )
  await page.route("**/api/erp/finance/partner?*", (r) =>
    r.fulfill({
      headers: { etag: '"1"' },
      json: {
        tenantId: tenant,
        allowed: ["payable"],
        writable: ["payable"],
        canEditCredit: false,
        party: { id: partner, name: "Fornecedor piloto", supplier: true, customer: false },
        position: { payable: "80.00", overduePayable: "0.00", averageDays: null, orders: [], purchaseOrders: [] },
      },
    }),
  )
  await page.route("**/api/erp/finance/portfolio?*", (r) => r.fulfill({ json: { tenantId: tenant, total: 0, rows: [] } }))
  await page.route("**/api/erp/financial-accounts?*", (r) => r.fulfill({ json: { tenantId: tenant, data: [] } }))
  await page.route("**/api/erp/finance/operations?*", (r) =>
    r.fulfill({
      json: {
        tenantId: tenant,
        reviews: [
          {
            id: pending,
            status: decision ? "approved" : "pending",
            reason: "Reparcelamento",
            requestedAt: "2026-11-01",
            schedule: [{ amount: "80.00", dueOn: "2026-12-01" }],
            mayDecide: !decision,
          },
        ],
        data: decision
          ? [
              {
                id: record,
                kind: "restructure",
                side: "payable",
                reason: "Reparcelamento",
                occurredOn: "2026-11-01",
                amount: "80.00",
                available: "0.00",
                items: [],
                reversedOn: reversal ? "2026-11-18" : null,
                reversalReason: reversal ? "Conferência do fornecedor" : null,
              },
            ]
          : [],
      },
    }),
  )
  await page.route("**/api/erp/finance/operation-decisions", (r) => {
    decision = r.request().postDataJSON()
    return r.fulfill({ headers: { etag: '"2"' }, json: { tenantId: tenant, data: { id: pending, status: "approved" } } })
  })
  await page.route("**/api/erp/finance/operation-reversals", (r) => {
    reversal = r.request().postDataJSON()
    return r.fulfill({ headers: { etag: '"2"' }, json: { tenantId: tenant, data: { id: record, status: "reversed" } } })
  })
  await page.goto("/financeiro/ficha-financeira?partyId=" + partner)
  await page.getByRole("button", { name: "Decidir solicitação" }).click()
  await page.getByLabel("Justificativa").fill("Parcelas conferidas")
  await page.getByRole("button", { name: "Confirmar decisão" }).click()
  await expect(page.getByText("Aprovada", { exact: true })).toBeVisible()
  expect(decision).toEqual({ id: pending, decision: "approved", reason: "Parcelas conferidas" })
  await page.getByRole("button", { name: "Estornar operação" }).click()
  await page.getByLabel("Data do estorno").fill("2026-11-18")
  await page.getByLabel("Justificativa").fill("Conferência do fornecedor")
  await page.getByRole("button", { name: "Confirmar estorno" }).click()
  await expect(page.getByText(/Estornada em 18\/11\/2026/)).toBeVisible()
  expect(reversal).toEqual({ id: record, occurredOn: "2026-11-18", reason: "Conferência do fornecedor" })
})
