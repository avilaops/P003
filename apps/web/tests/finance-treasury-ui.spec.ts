import { expect, test } from "@playwright/test"
import { installFrontendFixture, record, tenant } from "./helpers/frontend-fixture"

const party = "33333333-3333-4333-8333-333333333333",
  group = "44444444-4444-4444-8444-444444444444",
  title = "55555555-5555-4555-8555-555555555555"
test.beforeEach(async ({ context, baseURL }) => {
  await installFrontendFixture(context, baseURL)
})
test("grupo aberto mantém membros e vencimento e exibe a cobrança existente", async ({ page }) => {
  const account = { id: record, name: "Conta piloto", live: false }
  let sent: unknown = null
  await page.route("**/api/erp/finance/operations?*", (route) =>
    route.fulfill({
      json: {
        tenantId: tenant,
        data: [
          {
            id: group,
            kind: "billing_group",
            dueOn: "2027-03-01",
            items: [{ id: title, side: "receivable", amount: "150.00" }],
          },
        ],
      },
    }),
  )
  await page.route("**/api/erp/finance-treasury/collections?*", (route) =>
    route.fulfill({
      json: {
        tenantId: tenant,
        canEdit: true,
        data: {
          accounts: [account],
          accountId: record,
          options: [],
          charges: sent
            ? [
                {
                  id: group,
                  accountId: record,
                  groupId: group,
                  name: "Cliente de teste",
                  method: "PIX",
                  state: "issued",
                  cents: "15000",
                  dueOn: "2027-03-01",
                  providerId: "123",
                  receivableIds: [title],
                },
              ]
            : [],
        },
      },
    }),
  )
  await page.route("**/api/erp/finance-treasury/issue-charge", (route) => {
    sent = route.request().postDataJSON()
    return route.fulfill({ headers: { ETag: '"1"' }, json: { tenantId: tenant, data: { state: "issued" } } })
  })
  await page.goto("/financeiro/remessas-retornos?groupId=" + group + "&partyId=" + party)
  await expect(page.getByText("Vencimento • 2027-03-01")).toBeVisible()
  await expect(page.getByRole("checkbox")).toHaveCount(0)
  await page.getByRole("button", { name: "Emitir cobrança de teste" }).click()
  await expect(page.getByText("Cliente de teste", { exact: false }).first()).toBeVisible()
  expect(sent).toEqual({ groupId: group, accountId: record, billingType: "PIX", receivableIds: [title] })
  await expect(page.getByRole("button", { name: "Emitir cobrança de teste" })).toHaveCount(0)
})
test("conta do indicador abre o extrato e permite seleção de vários movimentos", async ({ page }) => {
  const account = { id: record, code: "PILOTO", name: "Conta piloto", status: "active", accountType: "bank" }
  await page.route("**/api/erp/financial-accounts?*", (r) =>
    r.fulfill({ json: { tenantId: tenant, data: [{ ...account, id: party }, account], total: 2 } }),
  )
  await page.route("**/api/erp/financial-account-entries?*", (r) =>
    r.fulfill({
      json: {
        tenantId: tenant,
        canEdit: true,
        data: { account, credit: "100.00", debit: "0.00", balance: "100.00", entries: [], total: 0 },
      },
    }),
  )
  const details = {
    lines: [
      {
        id: group,
        fitId: "FIT1",
        bookedOn: "2026-10-05",
        description: "Crédito bancário",
        cents: "10000",
        state: "pending",
        suggestions: [],
        entryIds: [],
      },
    ],
    entries: [
      { id: party, occurredOn: "2026-10-05", description: "Primeira parcela", cents: "4000" },
      { id: title, occurredOn: "2026-10-05", description: "Segunda parcela", cents: "6000" },
    ],
    periods: [],
    bank: null,
    sessions: [],
    canClose: true,
    canReopen: false,
  }
  await page.route("**/api/erp/finance-treasury/reconciliation?*", (r) =>
    r.fulfill({ json: { tenantId: tenant, canEdit: true, data: details } }),
  )
  let submitted: unknown
  await page.route("**/api/erp/finance-treasury/match", (r) => {
    submitted = r.request().postDataJSON()
    return r.fulfill({ headers: { ETag: '"1"' }, json: { tenantId: tenant, data: {} } })
  })
  await page.goto("/financeiro/caixas-bancos?accountId=" + record)
  await expect(page.getByRole("combobox", { name: "Conta financeira", exact: true })).toHaveValue(record)
  await page.getByRole("radio", { name: /Crédito bancário/ }).check()
  await page.getByRole("checkbox", { name: /Primeira parcela/ }).check()
  await page.getByRole("checkbox", { name: /Segunda parcela/ }).check()
  await page.getByRole("button", { name: "Conciliar 2 movimento(s)" }).click()
  await expect(page.getByText("Operação registrada.")).toBeVisible()
  expect(submitted).toEqual({ accountId: record, lineId: group, entryIds: [party, title], reason: null })
})
test("webhook público exige assinatura e recusa corpo excedente antes do encaminhamento", async ({ request }) => {
  const path = "/api/integrations/finance/mercadopago/" + tenant + "/" + record + "?data.id=123"
  expect((await request.post(path, { data: {} })).status()).toBe(401)
  expect(
    (
      await request.post(path, {
        data: { p: "x".repeat(33000) },
        headers: { "x-signature": "signed", "x-request-id": "request" },
      })
    ).status(),
  ).toBe(413)
})
