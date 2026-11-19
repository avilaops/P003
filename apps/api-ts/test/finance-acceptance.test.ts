import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { createTestContext, databaseTestOptions, type TestContext } from "./support/test-context.js"

/**
 * Aceite do backlog do Financeiro (D05, PR #297).
 *
 * Cada subteste leva o nome literal do critério de aceite do item no PR, roda
 * contra a aplicação completa (`buildApp`) com PostgreSQL descartável e cobre
 * sucesso, 401, 403, 422 e 409/412 das rotas usadas.
 */

const finance = [
  "finance.receivables.read",
  "finance.receivables.manage",
  "finance.payables.read",
  "finance.payables.manage",
  "finance.account_entries.read",
  "finance.account_entries.manage",
  "finance.categories.read",
  "finance.categories.manage",
  "finance.commissions.read",
  "finance.collections.read",
  "finance.collections.manage",
  "platform.company.manage",
]

async function seedReceivable(
  ctx: TestContext,
  cents: number,
  dueDate: string,
  orderStatus = "completed",
  partyId?: string,
) {
  const order = randomUUID(),
    receivable = randomUUID()
  await ctx.seed.query(
    "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','52998224725',$4,$5,$6)",
    [order, ctx.tenant, partyId ?? (await customer(ctx)), dueDate, cents, orderStatus],
  )
  await ctx.seed.query(
    "INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente',$4,$5,'open')",
    [receivable, ctx.tenant, order, dueDate, cents],
  )
  return { order, receivable }
}
async function customer(ctx: TestContext) {
  const existing = await ctx.seed.query("SELECT id FROM parties WHERE tenant_id=$1 AND tax_id='52998224725'", [ctx.tenant])
  if (existing.rows[0]) return String(existing.rows[0].id)
  const id = randomUUID()
  await ctx.seed.query(
    "INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente','52998224725',true,true,'active')",
    [id, ctx.tenant],
  )
  return id
}
async function newParty(ctx: TestContext, name: string) {
  const id = randomUUID()
  await ctx.seed.query(
    "INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'juridica',$3,'04252011000110',true,true,'active')",
    [id, ctx.tenant, name],
  )
  return id
}
async function bankAccount(ctx: TestContext, accountNumber = "12345") {
  const id = randomUUID()
  await ctx.seed.query(
    "INSERT INTO financial_accounts(id,tenant_id,code,name,status,revision,account_type,account_number) VALUES($1,$2,$3,'Banco piloto','active',1,'bank',$4)",
    [id, ctx.tenant, "BANCO" + accountNumber, accountNumber],
  )
  return id
}
async function seedPayable(ctx: TestContext, cents: number, dueDate: string) {
  const purchase = randomUUID(),
    receipt = randomUUID(),
    payable = randomUUID()
  await ctx.seed.query(
    "INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Fornecedor','52998224725',$4,$5,'received')",
    [purchase, ctx.tenant, await customer(ctx), dueDate, cents],
  )
  await ctx.seed.query(
    "INSERT INTO purchase_receipts(id,tenant_id,order_id,reference,occurred_on,amount_cents) VALUES($1,$2,$3,'Recebimento',$4,$5)",
    [receipt, ctx.tenant, purchase, dueDate, cents],
  )
  await ctx.seed.query(
    "INSERT INTO payables(id,tenant_id,receipt_id,supplier_name,due_date,amount_cents) VALUES($1,$2,$3,'Fornecedor',$4,$5)",
    [payable, ctx.tenant, receipt, dueDate, cents],
  )
  return { purchase, receipt, payable }
}
async function nature(ctx: TestContext, id: string | null) {
  const row = await ctx.seed.query("SELECT code,name,direction FROM financial_categories WHERE tenant_id=$1 AND id=$2", [
    ctx.tenant,
    id,
  ])
  return row.rows[0] as { code: string; name: string; direction: string } | undefined
}
async function newCategory(ctx: TestContext, code: string, name: string, direction: "income" | "expense") {
  const id = randomUUID()
  await ctx.seed.query(
    "INSERT INTO financial_categories(id,tenant_id,code,name,direction,status,revision) VALUES($1,$2,$3,$4,$5,'active',1)",
    [id, ctx.tenant, code, name, direction],
  )
  return id
}
async function setCharges(ctx: TestContext, settings: Record<string, unknown>) {
  const current = await ctx.as("user").get("/api/v1/financial-wallet-settings")
  assert.equal(current.statusCode, 200, current.body)
  const { revision, data } = current.json()
  const saved = await ctx.as("user").put("/api/v1/financial-wallet-settings", {
    revision: Number(revision),
    body: { ...data, ...settings },
  })
  assert.equal(saved.statusCode, 200, saved.body)
}

test("Financeiro • aceite do backlog D05", databaseTestOptions, async (t) => {
  const ctx = await createTestContext({ permissions: finance })
  try {
    await t.test(
      "FI1 • Receber metade de um título vencido com juros gera baixa parcial, lançamento no extrato e saldo restante correto",
      async () => {
        // 3% ao mês, multa de 2%, sem carência: 30 dias de atraso sobre R$ 500,00 de principal.
        await setCharges(ctx, { interestMonthlyBps: 300, penaltyBps: 200, graceDays: 0 })
        const { receivable } = await seedReceivable(ctx, 100000, "2026-01-01")
        const account = await bankAccount(ctx)
        const path = `/api/v1/receivables/${receivable}`
        const payment = {
          amount: "500.00",
          method: "bank_transfer",
          reference: "Metade do título",
          occurredOn: "2026-01-31",
          financialAccountId: account,
        }

        assert.equal((await ctx.as("anonymous").post(path + "/payments", { body: payment, revision: 1 })).statusCode, 401)
        assert.equal((await ctx.as("denied").post(path + "/payments", { body: payment, revision: 1 })).statusCode, 403)
        assert.equal((await ctx.as("outsider").post(path + "/payments", { body: payment, revision: 1 })).statusCode, 403)
        assert.equal(
          (await ctx.as("user").post(path + "/payments", { body: { ...payment, amount: "abc" }, revision: 1 })).statusCode,
          422,
        )
        assert.equal(
          (await ctx.as("user").post(path + "/payments", { body: { ...payment, amount: "1000.01" }, revision: 1 }))
            .statusCode,
          409,
        )
        assert.equal((await ctx.as("user").post(path + "/payments", { body: payment, revision: 9 })).statusCode, 412)

        const key = randomUUID()
        const paid = await ctx.as("user").post(path + "/payments", { body: payment, revision: 1, idempotencyKey: key })
        assert.equal(paid.statusCode, 200, paid.body)
        const again = await ctx.as("user").post(path + "/payments", { body: payment, revision: 1, idempotencyKey: key })
        assert.deepEqual(again.json(), paid.json(), "a repetição devolve o mesmo resultado")

        const body = paid.json(),
          baixa = body.payments.at(-1)
        assert.equal(body.data.outstandingAmount, "500.00", "saldo restante do título")
        assert.equal(body.data.status, "open", "baixa parcial mantém o título aberto")
        assert.equal(baixa.amount, "500.00")
        assert.equal(baixa.interestAmount, "15.00", "3% a.m. × 30 dias sobre R$ 500,00")
        assert.equal(baixa.penaltyAmount, "10.00", "multa de 2% sobre R$ 500,00")
        assert.equal(baixa.netAmount, "525.00")
        assert.ok(baixa.natureId, "a baixa herda a natureza do título")

        const entry = await ctx.seed.query(
          "SELECT account_id,direction,amount_cents::text AS cents,occurred_on::text AS day FROM financial_account_entries WHERE tenant_id=$1 AND id=$2",
          [ctx.tenant, baixa.accountEntryId],
        )
        assert.deepEqual(entry.rows[0], { account_id: account, direction: "credit", cents: "52500", day: "2026-01-31" })

        const ledger = await ctx.as("user").get("/api/v1/financial-account-entries", { query: { accountId: account } })
        assert.equal(ledger.statusCode, 200, ledger.body)
        assert.equal(ledger.json().data.balance, "525.00")

        // O estorno referencia a baixa, devolve o saldo e lança a contrapartida no extrato.
        const reversed = await ctx.as("user").post(path + "/reverse-payment", {
          body: { paymentId: baixa.id, reason: "Estorno do teste", occurredOn: "2026-02-01" },
          revision: Number(body.data.revision),
        })
        assert.equal(reversed.statusCode, 200, reversed.body)
        assert.equal(reversed.json().data.outstandingAmount, "1000.00")
        const after = await ctx.as("user").get("/api/v1/financial-account-entries", { query: { accountId: account } })
        assert.equal(after.json().data.balance, "0.00")
      },
    )

    await t.test("FI2 • Nenhum título novo fica sem categoria; o padrão vem da origem e pode ser alterado", async () => {
      // Padrão pela origem: venda → Receita de vendas; compra → Fornecedores.
      const { receivable } = await seedReceivable(ctx, 20000, "2026-03-10")
      const { payable } = await seedPayable(ctx, 30000, "2026-03-10")
      const titles = async () =>
        (
          await ctx.seed.query(
            "SELECT 'r' AS side,id,category_id FROM receivables WHERE tenant_id=$1 UNION ALL SELECT 'p',id,category_id FROM payables WHERE tenant_id=$1",
            [ctx.tenant],
          )
        ).rows
      for (const row of await titles()) assert.ok(row.category_id, "título sem natureza: " + row.id)
      const sale = (await ctx.as("user").get(`/api/v1/receivables/${receivable}`)).json()
      assert.deepEqual(await nature(ctx, sale.data.natureId), { code: "ERP.VENDAS", name: "Receita de vendas", direction: "income" })
      const purchase = (await ctx.as("user").get(`/api/v1/payables/${payable}`)).json()
      assert.deepEqual(await nature(ctx, purchase.data.natureId), {
        code: "ERP.FORNECEDORES",
        name: "Fornecedores",
        direction: "expense",
      })

      // A empresa pode trocar o padrão de cada origem: o próximo título nasce com a nova natureza.
      const equipment = await newCategory(ctx, "REC.EQUIP", "Receita de equipamentos", "income")
      await setCharges(ctx, { salesCategoryId: equipment })
      const next = await seedReceivable(ctx, 15000, "2026-03-11")
      assert.equal((await ctx.as("user").get(`/api/v1/receivables/${next.receivable}`)).json().data.natureId, equipment)

      // O operador altera a natureza do título; natureza de despesa num título a receber é recusada.
      const services = await newCategory(ctx, "REC.SERV", "Receita de serviços", "income")
      const expense = await newCategory(ctx, "DESP.X", "Despesa qualquer", "expense")
      const url = `/api/v1/receivables/${receivable}/classification`
      const input = { natureId: services, costCenterId: null, competenceOn: "2026-03-10" }
      const revision = Number(sale.data.revision)
      assert.equal((await ctx.as("anonymous").put(url, { body: input, revision })).statusCode, 401)
      assert.equal((await ctx.as("denied").put(url, { body: input, revision })).statusCode, 403)
      assert.equal((await ctx.as("user").put(url, { body: { ...input, natureId: "x" }, revision })).statusCode, 422)
      assert.equal((await ctx.as("user").put(url, { body: { ...input, natureId: expense }, revision })).statusCode, 422)
      assert.equal((await ctx.as("user").put(url, { body: input, revision: revision + 5 })).statusCode, 412)
      const changed = await ctx.as("user").put(url, { body: input, revision })
      assert.equal(changed.statusCode, 200, changed.body)
      assert.equal(changed.json().data.natureId, services)

      // Centro de custo obrigatório por parâmetro: o padrão da empresa entra nos títulos novos.
      const center = await ctx.as("user").post("/api/v1/financial-cost-centers", {
        body: { code: "ADM", name: "Administrativo", status: "active" },
      })
      assert.equal(center.statusCode, 201, center.body)
      const centerId = center.json().data.id
      await setCharges(ctx, { defaultCostCenterId: centerId, requireCostCenter: true })
      const withCenter = await seedReceivable(ctx, 12000, "2026-03-12")
      const created = (await ctx.as("user").get(`/api/v1/receivables/${withCenter.receivable}`)).json().data
      assert.equal(created.costCenterId, centerId)

      // Lançamento manual em Caixas e bancos: natureza padrão quando omitida e a escolhida quando informada.
      const account = await bankAccount(ctx, "777")
      const manual = { accountId: account, direction: "debit", amount: "12.00", occurredOn: "2026-03-12", description: "Taxa" }
      const plain = await ctx.as("user").post("/api/v1/financial-account-entries", { body: manual })
      assert.equal(plain.statusCode, 201, plain.body)
      assert.ok(plain.json().data.categoryId)
      assert.equal(plain.json().data.categoryName, "Movimentação de conta • saída")
      const chosen = await ctx.as("user").post("/api/v1/financial-account-entries", {
        body: { ...manual, categoryId: expense },
      })
      assert.equal(chosen.statusCode, 201, chosen.body)
      assert.equal(chosen.json().data.categoryId, expense)
      for (const row of await titles()) assert.ok(row.category_id, "título sem natureza: " + row.id)
    })

    await t.test("FI8 • A ficha do cliente soma exatamente os títulos e pedidos listados", async () => {
      await setCharges(ctx, { interestMonthlyBps: 0, penaltyBps: 0 })
      const party = await newParty(ctx, "Cliente da ficha")
      const account = await bankAccount(ctx, "888")
      const overdue = await seedReceivable(ctx, 40000, "2026-01-05", "completed", party)
      const partial = await seedReceivable(ctx, 30000, "2099-01-05", "completed", party)
      const settled = await seedReceivable(ctx, 10000, "2026-02-05", "completed", party)
      const pay = async (id: string, amount: string, revision = 1) => {
        const done = await ctx.as("user").post(`/api/v1/receivables/${id}/payments`, {
          revision,
          body: { amount, method: "cash", reference: "Ficha", occurredOn: "2026-02-10", financialAccountId: account },
        })
        assert.equal(done.statusCode, 200, done.body)
      }
      await pay(partial.receivable, "120.00")
      await pay(settled.receivable, "100.00")
      // Dois pedidos aceitos ainda não faturados, sem títulos.
      for (const cents of [25000, 17550])
        await ctx.seed.query(
          "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente da ficha','04252011000110','2099-03-01',$4,'accepted')",
          [randomUUID(), ctx.tenant, party, cents],
        )
      const url = "/api/v1/finance/partner"
      assert.equal((await ctx.as("anonymous").get(url, { query: { partyId: party } })).statusCode, 401)
      assert.equal((await ctx.as("denied").get(url, { query: { partyId: party } })).statusCode, 403)
      assert.equal((await ctx.as("outsider").get(url, { query: { partyId: party } })).statusCode, 403)
      assert.equal((await ctx.as("user").get(url, { query: { partyId: "x" } })).statusCode, 422)
      assert.equal((await ctx.as("user").get(url, { query: { partyId: randomUUID() } })).statusCode, 404)
      const ficha = await ctx.as("user").get(url, { query: { partyId: party } })
      assert.equal(ficha.statusCode, 200, ficha.body)
      const position = ficha.json().position
      const listed = await ctx.as("user").get("/api/v1/finance/portfolio", { query: { partyId: party, limit: 250 } })
      assert.equal(listed.statusCode, 200, listed.body)
      const rows = listed.json().rows as { side: string; outstanding: string; dueDate: string; id: string }[]
      assert.deepEqual(rows.map((r) => r.id).sort(), [overdue.receivable, partial.receivable, settled.receivable].sort())
      const cents = (v: string) => BigInt(v.replace(".", ""))
      const sum = (values: string[]) => values.reduce((a, v) => a + cents(v), 0n)
      const receivable = sum(rows.filter((r) => r.side === "receivable").map((r) => r.outstanding))
      assert.equal(cents(position.receivable), receivable, "saldo a receber = soma dos títulos listados")
      assert.equal(position.receivable, "580.00", "R$ 400 vencidos + R$ 180 restantes")
      const asOf = position.asOf as string
      assert.equal(
        cents(position.overdueReceivable),
        sum(rows.filter((r) => r.side === "receivable" && r.dueDate < asOf).map((r) => r.outstanding)),
      )
      assert.equal(position.overdueReceivable, "400.00")
      const orders = position.orders as { amount: string }[]
      assert.equal(orders.length, 2)
      assert.equal(cents(position.unbilled), sum(orders.map((o) => o.amount)), "não faturado = soma dos pedidos listados")
      assert.equal(position.unbilled, "425.50")
    })

    await t.test("FI3 • O saldo projetado do último dia = saldo atual + a receber − a pagar do período", async () => {
      const account = await bankAccount(ctx, "999")
      const seeded = await ctx.as("user").post("/api/v1/financial-account-entries", {
        body: { accountId: account, direction: "credit", amount: "1000.00", occurredOn: "2026-01-02", description: "Saldo inicial" },
      })
      assert.equal(seeded.statusCode, 201, seeded.body)
      const flowBefore = await ctx.as("user").get("/api/v1/finance/cashflow", {
        query: { from: "2099-01-01", to: "2099-01-10", interval: "day" },
      })
      assert.equal(flowBefore.statusCode, 200, flowBefore.body)
      const base = flowBefore.json().data as { projected: string; opening: string }[]
      const baseLast = BigInt(base.at(-1)!.projected.replace(".", ""))
      await seedReceivable(ctx, 50000, "2099-01-08")
      await seedPayable(ctx, 12000, "2099-01-09")
      const url = "/api/v1/finance/cashflow"
      const query = { from: "2099-01-01", to: "2099-01-10", interval: "day" }
      assert.equal((await ctx.as("anonymous").get(url, { query })).statusCode, 401)
      assert.equal((await ctx.as("denied").get(url, { query })).statusCode, 403)
      assert.equal((await ctx.as("user").get(url, { query: { ...query, from: "2099-02-01" } })).statusCode, 422)
      assert.equal((await ctx.as("user").get(url, { query: { ...query, interval: "year" } })).statusCode, 422)
      const flow = await ctx.as("user").get(url, { query })
      assert.equal(flow.statusCode, 200, flow.body)
      const days = flow.json().data as { date: string; forecastIn: string; forecastOut: string; projected: string }[]
      assert.equal(days.length, 10)
      const delta = BigInt(days.at(-1)!.projected.replace(".", "")) - baseLast
      assert.equal(delta, 50000n - 12000n, "projetado = saldo + a receber − a pagar")
      assert.equal(days.find((d) => d.date === "2099-01-08")!.forecastIn, "500.00")
      assert.equal(days.find((d) => d.date === "2099-01-09")!.forecastOut, "120.00")
    })

    await t.test("FI4 • Extrato importado concilia automaticamente os lançamentos com mesmo valor e data, e mostra os pendentes", async () => {
      const account = await bankAccount(ctx, "55555")
      const post = (body: object) => ctx.as("user").post("/api/v1/financial-account-entries", { body })
      for (const amount of ["100.00", "30.00"])
        assert.equal(
          (await post({ accountId: account, direction: "credit", amount, occurredOn: "2026-01-30", description: "Lançamento " + amount })).statusCode,
          201,
        )
      const line = (fit: string, amount: string) =>
        `<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260130<TRNAMT>${amount}<FITID>${fit}<NAME>Crédito ${fit}</STMTTRN>`
      const ofx = (lines: string) =>
        `<OFX><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>364<ACCTID>55555</BANKACCTFROM><BANKTRANLIST><DTSTART>20260130<DTEND>20260131${lines}</BANKTRANLIST><LEDGERBAL><BALAMT>130.00<DTASOF>20260131</LEDGERBAL></STMTRS></OFX>`
      const content = ofx(line("F1", "100.00") + line("F2", "30.00") + line("F3", "77.00"))
      const url = "/api/v1/finance-treasury/import-ofx"
      const body = { accountId: account, content, autoMatch: true }
      assert.equal((await ctx.as("anonymous").post(url, { body })).statusCode, 401)
      assert.equal((await ctx.as("denied").post(url, { body })).statusCode, 403)
      assert.equal((await ctx.as("user").post(url, { body: { accountId: account, content: "curto" } })).statusCode, 422)
      assert.equal(
        (await ctx.as("user").post(url, { body: { ...body, accountId: await bankAccount(ctx, "00001") } })).statusCode,
        409,
        "extrato de outra conta bancária",
      )
      const imported = await ctx.as("user").post(url, { body })
      assert.equal(imported.statusCode, 201, imported.body)
      assert.equal(imported.json().data.imported, 3)
      assert.equal(imported.json().data.matched, 2, "valor e data iguais conciliam sozinhos")
      const again = await ctx.as("user").post(url, { body })
      assert.equal(again.json().data.duplicate, true, "reimportar preserva os registros")
      const view = await ctx.as("user").get("/api/v1/finance-treasury/reconciliation", { query: { accountId: account } })
      assert.equal(view.statusCode, 200, view.body)
      const lines = view.json().data.lines as { state: string; cents: string }[]
      const pending = lines.filter((l) => l.state === "pending")
      assert.deepEqual(pending.map((l) => l.cents), ["7700"], "a linha sem correspondência fica pendente")
      assert.equal(lines.filter((l) => l.state === "matched").length, 2)
    })
  } finally {
    await ctx.close()
  }
})
