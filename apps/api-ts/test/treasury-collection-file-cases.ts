import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"

import { bankReturn, testAgreement as profile } from "./fixtures/santander-return.js"
import { verifyCollectionCorrections } from "./treasury-collection-corrections.js"

export async function verifyCollectionFiles(app: FastifyInstance, seed: Pool, tenant: string, otherTenant: string) {
  const accountId = randomUUID()
  const request = (path: string, body?: object, company = tenant, key = randomUUID()) =>
    app.inject({
      method: body ? "POST" : "GET",
      url: "/api/v1/finance-treasury/" + path,
      headers: { authorization: "Bearer batch", "x-tenant-id": company, "idempotency-key": key },
      ...(body ? { payload: body } : {}),
    })
  async function post(path: string, payload: object) {
    const result = await request(path, payload)
    assert.equal(result.statusCode, 201, result.body)
    return result.json().data
  }

  await seed.query(
    `INSERT INTO financial_accounts
    (id,tenant_id,code,name,status,account_type,bank,branch,account_number,revision)
    VALUES($1,$2,'CNAB','Conta local de teste','active','bank','033','4321-0','23456-1',1)`,
    [accountId, tenant],
  )
  const settings = { accountId, ...profile }
  const address = {
    primary: true,
    street: "Rua Exemplo",
    number: "42",
    postalCode: "01310-100",
    city: "São Paulo",
    state: "SP",
    district: "Centro",
  }
  const parties = (
    await seed.query(
      `UPDATE parties SET addresses=$2 WHERE tenant_id=$1 AND is_customer
    RETURNING id,legal_name,tax_id`,
      [tenant, JSON.stringify([address])],
    )
  ).rows
  assert.equal(parties.length, 2)
  const items: { id: string; cents: string; dueOn: string }[] = []
  for (const [index, party] of parties.entries()) {
    const id = randomUUID(),
      order = randomUUID()
    const cents = index === 0 ? "10000" : "25000"
    const dueOn = new Date(Date.now() + (30 + index) * 86_400_000).toISOString().slice(0, 10)
    await seed.query(
      `INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,amount_cents,due_date,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,'completed')`,
      [order, tenant, party.id, party.legal_name, party.tax_id, cents, dueOn],
    )
    await seed.query(
      `INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status)
      VALUES($1,$2,$3,$4,$5,$6,'open')`,
      [id, tenant, order, party.legal_name, dueOn, cents],
    )
    items.push({ id, cents, dueOn })
  }
  const batch = await post("prepare-batch", { accountId, reference: "Piloto sem transmissão", items })
  const select = { accountId, batchId: batch.id }
  const download = "cnab-remittance?" + new URLSearchParams(select)
  assert.ok((await request("cnab-remittance", select)).statusCode >= 400)
  assert.equal((await request("cnab-profile", settings, otherTenant)).statusCode, 404)
  await post("cnab-profile", settings)
  const generated = await Promise.all([request("cnab-remittance", select), request("cnab-remittance", select)])
  for (const result of generated) assert.equal(result.statusCode, 201, result.body)
  assert.equal((await request(download, undefined, otherTenant)).statusCode, 404)
  const file = await request(download)
  assert.equal(file.statusCode, 200, file.body)
  const { filename, content } = file.json().data as { filename: string; content: string }
  assert.ok(filename && content)
  const rows = content.split("\r\n").filter(Boolean)
  assert.ok(rows.every((row) => Buffer.byteLength(row, "ascii") === 240))
  assert.equal(rows.filter((row) => row[13] === "P").length, 2)
  await post("cnab-remittance", select)
  assert.equal((await request(download)).json().data.content, content)
  assert.equal((await request("cancel-batch", { batchId: batch.id, reason: "Arquivo já emitido" })).statusCode, 409)
  const importFile = (contents: string) => post("cnab-return", { accountId, content: contents })
  const countReceipts = async () =>
    (
      await seed.query(
        "SELECT count(*)::int AS n FROM receivable_payments WHERE tenant_id=$1 AND receivable_id=ANY($2::uuid[])",
        [tenant, items.map((i) => i.id)],
      )
    ).rows[0].n
  const registration = await importFile(
    bankReturn(content, 31, [
      { index: 0, code: "02" },
      { index: 1, code: "03" },
    ]),
  )
  assert.deepEqual(
    registration.outcomes.map((e: { state: string }) => e.state),
    ["registered", "rejected"],
  )
  assert.equal(await countReceipts(), 0)
  const payment = bankReturn(content, 32, [{ index: 0, code: "06", fee: 200 }])
  const wrong = await request("cnab-return", {
    accountId,
    content: payment.replace(profile.beneficiaryCode, "009999999"),
  })
  assert.ok(wrong.statusCode >= 400, wrong.body)
  assert.equal(await countReceipts(), 0)
  const cutoff = rows[0]!.slice(143, 151)
  const throughDate = cutoff.slice(4) + "-" + cutoff.slice(2, 4) + "-" + cutoff.slice(0, 2)
  await seed.query(
    `INSERT INTO finance_account_periods(tenant_id,account_id,id,through_date,closed_by,reason)
    VALUES($1,$2,gen_random_uuid(),$3,'operador de teste','Conferência anterior')`,
    [tenant, accountId, throughDate],
  )
  const paid = await importFile(payment)
  assert.equal(paid.outcomes[0].state, "review")
  assert.equal(await countReceipts(), 0)
  await post("reopen-period", { accountId, throughDate, reason: "Autorizar a correção do período de testes" })
  const review = { accountId, returnId: paid.id, ordinal: 1, reason: "Período reaberto pelo financeiro" }
  assert.equal((await request("cnab-review", review, otherTenant)).statusCode, 404)
  const reviewKeys = [randomUUID(), randomUUID()]
  const reviews = await Promise.all(reviewKeys.map((key) => request("cnab-review", review, tenant, key)))
  assert.deepEqual(reviews.map((result) => result.statusCode).sort(), [201, 409])
  const accepted = reviews.findIndex((result) => result.statusCode === 201)
  const reviewed = reviews[accepted]!
  const retryKey = reviewKeys[accepted]!
  assert.equal(reviewed.statusCode, 201, reviewed.body)
  assert.equal(reviewed.json().data.state, "paid")
  const repeatedReview = await request("cnab-review", review, tenant, retryKey)
  assert.deepEqual(repeatedReview.json(), reviewed.json())
  assert.equal(await countReceipts(), 1)
  assert.equal((await importFile(payment)).id, paid.id)
  assert.equal(
    (await importFile(bankReturn(content, 33, [{ index: 0, code: "06", fee: 200 }]))).outcomes[0].state,
    "duplicate",
  )
  assert.equal(
    (await importFile(bankReturn(content, 34, [{ index: 0, code: "06", fee: 250 }]))).outcomes[0].state,
    "review",
  )
  const corrected = await post("prepare-batch", { accountId, reference: "Reemissão do rejeitado", items: [items[1]] })
  const revised = { accountId, batchId: corrected.id }
  const newFile = await post("cnab-remittance", revised)
  assert.equal(newFile.sequence, 2)
  const revisedOutput = (await request("cnab-remittance?" + new URLSearchParams(revised))).json().data.content
  assert.ok(!rows.filter((row) => row[13] === "P").some((row) => revisedOutput.includes(row.slice(44, 57) + "111")))
  assert.equal((await importFile(bankReturn(content, 35, [{ index: 1, code: "06" }]))).outcomes[0].state, "review")
  const contradictions = await importFile(
    bankReturn(revisedOutput, 36, [
      { index: 0, code: "03" },
      { index: 0, code: "06" },
    ]),
  )
  assert.deepEqual(
    contradictions.outcomes.map((e: { state: string }) => e.state),
    ["review", "review"],
  )
  assert.equal(await countReceipts(), 1)
  const movements = (
    await seed.query(
      `SELECT direction,amount_cents::text FROM financial_account_entries
    WHERE tenant_id=$1 AND account_id=$2 ORDER BY direction`,
      [tenant, accountId],
    )
  ).rows
  assert.deepEqual(movements, [
    { direction: "credit", amount_cents: "10000" },
    { direction: "debit", amount_cents: "200" },
  ])
  const history = await request("cnab-profile?" + new URLSearchParams(select))
  assert.equal(history.statusCode, 200, history.body)
  assert.equal(history.json().data.remittances.length, 1)
  assert.ok(history.json().data.returns.length >= 2)
  await verifyCollectionCorrections(app, seed, tenant, accountId, select.batchId, content)
}
