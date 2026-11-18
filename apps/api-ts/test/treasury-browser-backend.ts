import { createHmac, randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { Pool } from "pg"
import { buildApp } from "../src/app.js"
import { PgClientAdapter } from "../src/platform/database.js"

// Spawned via IPC by the Playwright acceptance test; no external network traffic.
async function run() {
  if (!process.send || !process.env.API_TS_TEST_ADMIN_URL) throw Error("Disposable test database and IPC required")
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL)
  const suffix = randomUUID().replaceAll("-", ""),
    db = "treasury_browser_" + suffix,
    role = "treasury_browser_role_" + suffix
  const admin = new Pool({ connectionString: url.toString() })
  await admin.query("CREATE DATABASE " + db)
  url.pathname = "/" + db
  const seed = new Pool({ connectionString: url.toString() }),
    application = new Pool({ connectionString: url.toString() })
  const tenant = randomUUID(),
    account = randomUUID(),
    party = randomUUID(),
    subject = "treasury-browser",
    access = "treasury-browser-token"
  const webhookKey = "local-acceptance-hmac-secret",
    merchantToken = "local-merchant-access-token",
    paymentId = "8830391"
  const browserOrigin = "http://127.0.0.1:33247",
    nativeFetch = globalThis.fetch
  let charged = 0,
    approved = false,
    reference = ""
  const payment = () => ({
    id: paymentId,
    collector_id: 77,
    live_mode: false,
    status: approved ? "approved" : "pending",
    payment_method_id: "pix",
    external_reference: reference,
    currency_id: "BRL",
    transaction_amount: 100,
    date_approved: approved ? new Date().toISOString() : null,
    transaction_details: { net_received_amount: approved ? 98 : 0 },
    point_of_interaction: { transaction_data: { qr_code: "TESTE-PIX-100" } },
  })
  const provider = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json")
    const reply = (status: number, body: object) => {
      res.writeHead(status).end(JSON.stringify(body))
    }
    if (req.url === "/userinfo") {
      if (req.headers.authorization === "Bearer " + access)
        reply(200, { sub: subject, email: "tesouraria@example.test" })
      else reply(401, {})
      return
    }
    if (req.headers.authorization !== "Bearer " + merchantToken) {
      reply(401, {})
      return
    }
    if (req.url === "/users/me") {
      reply(200, { id: 77, site_id: "MLB", tags: ["test_user"] })
      return
    }
    if (req.url?.startsWith("/v1/payments/search?")) {
      reply(200, { results: reference ? [payment()] : [] })
      return
    }
    if (req.url === "/v1/payments" && req.method === "POST") {
      const parts: Buffer[] = []
      for await (const chunk of req) parts.push(Buffer.from(chunk))
      const input = JSON.parse(Buffer.concat(parts).toString())
      if (
        req.headers["x-idempotency-key"] !== input.external_reference ||
        input.transaction_amount !== 100 ||
        input.payment_method_id !== "pix" ||
        input.payer.email !== "test_user_br@testuser.com"
      ) {
        reply(422, {})
        return
      }
      if (reference && reference !== input.external_reference) {
        reply(409, {})
        return
      }
      if (!reference) charged++
      reference = input.external_reference
      reply(201, payment())
      return
    }
    if (req.url === "/v1/payments/" + paymentId && reference) {
      reply(200, payment())
      return
    }
    reply(404, {})
  })
  const app = buildApp({
    pool: {
      async connect() {
        const client = await application.connect()
        await client.query("SET ROLE " + role)
        return new PgClientAdapter(client)
      },
    },
    userinfoUrl: "http://127.0.0.1:33250/userinfo",
  })
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    globalThis.fetch = nativeFetch
    await app.close()
    provider.closeAllConnections()
    if (provider.listening) await new Promise<void>((resolve) => provider.close(() => resolve()))
    await application.end()
    await seed.end()
    try {
      await admin.query("DROP DATABASE " + db)
      await admin.query("DROP ROLE IF EXISTS " + role)
    } finally {
      await admin.end()
    }
    if (process.connected) process.disconnect()
  }
  process.once("disconnect", () => {
    void stop()
  })
  try {
    const dir = new URL("../../../migrations/", import.meta.url)
    for (const f of (await readdir(dir)).filter((x) => x.endsWith(".sql")).sort())
      await seed.query(await readFile(new URL(f, dir), "utf8"))
    await seed.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS")
    await seed.query("GRANT USAGE ON SCHEMA public TO " + role)
    await seed.query("GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO " + role)
    await seed.query("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO " + role)
    const member = randomUUID(),
      identity = randomUUID(),
      policy = randomUUID()
    await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa piloto','04252011000110')", [tenant])
    await seed.query(
      "INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,$2,'tesouraria@example.test','Tesouraria')",
      [identity, subject],
    )
    await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [
      member,
      tenant,
      identity,
    ])
    await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'financeiro','Financeiro')", [
      policy,
      tenant,
    ])
    await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [member, policy])
    await seed.query(
      "INSERT INTO role_permissions(role_id,permission_code) SELECT $1,code FROM permissions WHERE code LIKE 'finance.%' OR code='catalog.parties.read'",
      [policy],
    )
    await seed.query(
      "INSERT INTO financial_accounts(id,tenant_id,code,name,status,account_type,bank,account_number,revision) VALUES($1,$2,'PILOTO','Conta piloto','active','bank','364','12345',1)",
      [account, tenant],
    )
    await seed.query(
      "INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status,email) VALUES($1,$2,'fisica','Cliente de teste','52998224725',true,false,'active','test_user_br@testuser.com')",
      [party, tenant],
    )
    const orders = (
      await seed.query(
        "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) SELECT gen_random_uuid(),$1,$2,'Cliente de teste','52998224725','2027-03-01',val,'completed' FROM unnest(ARRAY[6000,4000]) val RETURNING id,amount_cents",
        [tenant, party],
      )
    ).rows
    for (const o of orders)
      await seed.query(
        "INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES(gen_random_uuid(),$1,$2,'Cliente de teste','2027-03-01',$3,'open')",
        [tenant, o.id, o.amount_cents],
      )
    for (const key of ["FINANCE_MP_CONNECTIONS", "FINANCE_MP_ENABLE_PRODUCTION"]) delete process.env[key]
    Object.assign(process.env, {
      FINANCE_MP_SANDBOX_TENANT_ID: tenant,
      FINANCE_MP_SANDBOX_ACCOUNT_ID: account,
      FINANCE_MP_SANDBOX_COLLECTOR_ID: "77",
      FINANCE_MP_SANDBOX_SUBJECT: subject,
      FINANCE_MP_SANDBOX_ACCESS_TOKEN: merchantToken,
      FINANCE_MP_SANDBOX_WEBHOOK_SECRET: webhookKey,
    })
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject)
      provider.listen(33250, "127.0.0.1", resolve)
    })
    globalThis.fetch = (input, init) => {
      const uri = new URL(String(input))
      if (["api.mercadopago.com", "api.mercadolibre.com"].includes(uri.hostname))
        return nativeFetch("http://127.0.0.1:33250" + uri.pathname + uri.search, init)
      if (uri.hostname !== "127.0.0.1") throw Error("External network is disabled for the treasury browser test")
      return nativeFetch(input, init)
    }
    await app.listen({ host: "127.0.0.1", port: 33249 })
    process.on("message", async (msg: { command: string }) => {
      try {
        if (msg.command === "approve") {
          approved = true
          const reqId = randomUUID(),
            ts = Math.floor(Date.now() / 1000),
            mac = createHmac("sha256", webhookKey)
              .update("id:" + paymentId + ";request-id:" + reqId + ";ts:" + ts + ";")
              .digest("hex")
          const rsp = await nativeFetch(
            browserOrigin + "/api/integrations/finance/mercadopago/" + tenant + "/" + account + "?data.id=" + paymentId,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-signature": "ts=" + ts + ",v1=" + mac,
                "x-request-id": reqId,
              },
              body: JSON.stringify({
                id: "1",
                type: "payment",
                live_mode: false,
                user_id: "77",
                data: { id: paymentId },
              }),
            },
          )
          process.send?.({ status: rsp.status })
        } else if (msg.command === "snapshot") {
          const row = (
            await seed.query(
              `SELECT (SELECT count(*)::int FROM finance_operation_items WHERE tenant_id=$1) items,
            (SELECT count(*)::int FROM receivables WHERE tenant_id=$1 AND status='paid') paid,
            (SELECT count(*)::int FROM receivable_payments WHERE tenant_id=$1) receipts,
            (SELECT count(*)::int FROM finance_bank_matches WHERE tenant_id=$1) matches,
            (SELECT count(*)::int FROM finance_bank_lines WHERE tenant_id=$1 AND state='matched') matched,
            (SELECT sum(CASE WHEN direction='credit' THEN amount_cents ELSE -amount_cents END)::text FROM financial_account_entries WHERE tenant_id=$1 AND account_id=$2) net`,
              [tenant, account],
            )
          ).rows[0]
          process.send?.({ ...row, charged, reference, paymentId })
        } else if (msg.command === "stop") await stop()
      } catch (error) {
        process.send?.({ error: String(error) })
      }
    })
    process.send?.({ ready: true, tenant, account, party, access })
  } catch (error) {
    process.send?.({ error: String(error) })
    await stop()
    throw error
  }
}
void run()
