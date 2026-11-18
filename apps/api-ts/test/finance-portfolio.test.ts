import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { Pool } from "pg"
import { buildApp } from "../src/app.js"
import { PostgresPool } from "../src/platform/database.js"

test(
  "portfolio reconciles every title and partial receipt, including documents beyond the displayed page",
  { skip: !process.env.API_TS_TEST_ADMIN_URL },
  async (t) => {
    const url = new URL(process.env.API_TS_TEST_ADMIN_URL!)
    const database = "finance_report_" + randomUUID().replaceAll("-", "")
    const admin = new Pool({ connectionString: url.toString() })
    await admin.query("CREATE DATABASE " + database)
    url.pathname = "/" + database
    const seed = new Pool({ connectionString: url.toString() })
    const pool = new PostgresPool(url.toString(), 2)
    const app = buildApp({
      pool,
      userinfoUrl: "https://example.test/auth",
      fetchAuth: async (_input, options) => {
        const reviewer = new Headers(options?.headers).get("authorization") === "Bearer reviewer"
        return Response.json({
          sub: reviewer ? "reviewer" : "finance-test",
          email: reviewer ? "reviewer@example.test" : "finance@example.test",
        })
      },
    })
    try {
      const dir = new URL("../../../migrations/", import.meta.url)
      for (const name of (await readdir(dir)).filter((s) => s.endsWith(".sql")).sort())
        await seed.query(await readFile(new URL(name, dir), "utf8"))
      const tenant = randomUUID(),
        customer = randomUUID(),
        identity = randomUUID(),
        membership = randomUUID(),
        role = randomUUID()
      await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Financeiro','04252011000110')", [tenant])
      await seed.query(
        "INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,'finance-test','finance@example.test','Operador')",
        [identity],
      )
      await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [
        membership,
        tenant,
        identity,
      ])
      await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'finance-test','Operador')", [role, tenant])
      await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, role])
      await seed.query(
        "INSERT INTO role_permissions(role_id,permission_code) SELECT $1,code FROM permissions WHERE code LIKE 'finance.%'",
        [role],
      )
      await seed.query(
        "INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'juridica','Cliente piloto','04252011000110',true,true,'active')",
        [customer, tenant],
      )
      const issued = await seed.query(
        "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) SELECT gen_random_uuid(),$1,$2,'Cliente piloto','04252011000110',current_date,100000,'completed' FROM generate_series(1,105) RETURNING id",
        [tenant, customer],
      )
      const titles = await seed.query(
        "INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) SELECT gen_random_uuid(),$1,id,'Cliente piloto',current_date-3,100000,'open' FROM unnest($2::uuid[]) id RETURNING id",
        [tenant, issued.rows.map((r) => r.id)],
      )
      await seed.query(
        "INSERT INTO receivable_payments(id,tenant_id,receivable_id,kind,amount_cents,method,reference,occurred_on) VALUES(gen_random_uuid(),$1,$2,'receipt',40000,'other','parcial',current_date)",
        [tenant, titles.rows[0]!.id],
      )
      const headers = { authorization: "Bearer finance-test", "x-tenant-id": tenant }
      const response = await app.inject({ method: "GET", url: "/api/v1/finance/portfolio?limit=10", headers })
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.json().total, 105)
      assert.equal(response.json().rows.length, 10)
      assert.equal(response.json().totals.receivable, "104600.00")
      assert.equal(response.json().totals.payable, "0.00")
      assert.equal(response.json().buckets.find((b: { bucket: string }) => b.bucket === "1_30").receivable, "104600.00")
      const filtered = await app.inject({ method: "GET", url: "/api/v1/finance/portfolio?bucket=over90", headers })
      assert.equal(filtered.json().total, 0)
      const reviewer = randomUUID(),
        reviewerMembership = randomUUID(),
        account = randomUUID()
      await seed.query(
        "INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,'reviewer','reviewer@example.test','Revisor')",
        [reviewer],
      )
      await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [
        reviewerMembership,
        tenant,
        reviewer,
      ])
      await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [reviewerMembership, role])
      await seed.query(
        "INSERT INTO financial_accounts(id,tenant_id,code,name,status,revision,account_type) VALUES($1,$2,'B01','Conta piloto','active',1,'bank')",
        [account, tenant],
      )
      const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date())
      const wallet = { partyId: customer, side: "receivable", occurredOn: day, reason: "Conferência da carteira" }
      const write = async (
        path: string,
        payload: Record<string, unknown>,
        status = 201,
        key = randomUUID(),
        token = "finance-test",
      ) => {
        const reply = await app.inject({
          method: "POST",
          url: "/api/v1/finance/" + path,
          headers: { ...headers, authorization: "Bearer " + token, "idempotency-key": key },
          payload,
        })
        assert.equal(reply.statusCode, status, reply.body)
        if (status < 300) assert.match(String(reply.headers.etag), /^"\d+"$/)
        return reply.json()
      }
      const get = async (path: string) => {
        const reply = await app.inject({ method: "GET", url: "/api/v1/finance/" + path, headers })
        assert.equal(reply.statusCode, 200, reply.body)
        return reply.json()
      }
      const reverse = (id: string, status = 200) =>
        write("operation-reversals", { id, occurredOn: day, reason: "Correção conferida" }, status)
      const target = async (index: number, amount: string) => {
        const id = titles.rows[index]!.id
        const row = (await seed.query("SELECT revision FROM receivables WHERE id=$1", [id])).rows[0]!
        return { id, side: "receivable", amount, revision: String(row.revision) }
      }
      const initial = await get("partner?partyId=" + customer)
      assert.equal(initial.position.creditLimit, null)
      const credit = await app.inject({
        method: "PUT",
        url: "/api/v1/finance/partner/credit",
        headers: { ...headers, "if-match": '"1"' },
        payload: { partyId: customer, limit: "105000" },
      })
      assert.equal(credit.statusCode, 200, credit.body)
      assert.equal(credit.headers.etag, '"2"')
      assert.equal((await get("partner?partyId=" + customer)).position.creditAvailable, "400.00")

      const advanceBody = { ...wallet, kind: "advance", accountId: account, amount: "250.00" }
      const key = randomUUID(),
        advance = await write("operations", advanceBody, 201, key)
      assert.equal((await write("operations", advanceBody, 201, key)).data.id, advance.data.id)
      const allocation = await write("operations", {
        ...wallet,
        kind: "allocation",
        advanceId: advance.data.id,
        targets: [await target(0, "100")],
      })
      assert.equal((await get("partner?partyId=" + customer)).position.receivable, "104500.00")
      assert.equal((await get("cashflow?from=" + day + "&to=" + day)).data[0].realized, "250.00")
      assert.equal(
        (await get("operations?partyId=" + customer)).data.find((v: { id: string }) => v.id === advance.data.id).available,
        "150.00",
      )
      await reverse(advance.data.id, 409)
      await reverse(allocation.data.id)
      await reverse(advance.data.id)
      assert.equal((await get("cashflow?from=" + day + "&to=" + day)).data[0].realized, "0.00")
      assert.equal((await get("partner?partyId=" + customer)).position.receivable, "104600.00")
      await reverse(advance.data.id, 409)

      const grouping = {
        ...wallet,
        kind: "billing_group",
        targets: [await target(1, "1000.00"), await target(2, "1000.00")],
        dueOn: day,
      }
      const group = await write("operations", grouping)
      await write("operations", grouping, 409)
      await reverse(group.data.id)
      assert.ok((await write("operations", grouping)).data.id)

      await seed.query(
        "INSERT INTO financial_wallet_settings(tenant_id,restructure_approval_limit_cents) VALUES($1,5000) ON CONFLICT(tenant_id) DO UPDATE SET restructure_approval_limit_cents=5000",
        [tenant],
      )
      const restructure = {
        ...wallet,
        kind: "restructure",
        targets: [await target(3, "100.00")],
        interest: "10.00",
        schedule: [{ dueOn: day, amount: "110.00" }],
      }
      const pending = await write("operations", restructure)
      assert.equal(pending.data.status, "pending")
      const decision = { id: pending.data.id, decision: "approved", reason: "Responsável conferiu as parcelas" }
      await write("operation-decisions", decision, 403)
      await write("operation-decisions", decision, 200, randomUUID(), "reviewer")
      const approved = (await get("operations?partyId=" + customer)).data.find((v: { kind: string }) => v.kind === "restructure")
      assert.equal((await get("partner?partyId=" + customer)).position.receivable, "104610.00")
      const period = "from=" + day + "&to=" + day
      assert.equal((await get("income-statement?" + period)).result, "105010.00")
      await reverse(approved.id)
      assert.equal((await get("income-statement?" + period)).result, "105000.00")
      assert.equal((await get("cashflow?" + period)).data[0].forecastIn, "104600.00")

      await write("company-periods", { action: "close", throughDate: day, reason: "Conferência encerrada" }, 200)
      assert.equal((await get("company-periods")).cutoff, day)
      await write("operations", advanceBody, 409)
      await write("company-periods", { action: "reopen", throughDate: day, reason: "Correção autorizada" }, 200)
      assert.equal((await get("company-periods")).cutoff, null)
      assert.ok((await write("operations", advanceBody)).data.id)

      const purchase = randomUUID(),
        receipt = randomUUID(),
        payable = randomUUID()
      await seed.query(
        "INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente piloto','04252011000110',$4,8000,'received')",
        [purchase, tenant, customer, day],
      )
      await seed.query(
        "INSERT INTO purchase_receipts(id,tenant_id,order_id,reference,occurred_on,amount_cents) VALUES($1,$2,$3,'Compra piloto',$4,8000)",
        [receipt, tenant, purchase, day],
      )
      await seed.query(
        "INSERT INTO payables(id,tenant_id,receipt_id,supplier_name,due_date,amount_cents) VALUES($1,$2,$3,'Cliente piloto',$4,8000)",
        [payable, tenant, receipt, day],
      )
      const beforeOffset = (await get("cashflow?" + period)).data[0].realized
      const offset = await write("operations", {
        ...wallet,
        kind: "offset",
        targets: [await target(4, "80"), { side: "payable", id: payable, amount: "80.00", revision: "1" }],
      })
      assert.equal((await get("partner?partyId=" + customer)).position.payable, "0.00")
      assert.equal((await get("cashflow?" + period)).data[0].realized, beforeOffset)
      await reverse(offset.data.id)
      assert.equal((await get("partner?partyId=" + customer)).position.payable, "80.00")

      const order = randomUUID()
      await seed.query(
        "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente piloto','04252011000110',$4,50000,'confirmed')",
        [order, tenant, customer, day],
      )
      const orderAdvance = await write("operations", { ...advanceBody, orderId: order })
      assert.equal((await get("cashflow?" + period + "&orders=yes")).data[0].forecastIn, "105100.00")
      await seed.query(
        "INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'sales.orders.read'),($1,'sales.orders.manage')",
        [role],
      )
      const complete = await app.inject({
        method: "POST",
        url: "/api/v1/orders/" + order + "/complete",
        headers: { ...headers, "if-match": '"1"', "idempotency-key": randomUUID() },
      })
      assert.equal(complete.statusCode, 200, complete.body)
      const auto = (await get("operations?partyId=" + customer)).data.find((v: { id: string }) => v.id === orderAdvance.data.id)
      assert.equal(auto.available, "0.00")
      assert.equal((await get("cashflow?" + period + "&orders=yes")).data[0].forecastIn, "104850.00")
      const ledger = await get("balances")
      assert.equal(ledger.data[0].balance, "500.00")

      const vendorOrder = randomUUID(),
        product = randomUUID()
      await seed.query(
        "INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'PILOTO','Produto teste','UN',10000,'active')",
        [product, tenant],
      )
      await seed.query(
        "INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente piloto','04252011000110',$4,10000,'confirmed')",
        [vendorOrder, tenant, customer, day],
      )
      await seed.query(
        "INSERT INTO purchase_order_lines(tenant_id,order_id,product_id,line_number,sku,name,unit,quantity_micros,cost_cents,amount_cents) VALUES($1,$2,$3,1,'PILOTO','Produto teste','UN',1000000,10000,10000)",
        [tenant, vendorOrder, product],
      )
      const vendorAdvance = await write("operations", { ...advanceBody, side: "payable", orderId: vendorOrder, amount: "50.00" })
      await seed.query(
        "INSERT INTO role_permissions(role_id,permission_code) SELECT $1,code FROM permissions WHERE code IN ('purchasing.orders.read','purchasing.receipts.create','inventory.stock.manage') ON CONFLICT DO NOTHING",
        [role],
      )
      const received = await app.inject({
        method: "POST",
        url: "/api/v1/purchase-orders/" + vendorOrder + "/receipts",
        headers: { ...headers, "if-match": '"1"', "idempotency-key": randomUUID() },
        payload: { reference: "Entrada do fornecedor", occurredOn: day, items: [{ productId: product, quantity: "1.000000" }] },
      })
      assert.equal(received.statusCode, 201, received.body)
      const purchaseBalance = (await get("operations?partyId=" + customer)).data.find(
        (v: { id: string }) => v.id === vendorAdvance.data.id,
      )
      assert.equal(purchaseBalance.available, "0.00")
      assert.equal((await get("partner?partyId=" + customer)).position.payable, "130.00")
      assert.equal((await get("balances")).data[0].balance, "450.00")

      await t.test("future receipts and reversals reserve principal while today's position and realized cash honor the cutoff", async () => {
        const party = randomUUID(), bank = randomUUID()
        const days = (await seed.query("SELECT ($1::date+1)::text AS tomorrow,($1::date+2)::text AS later", [day])).rows[0]!
        await seed.query(
          "INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'juridica','Cliente agendado','11222333000181',true,false,'active')",
          [party, tenant],
        )
        await seed.query(
          "INSERT INTO financial_accounts(id,tenant_id,code,name,status,revision,account_type) VALUES($1,$2,'FUT','Conta agendada','active',1,'bank')",
          [bank, tenant],
        )
        const makeTitle = async () => {
          const id = randomUUID(), source = randomUUID()
          await seed.query(
            "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente agendado','11222333000181',$4,10000,'completed')",
            [source,tenant,party,day],
          )
          await seed.query(
            "INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,forecast_account_id,status) VALUES($1,$2,$3,'Cliente agendado',$4,10000,$5,'open')",
            [id,tenant,source,day,bank],
          )
          return id
        }
        const command = async (id: string, action: string, revision: number, payload: object, status = 200, key = randomUUID()) => {
          const result = await app.inject({
            method: "POST", url: "/api/v1/receivables/" + id + "/" + action, payload,
            headers: { ...headers, "if-match": '"' + revision + '"', "idempotency-key": key },
          })
          assert.equal(result.statusCode, status, result.body)
          return result.json()
        }
        const receipt = (occurredOn: string) => ({ occurredOn, amount: "100.00", financialAccountId: bank, method: "bank_transfer", reference: "Recebimento agendado" })
        const position = async () => (await get("partner?partyId=" + party)).position
        const bankBalance = async () => (await get("balances")).data.find((r: { id: string }) => r.id === bank).balance
        const flow = async (from = day) => (await get("cashflow?accountId=" + bank + "&from=" + from + "&to=" + days.later)).data
        const first = await makeTitle(), key = randomUUID()
        const paid = await command(first, "payments", 1, receipt(days.tomorrow), 200, key)
        assert.equal(paid.data.outstandingAmount, "0.00")
        assert.deepEqual(await command(first, "payments", 1, receipt(days.tomorrow), 200, key), paid)
        await command(first, "payments", 2, receipt(days.tomorrow), 409)
        for (const url of ["portfolio?", "portfolio/export?"]) {
          const wallet = await get(url + "partyId=" + party + "&status=open")
          assert.equal(wallet.asOf, day)
          assert.equal(wallet.totals.receivable, "100.00")
          assert.equal(wallet.totals.futureMovementTitles, 1)
          assert.equal(wallet.rows[0].operationalOutstanding, "0.00")
          assert.equal(wallet.rows[0].nextMovementOn, days.tomorrow)
        }
        assert.equal((await position()).receivable, "100.00")
        assert.equal((await position()).averageDays, null)
        assert.equal(await bankBalance(), "0.00")
        const [now, tomorrow] = await flow()
        assert.equal(now.projected, "0.00")
        assert.equal(tomorrow.forecastIn, "100.00")
        assert.equal(tomorrow.cashIn, "0.00")
        assert.equal(tomorrow.realized, "0.00")
        assert.equal(tomorrow.projected, "100.00")
        assert.equal((await flow(days.later))[0].projected, "100.00")
        assert.equal((await flow(days.later))[0].realized, "0.00")
        await command(first, "reverse-payment", 2, { paymentId: paid.payments[0].id, reason: "Estorno futuro", occurredOn: days.later })
        await command(first, "payments", 3, receipt(day), 409)
        assert.equal((await flow())[2].forecastOut, "100.00")
        assert.equal((await flow())[2].projected, "0.00")

        const second = await makeTitle()
        const todayReceipt = await command(second, "payments", 1, receipt(day))
        await command(second, "reverse-payment", 2, { paymentId: todayReceipt.payments[0].id, reason: "Estorno futuro", occurredOn: days.tomorrow })
        const settled = await get("portfolio?partyId=" + party + "&status=paid")
        assert.equal(settled.rows.length, 1)
        assert.equal(settled.rows[0].id, second)
        assert.equal(settled.rows[0].outstanding, "0.00")
        assert.equal(settled.rows[0].operationalOutstanding, "100.00")
        assert.equal(settled.rows[0].nextMovementOn, days.tomorrow)
        const partner = await position()
        assert.equal(partner.receivable, "100.00")
        assert.equal(partner.futureMovementTitles, 2)
        assert.equal(partner.averageDays, "0.0")
        assert.equal(await bankBalance(), "100.00")
        const [current, next] = await flow()
        assert.equal(current.realized, "100.00")
        assert.equal(current.projected, "100.00")
        assert.equal(next.forecastIn, "100.00")
        assert.equal(next.forecastOut, "100.00")
        assert.equal(next.cashOut, "0.00")
        await command(second, "payments", 3, receipt(day), 409)
        await command(second, "payments", 3, receipt(days.tomorrow))
      })

      await t.test("income recognizes installments once in the invoiced month and uses completion for a legacy sale", async () => {
        const invoiced = randomUUID(), legacy = randomUUID(), method = randomUUID()
        await seed.query(
          `INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status,created_at,updated_at)
           VALUES ($1,$3,$4,'Cliente piloto','04252011000110','2020-12-01',15000,'accepted','2020-10-01','2020-10-01'),
                  ($2,$3,$4,'Cliente piloto','04252011000110','2020-12-01',8000,'completed','2020-10-01','2020-12-20')`,
          [invoiced, legacy, tenant, customer],
        )
        await seed.query(
          "INSERT INTO payment_methods(id,tenant_id,code,name,status,revision,modality,settlement_days) VALUES($1,$2,'PIX-DRE','Pix','active',1,'pix',0)",
          [method, tenant],
        )
        await seed.query(
          "INSERT INTO sales_order_checkouts(tenant_id,order_id,customer_snapshot,entry_amount_cents,delivery_notes,payment_notes,notes) VALUES($1,$2,'{}',0,'','','')",
          [tenant, invoiced],
        )
        await seed.query(
          `WITH terms AS (
             INSERT INTO sales_order_installments(id,tenant_id,order_id,number,kind,payment_method_id,payment_method,due_on,amount_cents)
             SELECT gen_random_uuid(),$1,$2,n,'balance',$3,'{}','2020-11-01'::date+30*n,7500 FROM generate_series(1,2) n
             RETURNING *
           ) INSERT INTO receivables(id,tenant_id,order_id,order_installment_id,customer_name,due_date,amount_cents,status,created_at)
             SELECT gen_random_uuid(),tenant_id,order_id,id,'Cliente piloto',due_on,amount_cents,'open','2020-10-02' FROM terms`,
          [tenant, invoiced, method],
        )
        await seed.query(
          "INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status,created_at) VALUES(gen_random_uuid(),$1,$2,'Cliente piloto','2020-12-01',8000,'open','2020-10-03')",
          [tenant, legacy],
        )
        await seed.query(
          "INSERT INTO audit_log(tenant_id,entity_type,entity_id,action,occurred_at) VALUES($1,'sales_order',$2,'order.completed','2020-11-07T10:00:00-03:00')",
          [tenant, legacy],
        )
        const income = async (from: string, to: string) => (await get("income-statement?from=" + from + "&to=" + to)).result
        assert.equal(await income("2020-10-01", "2020-10-31"), "0.00")
        for (const [environment, status, issued, number] of [
          ["homologation", "authorized", "2020-10-04", 1],
          ["production", "rejected", "2020-10-05", 2],
          ["production", "authorized", "2020-11-03", 3],
        ] as const) {
          const invoice = randomUUID()
          await seed.query(
            "INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents) VALUES($1,$2,$3,55,1,1,'{}',$4,15000)",
            [tenant, invoice, environment, { sourceOrderId: invoiced }],
          )
          await seed.query(
            `INSERT INTO fiscal_nfe_documents(tenant_id,id,source_order_id,environment,status,series,number,issued_at,random_code,signed_xml,access_key,protocol,authorized_xml)
             VALUES($1,$2,$3,$4,$5,1,$6,$7,'12345678','<xml/>',repeat($8,44),'protocol','<xml/>')`,
            [tenant, invoice, invoiced, environment, status, number, issued + "T09:00:00-03:00", String(number)],
          )
        }
        assert.equal(await income("2020-10-01", "2020-10-31"), "0.00")
        assert.equal(await income("2020-11-03", "2020-11-03"), "150.00")
        assert.equal(await income("2020-11-07", "2020-11-07"), "80.00")
        await seed.query("UPDATE sales_orders SET status='completed',updated_at='2020-12-08' WHERE tenant_id=$1 AND id=$2", [tenant, invoiced])
        assert.equal(await income("2020-11-01", "2020-11-30"), "230.00")
        assert.equal(await income("2020-12-01", "2020-12-31"), "0.00")
      })

      await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='finance.receivables.read'", [role])
      const restricted = await app.inject({ method: "GET", url: "/api/v1/finance/portfolio", headers })
      assert.equal(restricted.json().total, 2)
      assert.equal(restricted.json().rows[0].side, "payable")
    } finally {
      await app.close()
      await pool.close()
      await seed.end()
      try {
        await admin.query("DROP DATABASE " + database)
      } finally {
        await admin.end()
      }
    }
  },
)
