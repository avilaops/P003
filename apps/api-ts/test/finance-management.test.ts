import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import Fastify from "fastify"
import { Pool } from "pg"
import { processInvoiceQueue } from "../src/modules/finance-management/invoice-worker.js"
import { registerOrderRoutes } from "../src/modules/orders/routes.js"
import { registerCommercialMetrics } from "../src/modules/commercial/metrics.js"
import { freezeOrderPolicies, calculateCommission } from "../src/modules/finance-management/accrual.js"
import { apportion } from "../src/modules/finance-management/receipt-origins.js"
import { registerFinanceManagementRoutes } from "../src/modules/finance-management/routes.js"
import { registerFinanceWalletRoutes } from "../src/modules/finance-wallets/routes.js"
import { registerFinanceInsightRoutes } from "../src/modules/finance-insights/routes.js"
import { PgClientAdapter, withTenantTransaction } from "../src/platform/database.js"
import { Problem } from "../src/platform/problem.js"
import { stringifyJson } from "../src/platform/json.js"

test("Comissão • fórmula original, restos de centavo e repasses monotônicos", () => {
  assert.deepEqual(calculateCommission(101n, 50000n, 100000n), { base: 92n, amount: 5n })
  const weights = [4n, 11n, 7n, 3n]
  let previous = apportion(0n, weights)
  for (let paid = 1n; paid <= 250n; paid++) {
    const current = apportion(paid, weights)
    assert.equal(
      current.reduce((a, b) => a + b),
      paid,
    )
    assert.ok(current.every((value, i) => value >= previous[i]!))
    previous = current
  }
  assert.deepEqual(previous, [40n, 110n, 70n, 30n])
})

test(
  "PostgreSQL • políticas, faturamento, baixa, fechamento, estorno, renegociação e livros",
  { skip: !process.env.API_TS_TEST_ADMIN_URL },
  async () => {
    const url = new URL(process.env.API_TS_TEST_ADMIN_URL!),
      database = "management_" + randomUUID().replaceAll("-", ""),
      dbRole = database + "_app"
    const admin = new Pool({ connectionString: url.toString() })
    await admin.query("CREATE DATABASE " + database)
    url.pathname = "/" + database
    const pg = new Pool({ connectionString: url.toString() }),
      conn = new Pool({ connectionString: url.toString() })
    const app = Fastify()
    app.setErrorHandler((e, _req, reply) => {
      if (e instanceof Problem) reply.code(e.status).send(e.toJSON())
      else reply.code(500).send({ error: String(e) })
    })
    app.setReplySerializer(stringifyJson)
    try {
      const dir = new URL("../../../migrations/", import.meta.url)
      for (const file of (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort())
        await pg.query(await readFile(new URL(file, dir), "utf8"))
      await admin.query("CREATE ROLE " + dbRole + " NOLOGIN NOSUPERUSER NOBYPASSRLS")
      await pg.query(
        "GRANT USAGE ON SCHEMA public TO " +
          dbRole +
          "; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO " +
          dbRole +
          "; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO " +
          dbRole,
      )
      const tenant = randomUUID(),
        role = randomUUID(),
        member = randomUUID(),
        staff = randomUUID(),
        order = randomUUID(),
        second = randomUUID(),
        title = randomUUID(),
        title2 = randomUUID(),
        invoice = randomUUID(),
        bank = randomUUID()
      const pool = {
        async connect() {
          const client = await conn.connect()
          await client.query("SET ROLE " + dbRole)
          return new PgClientAdapter(client)
        },
      }
      const deps = {
        pool,
        userinfoUrl: "http://auth.test/userinfo",
        fetchAuth: async () =>
          Response.json({ sub: "operator", name: "Operador", email: "operator@example.test", email_verified: true }),
      }
      registerFinanceManagementRoutes(app, deps)
      registerFinanceWalletRoutes(app, deps)
      registerFinanceInsightRoutes(app, deps)
      registerOrderRoutes(app, deps)
      registerCommercialMetrics(app, deps)
      await pg.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa','04252011000110')", [tenant])
      await pg.query(
        "INSERT INTO identities(auth_subject,email,display_name) VALUES('operator','operator@example.test','Operador')",
      )
      await pg.query(
        "INSERT INTO tenant_memberships(id,tenant_id,identity_id) SELECT $1,$2,id FROM identities WHERE auth_subject='operator'",
        [member, tenant],
      )
      await pg.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'operator','Operador')", [role, tenant])
      await pg.query("INSERT INTO membership_roles VALUES($1,$2)", [member, role])
      await pg.query(
        "INSERT INTO role_permissions(role_id,permission_code) SELECT $1,code FROM permissions WHERE code LIKE 'finance.%' OR code LIKE 'sales.orders.%'",
        [role],
      )
      await pg.query(
        "INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Parceiro','52998224725',true,true,'active')",
        [tenant],
      )
      await pg.query(
        "INSERT INTO financial_accounts(id,tenant_id,code,name,status,revision,account_type) VALUES($1,$2,'BANCO','Banco','active',1,'bank')",
        [bank, tenant],
      )
      await pg.query(
        "INSERT INTO staff(id,tenant_id,code,name,is_employee,is_seller,status) VALUES($1,$2,'F1','Vendedor',true,true,'active')",
        [staff, tenant],
      )
      const headers = { "x-tenant-id": tenant, authorization: "Bearer operator" }
      const get = (path: string) => app.inject({ url: "/api/v1/" + path, headers })
      const send = (path: string, payload: object, rev: number, key = randomUUID(), method: "POST" | "PUT" = "POST") =>
        app.inject({
          url: "/api/v1/" + path,
          method,
          headers: { ...headers, "if-match": '"' + rev + '"', "idempotency-key": key },
          payload,
        })
      const check = (r: { statusCode: number; body: string; json: () => any }, status = 200) => {
        assert.equal(r.statusCode, status, r.body)
        return r.json()
      }
      const commissions = "commissions/" + staff,
        receivables = "receivables/" + title
      await pg.query(
        "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2025-01-10',100000,'draft'),($3,$2,$2,'Cliente','52998224725','2025-01-10',40000,'draft')",
        [order, tenant, second],
      )
      const prodA = randomUUID(),
        prodB = randomUUID()
      for (const [number, product, amount] of [
        [1, prodA, 60000],
        [2, prodB, 40000],
      ] as const) {
        await pg.query(
          "INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,$3,$3,'UN',$4,'active')",
          [product, tenant, "P" + number, amount],
        )
        await pg.query(
          "INSERT INTO product_costs(tenant_id,product_id,product_line,purchase_cost_cents,tax_credit_bps,packaging_cents,revision) VALUES($1,$2,'national',100,0,0,1)",
          [tenant, product],
        )
        await pg.query(
          "INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,$3,$4,$5,$5,'UN',1000000,$6,$6)",
          [tenant, order, number, product, "P" + number, amount],
        )
      }
      let sellerRev = check(await get(commissions)).data.revision
      for (const policy of [
        { commissionRate: "1.0000", trigger: "receipt" },
        { productLine: "national", commissionRate: "20.0000", trigger: "receipt" },
        { productId: prodA, commissionRate: "10.0000", trigger: "invoice" },
      ])
        sellerRev = check(await send(commissions + "/policies", policy, sellerRev)).data.revision
      const terms = { sellerStaffId: staff, commissionRate: "5.0000", ipiRate: "0.0000", paymentDay: 5 }
      check(await send("orders/" + order + "/commission", { ...terms, usePolicies: true }, 1, randomUUID(), "PUT"))
      check(await send("orders/" + second + "/commission", terms, 1, randomUUID(), "PUT"))
      await withTenantTransaction(
        pool,
        tenant,
        "operator",
        async (c) =>
          freezeOrderPolicies(
            {
              ...c,
              identity: { subject: "operator", email: "operator@example.test", name: "Operador", emailVerified: true },
            },
            order,
          ),
        true,
      )
      sellerRev = check(
        await send(
          commissions + "/policies",
          { productId: prodA, commissionRate: "70.0000", trigger: "receipt" },
          sellerRev,
        ),
      ).data.revision
      await pg.query("UPDATE sales_orders SET status='accepted' WHERE tenant_id=$1", [tenant])
      await pg.query(
        "INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','2025-01-10',100000,'open'),($4,$2,$5,'Cliente','2025-01-10',40000,'open')",
        [title, tenant, order, title2, second],
      )
      await pg.query(
        "INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents) VALUES($1,$2,'production',55,1,1,'{}',$3,100000)",
        [tenant, invoice, { sourceOrderId: order }],
      )
      await pg.query(
        "INSERT INTO fiscal_nfe_documents(tenant_id,id,source_order_id,environment,status,series,number,issued_at,random_code,signed_xml,access_key,protocol,authorized_xml) VALUES($1,$2,$3,'production','authorized',1,1,'2025-01-01T00:00:00-03:00','12345678','<xml/>',repeat('1',44),'protocol','<xml/>')",
        [tenant, invoice, order],
      )
      let accountingRev = check(await get("accounting")).data.revision
      const accounting = async (action: string, input: object) => {
        const body = check(await send("accounting/" + action, input, accountingRev))
        accountingRev = body.data.revision
        return body
      }
      await pg.query("GRANT EXECUTE ON FUNCTION finance_pending_invoice_tenants() TO " + dbRole)
      await processInvoiceQueue(pool, (err) => {
        throw err
      })
      assert.equal(check(await get(commissions)).data.openAmount, "60.00")
      assert.equal(
        (await send("accounting/close", { month: "2025-01", reason: "Fechar janeiro" }, accountingRev)).statusCode,
        409,
      )
      await accounting("accounts", { code: "1.01", name: "Caixa", classification: "asset" })
      const chart = await accounting("accounts", { code: "2.01", name: "Contrapartida", classification: "liability" })
      const [debit, credit] = chart.accounts.map((a: { id: string }) => a.id)
      for (const eventType of [
        "sale.invoice",
        "receivable.cash",
        "payable.cash",
        "commission.closing",
        "receivable.non_cash",
      ])
        await accounting("rules", { eventType, debitId: debit, creditId: credit })
      const oldPurchase = randomUUID(),
        oldReceipt = randomUUID()
      await pg.query(
        "INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Fornecedor','52998224725','2024-12-31',25000,'received')",
        [oldPurchase, tenant],
      )
      await pg.query(
        "INSERT INTO purchase_receipts(id,tenant_id,order_id,reference,occurred_on,amount_cents) VALUES($1,$2,$3,'Compra histórica','2024-12-10',25000)",
        [oldReceipt, tenant, oldPurchase],
      )
      await accounting("rules", { eventType: "purchase.receipt", debitId: debit, creditId: credit })
      await accounting("sync", {})
      const historic = check(await get("accounting/reports/journal?from=2024-12-01&to=2024-12-31")).data
      assert.equal(historic.length, 1)
      assert.equal(historic[0].sourceId, oldReceipt)
      assert.equal(historic[0].amount, "250.00")
      const payment = {
        amount: "400.00",
        method: "bank_transfer",
        reference: "Pagamento conferido",
        occurredOn: "2025-01-08",
        financialAccountId: bank,
      }
      const paid = check(await send(receivables + "/payments", payment, 1)),
        paymentId = paid.payments[0].id
      assert.equal(check(await get(commissions)).data.openAmount, "92.00")
      const book = check(await get(commissions)),
        close = { competence: "2025-01", dueDate: "2025-02-05", reason: "Apuração aprovada" },
        key = randomUUID()
      await pg.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='finance.payables.originate'", [
        role,
      ])
      assert.equal((await send(commissions + "/closings", close, book.data.revision, key)).statusCode, 403)
      await pg.query("INSERT INTO role_permissions VALUES($1,'finance.payables.originate')", [role])
      const done = await Promise.all([
        send(commissions + "/closings", close, book.data.revision, key),
        send(commissions + "/closings", close, book.data.revision, key),
      ])
      const closed = check(done[0]!, 201)
      assert.deepEqual(closed, check(done[1]!, 201))
      assert.equal(check(await get("commercial/metrics/commissions?month=2025-01")).data.outstandingCents, 0)
      const ap = closed.closings[0].payableId
      assert.equal(closed.data.openAmount, "0.00")
      assert.ok(closed.entries.every((e: { payableId: string }) => e.payableId === ap))
      check(
        await send(
          "financial-payables/" + ap + "/payments",
          { ...payment, amount: "92.00", occurredOn: "2025-02-05" },
          1,
        ),
      )
      await accounting("close", { month: "2025-01", reason: "Conferência contábil" })
      assert.equal(
        (
          await send(
            receivables + "/reverse-payment",
            { paymentId, reason: "Estornar baixa", occurredOn: "2025-01-10" },
            2,
          )
        ).statusCode,
        409,
      )
      check(
        await send(
          receivables + "/reverse-payment",
          { paymentId, reason: "Estornar baixa", occurredOn: "2025-02-10" },
          2,
        ),
      )
      let updated = check(await get(commissions))
      assert.equal(updated.data.openAmount, "-32.00")
      assert.equal(updated.closings[0].status, "paid")
      assert.equal(updated.entries.find((e: { kind: string }) => e.kind === "reversal").competence, "2025-02")
      // An authorization and its subsequent fiscal cancellation are distinct immutable events.
      await pg.query("UPDATE fiscal_nfe_documents SET status='cancelled' WHERE tenant_id=$1 AND id=$2", [
        tenant,
        invoice,
      ])
      await accounting("sync", {})
      updated = check(await get(commissions))
      assert.equal(updated.data.openAmount, "-92.00")
      assert.equal(updated.entries.find((e: { kind: string }) => e.kind === "invoice_reversal").amount, "-60.00")
      const query = "?from=2025-01-01&to=2025-01-31"
      const journal = check(await get("accounting/reports/journal" + query)).data
      assert.equal(journal.length, 3)
      assert.ok(journal.some((j: { sourceId: string }) => j.sourceId === invoice))
      const trial = check(await get("accounting/reports/trial-balance" + query)).data
      assert.equal(trial[0].debit, "1492.00")
      assert.equal(trial[1].credit, "1492.00")
      const csv = await get("accounting/reports/ledger" + query + "&format=csv")
      assert.equal(csv.statusCode, 200, csv.body)
      assert.match(csv.body, /opening/)
      assert.match(csv.body, new RegExp(invoice))
      await accounting("reopen", { month: "2025-01", reason: "Reabertura autorizada" })
      const closingEntry = journal.find((j: { eventType: string }) => j.eventType === "commission.closing").id
      await accounting("entries/" + closingEntry + "/reverse", {
        occurredOn: "2025-02-11",
        reason: "Ajuste contábil documentado",
      })
      assert.equal(
        (
          await send(
            "accounting/entries/" + closingEntry + "/reverse",
            { occurredOn: "2025-02-11", reason: "Duplicado" },
            accountingRev,
          )
        ).statusCode,
        409,
      )

      const restructured = check(
        await send(
          "finance/operations",
          {
            kind: "restructure",
            side: "receivable",
            partyId: tenant,
            occurredOn: "2025-02-12",
            reason: "Reunir os dois pedidos",
            targets: [
              { id: title, side: "receivable", amount: "1000.00", revision: "3" },
              { id: title2, side: "receivable", amount: "400.00", revision: "1" },
            ],
            schedule: [{ amount: "1540.00", dueOn: "2025-03-01" }],
            interest: "140.00",
          },
          1,
        ),
        201,
      )
      assert.ok(restructured)
      assert.equal(check(await get(commissions)).data.openAmount, "-92.00")
      const replacement = (
        await pg.query("SELECT id FROM receivables WHERE tenant_id=$1 AND finance_operation_id IS NOT NULL", [tenant])
      ).rows[0].id
      const incoming = check(
        await send(
          "receivables/" + replacement + "/payments",
          { ...payment, amount: "770.00", occurredOn: "2025-03-01" },
          1,
        ),
      )
      updated = check(await get(commissions))
      const allocated = updated.entries.filter((e: { receiptId: string }) => e.receiptId === incoming.payments[0].id)
      assert.deepEqual(allocated.map((e: { amount: string }) => e.amount).sort(), ["10.00", "40.00"])
      check(
        await send(
          "receivables/" + replacement + "/reverse-payment",
          { paymentId: incoming.payments[0].id, reason: "Estornar renegociação", occurredOn: "2025-03-02" },
          2,
        ),
      )
      assert.equal(check(await get(commissions)).data.openAmount, "-92.00")
      check(
        await send(
          "finance/operation-reversals",
          { id: restructured.data.id, occurredOn: "2025-03-03", reason: "Retomar os títulos originais" },
          1,
        ),
      )
      assert.equal(check(await get(commissions)).data.openAmount, "-92.00")
      assert.equal(check(await get(receivables)).data.outstandingAmount, "1000.00")
      const adj = check(
        await send(
          commissions + "/adjustments",
          { competence: "2025-03", amount: "100.00", paymentDay: 5, reason: "Ajuste comercial" },
          check(await get(commissions)).data.revision,
        ),
        201,
      )
      const declared = check(
        await send(
          commissions + "/payments",
          { throughCompetence: "2099-03", occurredOn: "2099-03-10", reference: "Pagamento declarado" },
          adj.data.revision,
        ),
      )
      assert.equal(declared.data.paidAmount, "8.00")
      assert.equal(declared.data.openAmount, "0.00")
      assert.equal(check(await get("commissions?offset=1&limit=1")).totals.paidAmount, "8.00")
      assert.equal((await get("orders/" + randomUUID() + "/commission")).statusCode, 404)

      const cancelledOrder = randomUUID(),
        cancelledInvoice = randomUUID()
      await pg.query(
        "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2025-01-10',10000,'draft')",
        [cancelledOrder, tenant],
      )
      await pg.query(
        "INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,1,$3,'PV','Item','UN',1000000,10000,10000)",
        [tenant, cancelledOrder, prodA],
      )
      check(
        await send("orders/" + cancelledOrder + "/commission", { ...terms, usePolicies: true }, 1, randomUUID(), "PUT"),
      )
      check(
        await send(
          commissions + "/policies",
          { productId: prodA, commissionRate: "10.0000", trigger: "invoice" },
          declared.data.revision,
        ),
      )
      await withTenantTransaction(
        pool,
        tenant,
        "operator",
        async (c) =>
          freezeOrderPolicies(
            {
              ...c,
              identity: { subject: "operator", email: "operator@example.test", name: "Operador", emailVerified: true },
            },
            cancelledOrder,
          ),
        true,
      )
      await pg.query("UPDATE sales_orders SET status='accepted' WHERE id=$1", [cancelledOrder])
      await pg.query(
        "INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents) VALUES($1,$2,'production',55,1,1,'{}',$3,10000)",
        [tenant, cancelledInvoice, { sourceOrderId: cancelledOrder }],
      )
      await pg.query(
        "INSERT INTO fiscal_nfe_documents(tenant_id,id,source_order_id,environment,status,series,number,issued_at,random_code,signed_xml,access_key,protocol,authorized_xml) VALUES($1,$2,$3,'production','authorized',1,2,'2025-01-01T00:00:00-03:00','12345679','<xml/>',repeat('2',44),'protocol','<xml/>')",
        [tenant, cancelledInvoice, cancelledOrder],
      )
      const cancelPath = "orders/" + cancelledOrder + "/cancel",
        cancelKey = randomUUID()
      const cancelled = check(await send(cancelPath, {}, 2, cancelKey))
      assert.equal(cancelled.data.status, "cancelled")
      const reconciliation = (
        await pg.query(
          "SELECT summary->'reconciliation'->'commission' AS state FROM sales_order_cancellations WHERE tenant_id=$1 AND order_id=$2",
          [tenant, cancelledOrder],
        )
      ).rows[0].state
      assert.equal(reconciliation.reversedEntries, 1)
      assert.equal(reconciliation.paymentsPreserved, true)
      assert.deepEqual(
        (
          await pg.query(
            "SELECT amount_cents FROM commission_entries WHERE tenant_id=$1 AND order_id=$2 ORDER BY amount_cents",
            [tenant, cancelledOrder],
          )
        ).rows.map((r) => r.amount_cents),
        ["-1000", "1000"],
      )
      await pg.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='finance.commissions.manage'", [
        role,
      ])
      assert.equal((await send(cancelPath, {}, 2, cancelKey)).statusCode, 403)
    } finally {
      await app.close()
      await conn.end()
      await pg.end()
      try {
        await admin.query("DROP DATABASE " + database)
        await admin.query("DROP ROLE IF EXISTS " + dbRole)
      } finally {
        await admin.end()
      }
    }
  },
)
