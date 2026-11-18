import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { Pool } from "pg"
import { buildApp } from "../src/app.js"
import { PgClientAdapter, withTenantTransaction } from "../src/platform/database.js"
import { getCharge, observePayment, reserveCharge } from "../src/modules/finance-treasury/collections.js"
import { verifyBoleto } from "./treasury-boleto-cases.js"

test(
  "borderô multiempresa preserva valores de clientes distintos, reserva, histórico e retorno",
  { skip: !process.env.API_TS_TEST_ADMIN_URL },
  async (t) => {
    const url = new URL(process.env.API_TS_TEST_ADMIN_URL!),
      suffix = randomUUID().replaceAll("-", "")
    const db = "batch_" + suffix,
      role = "batch_role_" + suffix
    const admin = new Pool({ connectionString: url.toString() })
    await admin.query("CREATE DATABASE " + db)
    url.pathname = "/" + db
    const seed = new Pool({ connectionString: url.toString() }),
      connects = new Pool({ connectionString: url.toString() })
    const pool = {
      async connect() {
        const c = await connects.connect()
        await c.query("SET ROLE " + role)
        return new PgClientAdapter(c)
      },
    }
    const subject = "batch-test",
      tenant = randomUUID(),
      other = randomUUID(),
      bank = randomUUID(),
      identity = randomUUID()
    const app = buildApp({
      pool,
      userinfoUrl: "https://auth.example.test/userinfo",
      fetchAuth: async () => Response.json({ sub: subject, email: "usuario@example.test" }),
    })
    const config: Record<string, string> = {
      FINANCE_MP_SANDBOX_TENANT_ID: tenant,
      FINANCE_MP_SANDBOX_ACCOUNT_ID: bank,
      FINANCE_MP_SANDBOX_COLLECTOR_ID: "44",
      FINANCE_MP_SANDBOX_SUBJECT: subject,
      FINANCE_MP_SANDBOX_WEBHOOK_SECRET: "local-test-webhook",
      FINANCE_MP_SANDBOX_ACCESS_TOKEN: "local-test-token",
    }
    const previous = Object.fromEntries(Object.keys(config).map((k) => [k, process.env[k]]))
    const call = (path: string, body?: Record<string, unknown>, key = randomUUID(), company = tenant) =>
      app.inject({
        method: body ? "POST" : "GET",
        url: "/api/v1/finance-treasury/" + path,
        headers: { authorization: "Bearer batch", "x-tenant-id": company, "idempotency-key": key },
        ...(body ? { payload: body } : {}),
      })
    try {
      for (const k of Object.keys(config)) delete process.env[k]
      const dir = new URL("../../../migrations/", import.meta.url)
      for (const name of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort())
        await seed.query(await readFile(new URL(name, dir), "utf8"))
      await seed.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS")
      await seed.query("GRANT USAGE ON SCHEMA public TO " + role)
      await seed.query("GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO " + role)
      await seed.query("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO " + role)
      await seed.query(
        "INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,$2,'usuario@example.test','Tesouraria')",
        [identity, subject],
      )
      for (const [company, tax] of [
        [tenant, "04252011000110"],
        [other, "19131243000197"],
      ]) {
        const member = randomUUID(),
          profile = randomUUID()
        await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa',$2)", [company, tax])
        await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [
          member,
          company,
          identity,
        ])
        await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'financeiro','Financeiro')", [
          profile,
          company,
        ])
        await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [member, profile])
        await seed.query(
          "INSERT INTO role_permissions(role_id,permission_code) SELECT $1,code FROM permissions WHERE code LIKE 'finance.%'",
          [profile],
        )
      }
      await seed.query(
        "INSERT INTO financial_accounts(id,tenant_id,code,name,status,account_type,revision) VALUES($1,$2,'B','Banco','active','bank',1)",
        [bank, tenant],
      )
      const items: { id: string; cents: string; dueOn: string }[] = []
      for (const [name, tax, cents, dueOn] of [
        ["Ana", "52998224725", "4010", "2028-02-10"],
        ["Bia", "11144477735", "6020", "2028-02-15"],
      ] as const) {
        const party = randomUUID(),
          order = randomUUID(),
          id = randomUUID()
        await seed.query(
          "INSERT INTO parties(id,tenant_id,legal_name,person_type,tax_id,email,is_customer,is_supplier,status) VALUES($1,$2,$3,'fisica',$4,'test_user_br@testuser.com',true,false,'active')",
          [party, tenant, name, tax],
        )
        await seed.query(
          "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,amount_cents,due_date,status) VALUES($1,$2,$3,$4,$5,$6,$7,'completed')",
          [order, tenant, party, name, tax, cents, dueOn],
        )
        await seed.query(
          "INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,$4,$5,$6,'open')",
          [id, tenant, order, name, dueOn, cents],
        )
        items.push({ id, cents, dueOn })
      }
      const body = { accountId: bank, reference: "Borderô regional", items },
        key = randomUUID()
      assert.equal((await call("collections")).json().data.accounts.length, 0)
      assert.equal((await call("batches")).json().data.accounts[0].id, bank)
      assert.equal((await call("prepare-batch", { ...body, items: [items[0], items[0]] })).statusCode, 422)
      assert.equal((await call("prepare-batch", { ...body, items: [{ ...items[0], cents: "1" }] })).statusCode, 409)
      const [first, replay] = await Promise.all([call("prepare-batch", body, key), call("prepare-batch", body, key)])
      assert.equal(first.statusCode, 201, first.body)
      assert.equal(replay.statusCode, 201, replay.body)
      const id = first.json().data.id
      assert.equal(replay.json().data.id, id)
      assert.equal((await call("prepare-batch", body)).statusCode, 409)
      assert.equal((await call("batches?batchId=" + id, undefined, randomUUID(), other)).statusCode, 404)
      assert.equal((await call("prepare-batch", body, randomUUID(), other)).statusCode, 404)
      const detail = (await call("batches?batchId=" + id)).json().data
      assert.deepEqual(
        detail.items.map(({ name, cents, dueOn }: { name: string; cents: string; dueOn: string }) => [
          name,
          cents,
          dueOn,
        ]),
        [
          ["Ana", "4010", "2028-02-10"],
          ["Bia", "6020", "2028-02-15"],
        ],
      )
      assert.equal((await call("batches")).json().data.history[0].cents, "10030")
      assert.equal((await call("batches")).json().data.candidates.length, 0)
      const cancel = { batchId: id, reason: "Conferência dos títulos" },
        cancelKey = randomUUID()
      assert.equal((await call("cancel-batch", cancel, cancelKey)).statusCode, 201)
      assert.equal((await call("cancel-batch", cancel, cancelKey)).statusCode, 201)
      assert.equal((await call("batches?batchId=" + id)).json().data.items[0].state, "cancelled")
      assert.equal((await call("batches")).json().data.candidates.length, 2)
      const active = (await call("prepare-batch", body)).json().data.id
      Object.assign(process.env, config)
      const input = { batchId: active, accountId: bank, billingType: "PIX" as const, receivableIds: [items[0]!.id] }
      const reserve = (args: typeof input) =>
        withTenantTransaction(
          pool,
          tenant,
          subject,
          (ctx) =>
            reserveCharge(
              { ...ctx, identity: { subject, email: "", emailVerified: false, name: "" } },
              {},
              args,
              randomUUID(),
            ),
          true,
        )
      await seed.query("UPDATE receivables SET due_date=due_date+1 WHERE id=$1", [items[0]!.id])
      await assert.rejects(() => reserve(input), /diverge do borderô/)
      await seed.query("UPDATE receivables SET due_date=due_date-1 WHERE id=$1", [items[0]!.id])
      const charge = await reserve(input)
      assert.equal(await reserve(input), charge)
      assert.equal((await call("cancel-batch", { ...cancel, batchId: active })).statusCode, 409)
      await withTenantTransaction(
        pool,
        tenant,
        subject,
        async (ctx) => {
          const authorized = { ...ctx, identity: { subject, email: "", emailVerified: false, name: "" } }
          const payment = {
            id: "7711",
            live_mode: false,
            collector_id: "44",
            currency_id: "BRL",
            external_reference: charge,
            status: "approved",
            payment_method_id: "pix",
            transaction_amount: 40.1,
            date_approved: "2028-02-10T12:00:00-03:00",
            transaction_details: { net_received_amount: 40.1 },
          }
          for (const source of ["webhook", "report"])
            await observePayment(authorized, {}, await getCharge(authorized, charge), payment, source, "7711")
        },
        true,
      )
      const updated = (await call("batches?batchId=" + active)).json().data.items
      assert.deepEqual(
        updated.map((i: { state: string }) => i.state),
        ["paid", "selected"],
      )
      assert.equal(updated[0].providerId, "7711")
      assert.ok(updated[0].paymentId)
      assert.deepEqual(updated[0].events.map((e: { source: string }) => e.source).sort(), ["report", "webhook"])
      assert.equal((await call("batches?batchId=" + id)).json().data.items[0].providerId, null)
      // Simulate only the institution. Both HTTP routes, authorization, receipts and database are real.
      const originalFetch = globalThis.fetch
      let downloads = 0,
        collector = "44",
        wrongSize = false
      try {
        globalThis.fetch = async (url, options) => {
          assert.equal(new Headers(options?.headers).get("authorization"), "Bearer local-test-token")
          assert.equal(options?.redirect, "error")
          assert.equal(options?.method, "GET")
          const address = new URL(String(url))
          if (address.href === "https://api.mercadolibre.com/users/me")
            return Response.json({ id: "44", site_id: "MLB", tags: ["test_user"] })
          assert.equal(address.origin, "https://api.mercadopago.com")
          if (address.pathname === "/v1/account/settlement_report/list")
            return Response.json([
              { id: 51, user_id: collector, file_name: "relatorio.csv" },
              { id: 52, user_id: collector, file_name: "../relatorio.csv" },
              { id: 53, user_id: collector, file_name: "relatorio.xlsx" },
              { id: 54, user_id: collector, file_name: "vazio.csv" },
            ])
          if (address.pathname === "/v1/account/settlement_report/relatorio.csv") {
            downloads++
            return new Response(
              "EXTERNAL_REFERENCE;SOURCE_ID;USER_ID;TRANSACTION_TYPE;TRANSACTION_AMOUNT;TRANSACTION_CURRENCY;SETTLEMENT_NET_AMOUNT\n" +
                charge +
                ";7711;44;SETTLEMENT;40.10;BRL;40.10",
              { headers: { "content-type": "text/csv", ...(wrongSize ? { "content-length": "3000000" } : {}) } },
            )
          }
          if (address.pathname === "/v1/account/settlement_report/vazio.csv")
            return new Response("", { headers: { "content-type": "text/csv" } })
          assert.equal(address.pathname, "/v1/payments/7711")
          return Response.json({
            id: "7711",
            live_mode: false,
            collector_id: 44,
            currency_id: "BRL",
            external_reference: charge,
            status: "approved",
            payment_method_id: "pix",
            transaction_amount: 40.1,
            transaction_details: { net_received_amount: 40.1 },
          })
        }
        const catalog = "provider-reports?accountId=" + bank
        const available = await call(catalog)
        assert.equal(available.statusCode, 200, available.body)
        assert.deepEqual(
          available.json().data.map((r: { id: string }) => r.id),
          ["51", "54"],
        )
        assert.equal((await call(catalog, undefined, randomUUID(), other)).statusCode, 404)
        collector = "47"
        assert.equal((await call(catalog)).statusCode, 409)
        collector = "44"
        const selected = { accountId: bank, remoteReportId: "51" }
        assert.equal((await call("import-return", { ...selected, remoteReportId: "52" })).statusCode, 422)
        wrongSize = true
        assert.equal((await call("import-return", selected)).statusCode, 422)
        wrongSize = false
        const commandKey = randomUUID(),
          downloaded = await call("import-return", selected, commandKey)
        assert.equal(downloaded.statusCode, 200, downloaded.body)
        assert.equal(downloaded.json().data.outcomes[0].state, "paid")
        assert.equal((await call("import-return", selected, commandKey)).statusCode, 200)
        assert.equal((await call("import-return", selected)).statusCode, 200)
        assert.equal(downloads, 2, "one rejected oversized download, one successful download")
        const empty = await call("import-return", { ...selected, remoteReportId: "54" })
        assert.equal(empty.statusCode, 200, empty.body)
        assert.deepEqual(empty.json().data.outcomes, [])
        const archived = await seed.query(
          "SELECT report_id,file_name,csv_content,result,content_sha256 FROM finance_collection_imports WHERE tenant_id=$1 ORDER BY report_id",
          [tenant],
        )
        assert.deepEqual(
          archived.rows.map((r) => r.file_name),
          ["relatorio.csv", "vazio.csv"],
        )
        assert.equal(archived.rows[0].csv_content, null)
        assert.match(archived.rows[0].content_sha256, /^[a-f0-9]{64}$/)
        assert.equal(
          (await seed.query("SELECT count(*)::int n FROM receivable_payments WHERE tenant_id=$1", [tenant])).rows[0].n,
          1,
        )
      } finally {
        globalThis.fetch = originalFetch
      }
      await t.test("emissão, reconsulta e liquidação idempotente de boleto pela API", async () => {
        await verifyBoleto(app, seed, { tenant, bank, batchId: active, receivable: items[1]!.id })
      })
    } finally {
      for (const [k, v] of Object.entries(previous))
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      await app.close()
      await connects.end()
      await seed.end()
      await admin.query("DROP DATABASE " + db)
      await admin.query("DROP ROLE IF EXISTS " + role)
      await admin.end()
    }
  },
)
