import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { databaseTestOptions, withTestContext } from "./support/test-context.js"

const url = "/api/v1/purchase-overview"

test("GET /api/v1/purchase-overview [sucesso] indicadores reais: abertos, aguardando recebimento, atrasados e a pagar em 7 dias", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["purchasing.orders.read"] }, async ctx => {
    const supplier = randomUUID()
    await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'juridica','Fornecedor','04252011000110',false,true,'active')", [supplier, ctx.tenant])
    const insert = (status: string, due: string, cents: number, tenant = ctx.tenant) =>
      ctx.seed.query("INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Fornecedor','04252011000110',$4,$5,$6)", [randomUUID(), tenant, supplier, due, cents, status])
    await insert("confirmed", "2020-01-01", 100000) // atrasado
    await insert("awaiting_approval", "2099-01-01", 50000)
    await insert("received", "2020-01-01", 70000) // não conta
    const body = (await ctx.as("user").get(url)).json().data
    assert.deepEqual(body.openOrders, { count: 2, amount: "1500.00" })
    assert.equal(body.awaitingReceipt, 1)
    assert.equal(body.lateReceipts, 1)
    assert.equal(body.awaitingApproval, 1)
    assert.equal(body.notesWithoutOrder, 0)
  })
})

test("GET /api/v1/purchase-overview [negado] sem permissão 403, sem token 401, outra empresa 403", databaseTestOptions, async () => {
  await withTestContext({}, async ctx => {
    assert.equal((await ctx.as("user").get(url)).statusCode, 403)
    assert.equal((await ctx.as("anonymous").get(url)).statusCode, 401)
    assert.equal((await ctx.as("outsider").get(url)).statusCode, 403)
  })
})
