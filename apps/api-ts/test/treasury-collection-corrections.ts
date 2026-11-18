import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mock } from "node:test"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"
import { bankReturn, testAgreement } from "./fixtures/santander-return.js"

function termsReturn(
  content: string,
  sequence: number,
  day: string,
  nominal: number,
  charges: number,
  discount: number,
  creditDay = day,
) {
  const date = day.slice(8) + day.slice(5, 7) + day.slice(0, 4)
  const creditDate = creditDay.slice(8) + creditDay.slice(5, 7) + creditDay.slice(0, 4)
  const field = (row: string, at: number, value: string) =>
    row.slice(0, at - 1) + value + row.slice(at - 1 + value.length)
  const amount = (value: number) => String(value).padStart(15, "0")
  const paid = nominal + charges - discount
  const lines = bankReturn(content, sequence, [{ index: 0, code: "06" }]).split("\r\n")
  lines[0] = field(lines[0]!, 144, date)
  lines[1] = field(lines[1]!, 192, date)
  const u = lines.findIndex((line) => line[13] === "U")
  lines[u] = field(
    field(field(lines[u]!, 18, amount(charges) + amount(discount)), 78, amount(paid) + amount(paid)),
    138,
    date + creditDate,
  )
  return lines.join("\r\n")
}

export async function verifyCollectionCorrections(
  app: FastifyInstance,
  seed: Pool,
  tenant: string,
  accountId: string,
  batchId: string,
  originalFile: string,
) {
  const headers = { authorization: "Bearer batch", "x-tenant-id": tenant },
    root = "/api/v1/finance-treasury/"
  const post = async (path: string, body: object) => {
    const res = await app.inject({
      method: "POST",
      url: root + path,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: body,
    })
    assert.equal(res.statusCode, 201, res.body)
    return res.json().data
  }
  const get = async (path: string) => {
    const res = await app.inject({ method: "GET", url: path, headers })
    assert.equal(res.statusCode, 200, res.body)
    return res.json().data
  }
  const detail = async () => get(root + "batches?batchId=" + batchId)
  const original = (await detail()).items.find((item: { state: string }) => item.state === "paid")
  assert.ok(original)
  const titlePath = "/api/v1/receivables/" + original.id
  const originalRecord = (
    await seed.query(
      `SELECT p.occurred_on::text AS day,i.fee_entry_id
    FROM finance_collection_remittance_items i JOIN receivable_payments p ON (p.tenant_id,p.id)=(i.tenant_id,i.payment_id)
    WHERE i.tenant_id=$1 AND i.batch_id=$2 AND i.receivable_id=$3`,
      [tenant, batchId, original.id],
    )
  ).rows[0]!
  const reversal = {
    paymentId: original.paymentId,
    reason: "Correção local apoiada em documento do banco",
    occurredOn: originalRecord.day,
  }
  const title = await get(titlePath)
  const reverse = (key: string, occurredOn = reversal.occurredOn) =>
    app.inject({
      method: "POST",
      url: titlePath + "/reverse-payment",
      headers: { ...headers, "idempotency-key": key, "if-match": '"' + title.revision + '"' },
      payload: { ...reversal, occurredOn },
    })
  const permissions = (
    await seed.query(
      `DELETE FROM role_permissions rp USING roles r WHERE rp.role_id=r.id AND r.tenant_id=$1
    AND rp.permission_code='finance.collections.manage' RETURNING rp.role_id`,
      [tenant],
    )
  ).rows
  try {
    assert.equal((await reverse(randomUUID())).statusCode, 403)
    assert.equal((await get(titlePath)).status, "paid")
  } finally {
    for (const permission of permissions)
      await seed.query(
        "INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'finance.collections.manage')",
        [permission.role_id],
      )
  }
  const key = randomUUID()
  const future = new Date(Date.parse(originalRecord.day + "T00:00:00Z") + 86400000).toISOString().slice(0, 10)
  assert.equal((await reverse(randomUUID(), future)).statusCode, 409)
  const corrected = await reverse(key)
  assert.equal(corrected.statusCode, 200, corrected.body)
  assert.deepEqual((await reverse(key)).json(), corrected.json())
  const originalAfter = (await detail()).items.find((item: { id: string }) => item.id === original.id)
  assert.equal(originalAfter.state, "reversed")
  assert.equal(originalAfter.paymentId, original.paymentId)
  assert.ok(originalAfter.reversedByPaymentId)
  assert.equal(originalAfter.reversalReason, reversal.reason)
  assert.equal((await get(titlePath)).status, "open")
  const importFile = (content: string) => post("cnab-return", { accountId, content })
  assert.equal(
    (await importFile(bankReturn(originalFile, 901, [{ index: 0, code: "06", fee: 200 }]))).outcomes[0].state,
    "duplicate",
  )
  assert.equal((await get(titlePath)).status, "open")
  assert.equal(
    (await get(root + "cnab-remittance?" + new URLSearchParams({ accountId, batchId }))).content,
    originalFile,
  )
  const entries = (
    await seed.query(
      `SELECT direction,amount_cents::text AS cents,id FROM financial_account_entries
    WHERE tenant_id=$1 AND account_id=$2 ORDER BY direction,amount_cents`,
      [tenant, accountId],
    )
  ).rows
  assert.deepEqual(
    entries.map((e) => [e.direction, e.cents]),
    [
      ["credit", original.cents],
      ["debit", "200"],
      ["debit", original.cents],
    ],
  )
  assert.equal(entries[1]!.id, originalRecord.fee_entry_id)
  assert.equal(
    (
      await seed.query(
        `SELECT count(*)::int AS n FROM accounting_events WHERE tenant_id=$1 AND source_id=$2 AND event_type='collection.fee'`,
        [tenant, originalRecord.fee_entry_id],
      )
    ).rows[0]!.n,
    1,
  )

  const profile = { accountId, ...testAgreement }
  await post("cnab-profile", { ...profile, fineBps: 200 })
  const next = await post("prepare-batch", {
    accountId,
    reference: "Correção após estorno local",
    items: [{ id: original.id, cents: original.cents, dueOn: original.dueOn }],
  })
  const selection = { accountId, batchId: next.id }
  await post("cnab-remittance", selection)
  const content = (await get(root + "cnab-remittance?" + new URLSearchParams(selection))).content
  assert.notEqual(content, originalFile)
  await post("cnab-profile", { ...profile, fineBps: 0, interestMonthlyBps: 100 })
  const nominal = Number(original.cents),
    fine = (nominal * 2) / 100
  const late = new Date(Date.parse(original.dueOn + "T00:00:00Z") + 86400000).toISOString().slice(0, 10)
  const futureCredit = await importFile(termsReturn(content, 906, originalRecord.day, nominal, 0, 0, future))
  assert.equal(futureCredit.outcomes[0].state, "review")
  assert.match(futureCredit.outcomes[0].reason, /data efetiva/)
  const pending = await importFile(termsReturn(content, 905, late, nominal, fine, 0))
  assert.equal(pending.outcomes[0].state, "review")
  assert.match(pending.outcomes[0].reason, /data efetiva/)
  assert.equal((await get(titlePath)).status, "open")

  // Advance only the application's date so the same bank evidence can be checked on its effective day.
  mock.timers.enable({ apis: ["Date"], now: Date.parse(late + "T12:00:00-03:00") })
  try {
    for (const [sequence, event] of [
      [902, termsReturn(content, 902, original.dueOn, nominal, fine, 0)],
      [903, termsReturn(content, 903, late, nominal, fine + 1, 0)],
      [904, termsReturn(content, 904, late, nominal, fine, 100)],
    ] as const) {
      const result = await importFile(event)
      assert.equal(result.sequence, sequence)
      assert.equal(result.outcomes[0].state, "review")
      assert.equal((await get(titlePath)).status, "open")
    }
    const accepted = await post("cnab-review", {
      accountId,
      returnId: pending.id,
      ordinal: 1,
      reason: "Conferência na data do crédito",
    })
    assert.equal(accepted.state, "paid")
    assert.deepEqual(
      [
        pending.outcomes[0].nominalCents,
        pending.outcomes[0].paidCents,
        pending.outcomes[0].netCents,
        pending.outcomes[0].feeCents,
        pending.outcomes[0].occurredOn,
        pending.outcomes[0].creditOn,
      ],
      [String(nominal), String(nominal + fine), String(nominal + fine), "0", late, late],
    )
  } finally {
    mock.timers.reset()
  }
}
