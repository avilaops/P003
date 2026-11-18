import assert from "node:assert/strict"
import { createHmac, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { FastifyInstance } from "fastify"
import type { Pool } from "pg"

type Fixture = { tenant: string; bank: string; batchId: string; receivable: string }
type RequestBody = {
  external_reference: string
  transaction_amount: number
  date_of_expiration: string
  payment_method_id: string
  payer: { identification: unknown; email: string; address: unknown }
}

export async function verifyBoleto(app: FastifyInstance, seed: Pool, { tenant, bank, batchId, receivable }: Fixture) {
  const issueKey = randomUUID()
  const headers = { authorization: "Bearer batch", "x-tenant-id": tenant, "idempotency-key": issueKey }
  const issue = () =>
    app.inject({
      method: "POST",
      url: "/api/v1/finance-treasury/issue-charge",
      headers,
      payload: { accountId: bank, batchId, receivableIds: [receivable], billingType: "BOLETO" },
    })
  const setAddress = (address: Record<string, unknown>) =>
    seed.query(
      `UPDATE parties SET addresses=$3::jsonb WHERE tenant_id=$1 AND id=(
       SELECT party_id FROM finance_portfolio WHERE tenant_id=$1 AND side='receivable' AND id=$2)`,
      [tenant, receivable, JSON.stringify([address])],
    )
  const address = {
    primary: true,
    postalCode: "01310-100",
    street: "Avenida Paulista",
    number: "100",
    district: "Bela Vista",
    city: "São Paulo",
    state: "SP",
  }
  const paymentId = "88022",
    boletoReference = "991380022",
    barcode = "23791111111111111111111111111111111111111111"
  const ticketUrl = "https://www.mercadopago.com/mlb/payments/ticket/helper?payment_id=" + paymentId
  const posts: RequestBody[] = [],
    postKeys: (string | string[] | undefined)[] = [],
    lookups: (string | null)[] = []
  let approved = false,
    reads = 0,
    bankRequests = 0
  const institution = createServer(async (req, res) => {
    bankRequests++
    res.setHeader("content-type", "application/json")
    const url = new URL(req.url!, "http://localhost")
    if (req.headers.authorization !== "Bearer local-test-token") {
      res.writeHead(401).end("{}")
    } else if (req.method === "GET" && url.pathname === "/users/me") {
      res.end(JSON.stringify({ id: 44, site_id: "MLB", tags: ["test_user"] }))
    } else if (req.method === "GET" && url.pathname === "/v1/payments/search") {
      const ref = url.searchParams.get("external_reference")
      lookups.push(ref)
      const results = posts
        .filter((p) => p.external_reference === ref)
        .map((p) => ({
          id: paymentId,
          external_reference: p.external_reference,
        }))
      res.end(JSON.stringify({ results }))
    } else if (req.method === "POST" && url.pathname === "/v1/payments") {
      let body = ""
      for await (const chunk of req) body += chunk
      posts.push(JSON.parse(body))
      postKeys.push(req.headers["x-idempotency-key"])
      // The institution created the boleto but did not confirm it to the ERP.
      res.writeHead(503).end("{}")
    } else if (req.method === "GET" && url.pathname === "/v1/payments/" + paymentId && posts[0]) {
      reads++
      res.end(
        JSON.stringify({
          id: paymentId,
          external_reference: posts[0].external_reference,
          collector_id: 44,
          live_mode: false,
          currency_id: "BRL",
          transaction_amount: 60.2,
          payment_method_id: "bolbradesco",
          status: approved ? "approved" : "pending",
          ...(approved
            ? {
                date_approved: "2028-02-15T12:00:00-03:00",
                transaction_details: { net_received_amount: 60.2 },
              }
            : {
                transaction_details: { payment_method_reference_id: boletoReference, external_resource_url: ticketUrl },
                barcode: { content: barcode },
              }),
        }),
      )
    } else res.writeHead(404).end("{}")
  })
  const originalFetch = globalThis.fetch
  await new Promise<void>((resolve) => institution.listen(0, "127.0.0.1", resolve))
  try {
    const local = "http://127.0.0.1:" + (institution.address() as AddressInfo).port
    globalThis.fetch = (input, options) => {
      const url = new URL(String(input))
      assert.ok(url.href === "https://api.mercadolibre.com/users/me" || url.origin === "https://api.mercadopago.com")
      assert.equal(options?.redirect, "error")
      return originalFetch(local + url.pathname + url.search, options)
    }
    const refused = await issue()
    assert.equal(refused.statusCode, 409, refused.body)
    assert.match(refused.body, /endereço completo do pagador/)
    await setAddress({ ...address, district: "" })
    const incomplete = await issue()
    assert.equal(incomplete.statusCode, 409, incomplete.body)
    assert.equal(bankRequests, 0)
    assert.equal(
      (
        await seed.query("SELECT id FROM finance_collection_charges WHERE tenant_id=$1 AND issue_key=$2", [
          tenant,
          issueKey,
        ])
      ).rowCount,
      0,
    )

    await setAddress(address)
    const uncertain = await issue()
    assert.equal(uncertain.statusCode, 503, uncertain.body)
    const row = (
      await seed.query(
        "SELECT id,state,provider_id,batch_id,due_on::text,amount_cents::text FROM finance_collection_charges WHERE tenant_id=$1 AND issue_key=$2",
        [tenant, issueKey],
      )
    ).rows[0]
    const chargeId: string = row.id
    assert.deepEqual(row, {
      id: chargeId,
      state: "prepared",
      provider_id: null,
      batch_id: batchId,
      due_on: "2028-02-15",
      amount_cents: "6020",
    })
    assert.equal(posts.length, 1)
    const body = posts[0]!
    assert.equal(body.external_reference, chargeId)
    assert.equal(postKeys[0], chargeId)
    assert.equal(body.transaction_amount, 60.2)
    assert.equal(body.date_of_expiration, "2028-02-15T23:59:59.000-03:00")
    assert.equal(body.payment_method_id, "bolbradesco")
    assert.deepEqual(body.payer.identification, { type: "CPF", number: "11144477735" })
    assert.equal(body.payer.email, "test_user_br@testuser.com")
    assert.deepEqual(body.payer.address, {
      zip_code: "01310100",
      street_name: "Avenida Paulista",
      street_number: "100",
      neighborhood: "Bela Vista",
      city: "São Paulo",
      federal_unit: "SP",
    })

    const recovered = await issue()
    assert.equal(recovered.statusCode, 201, recovered.body)
    const instructions = { barcode, boletoReference, qrCode: null, ticketUrl }
    assert.deepEqual(recovered.json().data, { chargeId, state: "issued", instructions, reason: null })
    const replay = await issue()
    assert.equal(replay.statusCode, 200, replay.body)
    assert.deepEqual(replay.json().data, { chargeId, state: "issued", instructions })
    assert.deepEqual(lookups, [chargeId, chargeId])
    assert.equal(posts.length, 1)
    assert.equal(reads, 1)

    approved = true
    const confirm = (eventId: string) => {
      const requestId = randomUUID(),
        ts = Math.floor(Date.now() / 1000)
      const signature = createHmac("sha256", "local-test-webhook")
        .update("id:" + paymentId + ";request-id:" + requestId + ";ts:" + ts + ";")
        .digest("hex")
      return app.inject({
        method: "POST",
        url: "/integrations/finance/mercadopago/" + tenant + "/" + bank + "?data.id=" + paymentId,
        headers: { "x-request-id": requestId, "x-signature": "ts=" + ts + ",v1=" + signature },
        payload: { id: eventId, type: "payment", live_mode: false, user_id: "44", data: { id: paymentId } },
      })
    }
    for (const eventId of ["1234", "1234", "5678"]) {
      const result = await confirm(eventId)
      assert.equal(result.statusCode, 200, result.body)
      assert.equal(result.json().state, "paid")
    }
    const settled = await app.inject({ method: "GET", url: "/api/v1/finance-treasury/collections", headers })
    assert.equal(settled.statusCode, 200, settled.body)
    const boleto = settled.json().data.charges.find((c: { id: string }) => c.id === chargeId)
    assert.deepEqual(
      [boleto.method, boleto.state, boleto.providerId, boleto.dueOn, boleto.instructions],
      ["BOLETO", "paid", paymentId, "2028-02-15", instructions],
    )
    assert.equal(reads, 4)
    const history = (
      await seed.query(
        `SELECT r.status, p.amount_cents::text, p.reference, p.occurred_on::text, a.amount_cents::text AS credit,
        a.account_id, a.direction, i.payment_id=p.id AS linked
       FROM receivables r JOIN receivable_payments p ON (p.tenant_id,p.receivable_id)=(r.tenant_id,r.id)
       JOIN finance_collection_items i ON (i.tenant_id,i.receivable_id)=(r.tenant_id,r.id)
       JOIN financial_account_entries a ON (a.tenant_id,a.id)=(p.tenant_id,p.account_entry_id)
       WHERE r.tenant_id=$1 AND r.id=$2 AND i.charge_id=$3`,
        [tenant, receivable, chargeId],
      )
    ).rows
    assert.deepEqual(history, [
      {
        status: "paid",
        amount_cents: "6020",
        reference: "Mercado Pago • " + paymentId,
        occurred_on: "2028-02-15",
        credit: "6020",
        account_id: bank,
        direction: "credit",
        linked: true,
      },
    ])
    const counts = (
      await seed.query(
        `SELECT (SELECT count(*)::int FROM financial_account_entries WHERE tenant_id=$1 AND account_id=$2 AND reference=$3) entries,
              (SELECT count(*)::int FROM finance_collection_events WHERE tenant_id=$1 AND charge_id=$4 AND source='webhook') events`,
        [tenant, bank, "Mercado Pago • " + paymentId, chargeId],
      )
    ).rows[0]
    assert.deepEqual(counts, { entries: 1, events: 2 })
  } finally {
    globalThis.fetch = originalFetch
    await new Promise<void>((resolve, reject) => institution.close((err) => (err ? reject(err) : resolve())))
  }
}
