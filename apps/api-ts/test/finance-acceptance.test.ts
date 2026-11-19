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
  "finance.commissions.read",
  "finance.collections.read",
  "finance.collections.manage",
  "platform.company.manage",
]

async function seedReceivable(ctx: TestContext, cents: number, dueDate: string, orderStatus = "completed") {
  const order = randomUUID(),
    receivable = randomUUID()
  await ctx.seed.query(
    "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','52998224725',$4,$5,$6)",
    [order, ctx.tenant, await customer(ctx), dueDate, cents, orderStatus],
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
async function bankAccount(ctx: TestContext, accountNumber = "12345") {
  const id = randomUUID()
  await ctx.seed.query(
    "INSERT INTO financial_accounts(id,tenant_id,code,name,status,revision,account_type,account_number) VALUES($1,$2,$3,'Banco piloto','active',1,'bank',$4)",
    [id, ctx.tenant, "BANCO" + accountNumber, accountNumber],
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
  } finally {
    await ctx.close()
  }
})
