import { expect, test } from "@playwright/test"
import { createHash } from "node:crypto"
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
        documentReferences: ["DOC-805"],
        suggestions: [record],
        suggestedEntries: [{ id: record, occurredOn: "2026-10-05", description: "Reembolso integral",
          cents: "10000", reference: "DOC-805", documentMatch: true }],
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
  const choices = page.getByRole("region", { name: "Movimentos do ERP disponíveis" }).getByRole("checkbox")
  await expect(choices.first()).toHaveAccessibleName(/Reembolso integral.*mesmo documento, data e valor/)
  await expect(choices.first()).not.toBeChecked()
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

test("CNAB • baixa o arquivo original, repete uma confirmação e consulta o retorno com permissão de leitura", async ({
  page,
}) => {
  const account = { id: record, name: "Conta de ensaio", bank: "033", branch: "1234-0", accountNumber: "000054321-9" }
  const agreement = {
    id: party,
    taxId: "12345678000190",
    name: "Empresa de exemplo",
    transmissionCode: "000000123456789",
    beneficiaryCode: "123456789",
    agency: "1234",
    agencyDigit: "0",
    account: "000054321",
    accountDigit: "9",
    nextSequence: 2,
    nextOurNumber: "2",
    interestMonthlyBps: 100,
    fineBps: 200,
  }
  const now = "2026-11-18T10:00:00Z"
  const batch = {
    id: group,
    accountId: record,
    accountName: account.name,
    reference: "Borderô local",
    cancelledAt: null,
    createdAt: now,
    createdBy: "Operador de teste",
    count: 1,
    cents: "4050",
  }
  const content = "03300000".padEnd(240) + "\r\n" + "03399999".padEnd(240) + "\r\n"
  const remittance = {
    id: group,
    batchId: group,
    filename: "COBR000001.REM",
    sequence: 1,
    createdAt: now,
    createdBy: batch.createdBy,
    sha256: createHash("sha256").update(content).digest("hex"),
    count: 1,
    cents: "4050",
  }
  const returnText = "03300000".padEnd(72) + "EMPRESA DE COBRANÇA".padEnd(168) + "\r\n"
  const reviews: {
    id: string
    state: string
    reason: string | null
    reviewReason: string
    createdAt: string
    createdBy: string
  }[] = []
  const receipt = {
    id: title,
    filename: "retorno.ret",
    sequence: 2,
    createdAt: now,
    createdBy: batch.createdBy,
    sha256: createHash("sha256").update(returnText).digest("hex"),
    count: 3,
    outcomes: [
      {
        ordinal: 1,
        ourNumber: "0000000000019",
        occurrence: "03",
        state: "rejected",
        reason: "CEP inválido",
        receivableId: title,
        nominalCents: "4050",
        paidCents: null,
        feeCents: null,
        netCents: null,
        occurredOn: "2026-11-16",
        creditOn: null,
        reviews: [],
      },
      {
        ordinal: 2,
        ourNumber: "0000000000027",
        occurrence: "06",
        state: "paid",
        reason: null,
        receivableId: party,
        nominalCents: "123456",
        paidCents: "123456",
        feeCents: "225",
        netCents: "123231",
        occurredOn: "2026-11-15",
        creditOn: "2026-11-16",
        reviews: [],
      },
      {
        ordinal: 3,
        ourNumber: "0000000000035",
        occurrence: "06",
        state: "review",
        reason: "Saldo do título diverge do valor nominal",
        receivableId: group,
        nominalCents: "8700",
        paidCents: "8700",
        feeCents: "0",
        netCents: "8700",
        occurredOn: "2026-11-16",
        creditOn: "2026-11-17",
        reviews,
      },
    ],
  }
  let canManage = true
  let imported = false
  const attempts: { key: string; body: object }[] = []
  const reply = (data: unknown) => ({ tenantId: tenant, canEdit: true, data })
  await page.route("**/api/erp/finance-treasury/collections", (route) =>
    route.fulfill({ json: reply({ accounts: [], accountId: null, options: [], charges: [] }) }),
  )
  await page.route("**/api/erp/finance-treasury/batches?*", (route) => {
    const details = new URL(route.request().url()).searchParams.has("batchId")
    return route.fulfill({
      json: reply(
        details
          ? {
              batch,
              items: [
                {
                  id: title,
                  partyId: party,
                  name: "Cliente local",
                  dueOn: "2026-12-10",
                  cents: "4050",
                  state: "remitted",
                  cnabOurNumber: "0000000000019",
                  events: [],
                },
              ],
              canIssue: canManage,
            }
          : { accounts: [account], candidates: [], history: [batch], more: false, moreHistory: false },
      ),
    })
  })
  await page.route("**/api/erp/finance-treasury/cnab-profile?*", (route) =>
    route.fulfill({
      json: reply({
        account,
        company: { taxId: agreement.taxId, name: agreement.name },
        profile: agreement,
        canManage,
        remittances: [remittance],
        returns: imported ? [receipt] : [],
        moreRemittances: false,
        moreReturns: false,
      }),
    }),
  )
  await page.route("**/api/erp/finance-treasury/cnab-remittance?*", (route) => {
    expect(Object.fromEntries(new URL(route.request().url()).searchParams)).toEqual({
      accountId: record,
      batchId: group,
    })
    return route.fulfill({ json: reply({ filename: remittance.filename, content }) })
  })
  await page.route("**/api/erp/finance-treasury/cnab-return", (route) => {
    attempts.push({ key: route.request().headers()["idempotency-key"]!, body: route.request().postDataJSON() })
    if (attempts.length === 1) return route.fulfill({ status: 503, json: { title: "Confirmação interrompida" } })
    imported = true
    return route.fulfill({ headers: { ETag: '"1"' }, json: reply(receipt) })
  })
  await page.route("**/api/erp/finance-treasury/cnab-review", (route) => {
    const body = route.request().postDataJSON()
    expect(body).toEqual({ accountId: record, returnId: title, ordinal: 3, reason: "Saldo do título corrigido" })
    const attempt = {
      id: party,
      state: "paid",
      reason: null,
      reviewReason: body.reason,
      createdBy: batch.createdBy,
      createdAt: now,
    }
    reviews.push(attempt)
    return route.fulfill({
      headers: { ETag: '"1"' },
      json: reply({ ...attempt, accountId: record, returnId: title, ordinal: 3 }),
    })
  })
  async function open() {
    await page.goto("/financeiro/remessas-retornos")
    await page.getByRole("button", { name: "Preparar ou consultar borderô" }).click()
    await page.getByRole("button", { name: "Borderô local" }).click()
    await page.getByRole("button", { name: "Remessa e retorno CNAB 240 • Santander" }).click()
  }
  await open()
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Baixar remessa original" }).click()
  const saved = await download
  expect(saved.suggestedFilename()).toBe(remittance.filename)
  const chunks: Buffer[] = []
  for await (const chunk of (await saved.createReadStream())!) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(content, "ascii"))

  const file = page.getByLabel("Arquivo de retorno CNAB 240 • até 2 MB")
  await file.setInputFiles({ name: "grande.ret", mimeType: "text/plain", buffer: Buffer.alloc(2_000_001) })
  await page.getByRole("button", { name: "Importar retorno CNAB" }).click()
  await expect(page.getByRole("region", { name: "Cobrança CNAB 240 • Santander" }).getByRole("alert")).toHaveText(
    "Selecione um arquivo de até 2 MB",
  )
  expect(attempts).toHaveLength(0)
  await file.setInputFiles({ name: "retorno.ret", mimeType: "text/plain", buffer: Buffer.from(returnText, "latin1") })
  await page.getByRole("button", { name: "Importar retorno CNAB" }).click()
  await expect(page.getByText("Confirmação interrompida")).toBeVisible()
  await expect(page.getByRole("button", { name: "Voltar ao borderô" })).toBeDisabled()
  await page.getByRole("button", { name: "Conferir última operação CNAB" }).click()
  await expect(page.getByText("CEP inválido")).toBeVisible()
  const paid = page.getByRole("listitem").filter({ hasText: "Nosso número 0000000000027" })
  const divergent = page.getByRole("listitem").filter({ hasText: "Nosso número 0000000000035" })
  const rejected = page.getByRole("listitem").filter({ hasText: "Nosso número 0000000000019" })
  const definitions = (row: typeof paid) => row.locator("dl dd")
  await expect(definitions(paid)).toHaveText([
    "R$ 1.234,56",
    "R$ 1.234,56",
    "R$ 2,25",
    "R$ 1.232,31",
    "15/11/2026",
    "16/11/2026",
  ])
  await expect(definitions(divergent)).toHaveText([
    "R$ 87,00",
    "R$ 87,00",
    "R$ 0,00",
    "R$ 87,00",
    "16/11/2026",
    "17/11/2026",
  ])
  await expect(definitions(rejected)).toHaveText([
    "R$ 40,50",
    "Sem informação",
    "Sem informação",
    "Sem informação",
    "16/11/2026",
    "Sem informação",
  ])
  expect(attempts).toHaveLength(2)
  expect(attempts[0]).toEqual(attempts[1])
  expect(attempts[1]!.key).toBeTruthy()
  expect(attempts[1]!.body).toEqual({ accountId: record, fileName: "retorno.ret", content: returnText })
  await file.setInputFiles({ name: "retorno.ret", mimeType: "text/plain", buffer: Buffer.from(returnText, "utf8") })
  await page.getByRole("button", { name: "Importar retorno CNAB" }).click()
  await expect.poll(() => attempts.length).toBe(3)
  expect(attempts[2]!.body).toEqual(attempts[1]!.body)

  canManage = false
  await open()
  await expect(page.getByRole("button", { name: "Baixar remessa original" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Editar convênio" })).toHaveCount(0)
  await expect(file).toHaveCount(0)
  await page.getByText(/retorno\.ret • Sequência/).click()
  await expect(page.getByText("Entrada rejeitada", { exact: true })).toBeVisible()
  await expect(page.getByText("CEP inválido")).toBeVisible()
  await expect(divergent.getByRole("button", { name: "Reavaliar ocorrência" })).toHaveCount(0)
  canManage = true
  await open()
  await page.getByText(/retorno\.ret • Sequência/).click()
  await divergent.getByRole("button", { name: "Reavaliar ocorrência" }).click()
  await divergent.getByLabel("Motivo da reavaliação").fill("Saldo do título corrigido")
  await divergent.getByRole("button", { name: "Confirmar reavaliação" }).click()
  await expect(divergent.getByText("Reavaliação • Liquidado")).toBeVisible()
  await expect(divergent.getByText("Motivo informado • Saldo do título corrigido")).toBeVisible()
  await expect(divergent.getByText("Saldo do título diverge do valor nominal")).toBeVisible()
  await expect(divergent.getByRole("button", { name: "Reavaliar ocorrência" })).toHaveCount(0)
})
