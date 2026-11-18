import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import test from "node:test"
import Fastify from "fastify"
import { Pool } from "pg"
import { reconcilePayroll } from "../src/modules/finance-wallets/payroll.js"
import { registerFinanceWalletRoutes } from "../src/modules/finance-wallets/routes.js"
import { PgClientAdapter } from "../src/platform/database.js"
import { Problem } from "../src/platform/problem.js"
import { stringifyJson } from "../src/platform/json.js"

test(
  "Carteiras • baixa parcial, estorno, comprovante, comissão e aprovação em PostgreSQL",
  { skip: !process.env.API_TS_TEST_ADMIN_URL },
  async () => {
    const url = new URL(process.env.API_TS_TEST_ADMIN_URL!),
      name = "wallet_" + randomUUID().replaceAll("-", ""),
      role = name + "_app"
    const admin = new Pool({ connectionString: url.toString() })
    await admin.query("CREATE DATABASE " + name)
    url.pathname = "/" + name
    const pg = new Pool({ connectionString: url.toString() }),
      api = new Pool({ connectionString: url.toString() })
    const app = Fastify()
    app.setReplySerializer(stringifyJson)
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof Problem) reply.code(err.status).send(err.toJSON())
      else reply.code(500).send({ error: String(err) })
    })
    try {
      const dir = new URL("../../../migrations/", import.meta.url)
      for (const file of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort())
        await pg.query(await readFile(new URL(file, dir), "utf8"))
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS")
      await pg.query(
        "GRANT USAGE ON SCHEMA public TO " +
          role +
          "; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO " +
          role +
          "; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO " +
          role +
          "; GRANT DELETE ON purchase_order_lines TO " +
          role +
          "; GRANT EXECUTE ON FUNCTION erp_staff_payroll_due_tenants() TO " +
          role,
      )
      const tenant = randomUUID(),
        other = randomUUID(),
        order = randomUUID(),
        receivable = randomUUID(),
        purchase = randomUUID(),
        receipt = randomUUID(),
        payable = randomUUID(),
        staff = randomUUID(),
        request = randomUUID(),
        obligation = randomUUID(),
        salary = randomUUID(),
        account = randomUUID()
      await pg.query(
        "INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa','04252011000110'),($2,'Outra','52998224725')",
        [tenant, other],
      )
      await pg.query(
        "INSERT INTO identities(auth_subject,email,display_name) VALUES('operator','operator@example.test','Operador'),('approver','approver@example.test','Aprovador')",
      )
      const tenantRole = randomUUID()
      await pg.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'wallet','Financeiro')", [
        tenantRole,
        tenant,
      ])
      await pg.query(
        "INSERT INTO role_permissions SELECT $1,code FROM permissions WHERE code LIKE 'finance.%' OR code LIKE 'purchasing.%' OR code IN ('platform.company.manage','inventory.stock.manage')",
        [tenantRole],
      )
      for (const user of ["operator", "approver"]) {
        const m = randomUUID()
        await pg.query(
          "INSERT INTO tenant_memberships(id,tenant_id,identity_id) SELECT $1,$2,id FROM identities WHERE auth_subject=$3",
          [m, tenant, user],
        )
        await pg.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [m, tenantRole])
      }
      await pg.query(
        "INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Parceiro','52998224725',true,true,'active')",
        [tenant],
      )
      await pg.query(
        "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-01',100000,'draft')",
        [order, tenant],
      )
      await pg.query(
        "INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','2027-01-01',100000,'open')",
        [receivable, tenant, order],
      )
      await pg.query(
        "INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Fornecedor','52998224725','2027-01-01',100000,'received')",
        [purchase, tenant],
      )
      await pg.query(
        "INSERT INTO purchase_receipts(id,tenant_id,order_id,reference,occurred_on,amount_cents) VALUES($1,$2,$3,'Recebimento','2027-01-01',100000)",
        [receipt, tenant, purchase],
      )
      await pg.query(
        "INSERT INTO payables(id,tenant_id,receipt_id,supplier_name,due_date,amount_cents) VALUES($1,$2,$3,'Fornecedor','2027-01-01',100000)",
        [payable, tenant, receipt],
      )
      await pg.query(
        "INSERT INTO staff(id,tenant_id,code,name,is_employee,is_seller,status) VALUES($1,$2,'F1','Vendedor',true,true,'active')",
        [staff, tenant],
      )
      await pg.query(
        "INSERT INTO order_commission_terms(tenant_id,order_id,seller_staff_id,seller_name,commission_rate,ipi_rate,payment_day) VALUES($1,$2,$3,'Vendedor',50000,0,5)",
        [tenant, order, staff],
      )
      await pg.query(
        "INSERT INTO staff_payroll_requests(id,tenant_id,staff_id,kind,payload,base_revision,requested_by) VALUES($1,$2,$3,'payment','{}',1,'operator')",
        [request, tenant, staff],
      )
      await pg.query(
        "INSERT INTO staff_payroll_obligations(id,tenant_id,staff_id,source_request_id,competence,kind,category) VALUES($1,$2,$3,$4,'2027-01-01','salary','Salário')",
        [obligation, tenant, staff, request],
      )
      await pg.query(
        "INSERT INTO payables(id,tenant_id,staff_obligation_id,supplier_name,due_date,amount_cents) VALUES($1,$2,$3,'Vendedor','2027-01-01',100000)",
        [salary, tenant, obligation],
      )
      await pg.query(
        "INSERT INTO financial_accounts(id,tenant_id,code,name,status,revision,account_type) VALUES($1,$2,'BANCO','Banco','active',1,'bank')",
        [account, tenant],
      )
      const pool = {
        async connect() {
          const c = await api.connect()
          await c.query("SET ROLE " + role)
          return new PgClientAdapter(c)
        },
      }
      registerFinanceWalletRoutes(app, {
        pool,
        userinfoUrl: "http://auth.test/userinfo",
        fetchAuth: async (_url, init) => {
          const sub = new Headers(init?.headers).get("authorization")!.slice(7)
          return Response.json({ sub, email: sub + "@example.test", name: sub, email_verified: true })
        },
      })
      const headers = { authorization: "Bearer operator", "x-tenant-id": tenant }
      const send = (url: string, payload: object, revision: number, key = randomUUID(), user = "operator") =>
        app.inject({
          method: "POST",
          url,
          payload,
          headers: { ...headers, authorization: "Bearer " + user, "if-match": `"${revision}"`, "idempotency-key": key },
        })
      const payment = {
        amount: "400.00",
        interestAmount: "10.00",
        method: "bank_transfer",
        reference: "Conferência",
        occurredOn: "2027-01-02",
        financialAccountId: account,
      }
      const proof = {
        filename: "prova.pdf",
        mediaType: "application/pdf",
        description: "Comprovante de teste",
        contentBase64: Buffer.from("%PDF-wallet").toString("base64"),
        documentDate: "2027-01-02",
      }
      for (const [wallet, id] of [
        ["receivables", receivable],
        ["financial-payables", payable],
      ] as const) {
        const path = "/api/v1/" + wallet + "/" + id,
          input = { ...payment, supportingDocument: proof }
        assert.equal((await send(path + "/payments", { ...input, financialAccountId: null }, 1)).statusCode, 422)
        const key = randomUUID()
        const [first, again] = await Promise.all([
          send(path + "/payments", input, 1, key),
          send(path + "/payments", input, 1, key),
        ])
        assert.equal(first.statusCode, 200, first.body)
        assert.equal(again.statusCode, 200, again.body)
        assert.deepEqual(first.json(), again.json())
        const body = first.json(),
          p = body.payments[0]
        assert.equal(body.data.outstandingAmount, "600.00")
        if (wallet === "financial-payables") {
          assert.equal(p.proofName, proof.filename)
          assert.equal(
            (await app.inject({ url: p.proofPath.replace("/api/erp/", "/api/v1/"), headers })).body,
            "%PDF-wallet",
          )
        }
        assert.equal(p.netAmount, "410.00")
        assert.equal(p.interestAmount, "10.00")
        assert.ok(p.natureId)
        const ledger = (
          await pg.query("SELECT amount_cents,direction FROM financial_account_entries WHERE id=$1", [p.accountEntryId])
        ).rows[0]
        assert.deepEqual(ledger, { amount_cents: "41000", direction: wallet === "receivables" ? "credit" : "debit" })
        assert.equal((await send(path + "/payments", input, 1)).statusCode, 412)
        const reversal = { paymentId: p.id, reason: "Conferência estornada", occurredOn: "2027-01-03" },
          rk = randomUUID()
        const undone = await send(path + "/reverse-payment", reversal, 2, rk)
        assert.equal(undone.statusCode, 200, undone.body)
        assert.deepEqual(undone.json(), (await send(path + "/reverse-payment", reversal, 2, rk)).json())
        assert.equal(undone.json().data.outstandingAmount, "1000.00")
        const inverse = (
          await pg.query("SELECT amount_cents,direction FROM financial_account_entries WHERE id=$1", [
            undone.json().payments[1].accountEntryId,
          ])
        ).rows[0]
        assert.deepEqual(inverse, { amount_cents: "41000", direction: wallet === "receivables" ? "debit" : "credit" })
      }
      assert.deepEqual(
        (
          await pg.query("SELECT amount_cents FROM commission_entries WHERE tenant_id=$1 ORDER BY amount_cents", [
            tenant,
          ])
        ).rows.map((x) => x.amount_cents),
        ["-2000", "2000"],
      )
      const documents = (await app.inject({ url: "/api/v1/orders/" + order + "/documents", headers })).json().data
      assert.equal(documents.length, 1)
      assert.equal(
        (await app.inject({ url: "/api/v1/orders/" + order + "/documents/" + documents[0].id, headers })).body,
        "%PDF-wallet",
      )
      assert.equal((await app.inject({ url: "/api/v1/orders/" + order + "/finance", headers })).json().state, "open")
      assert.equal((await app.inject({ url: "/api/v1/payables/" + salary, headers })).statusCode, 404)
      assert.equal(
        (await app.inject({ url: "/api/v1/financial-payables/" + salary, headers })).json().data.staffId,
        staff,
      )
      assert.equal(
        (await app.inject({ url: "/api/v1/receivables/" + receivable, headers: { ...headers, "x-tenant-id": other } }))
          .statusCode,
        403,
      )
      const batchPath = "/api/v1/financial-payables/payment-batches"
      const batchItem = (id: string, revision: number) => ({
        id,
        revision,
        payment: { ...payment, amount: "10.00", interestAmount: "0.00" },
      })
      const staleBatch = await send(batchPath, { items: [batchItem(payable, 3), batchItem(salary, 2)] }, 1)
      assert.equal(staleBatch.statusCode, 412, staleBatch.body)
      assert.equal(
        (await app.inject({ url: "/api/v1/financial-payables/" + payable, headers })).json().data.revision,
        3,
      )
      const batchKey = randomUUID(),
        batchInput = { items: [batchItem(payable, 3), batchItem(salary, 1)] }
      const batch = await send(batchPath, batchInput, 1, batchKey)
      assert.equal(batch.statusCode, 200, batch.body)
      assert.equal(batch.json().data.length, 2)
      assert.deepEqual(batch.json(), (await send(batchPath, batchInput, 1, batchKey)).json())
      for (const item of batch.json().data) {
        const reverse = await send(
          "/api/v1/financial-payables/" + item.id + "/reverse-payment",
          { paymentId: item.paymentId, reason: "Estornar lote", occurredOn: "2027-01-03" },
          item.revision,
        )
        assert.equal(reverse.statusCode, 200, reverse.body)
      }
      const center = await send("/api/v1/financial-cost-centers", { code: "OP", name: "Operação", status: "active" }, 1)
      assert.equal(center.statusCode, 201, center.body)
      const category = (await app.inject({ url: "/api/v1/receivables/" + receivable, headers })).json().data.natureId
      const classified = await app.inject({
        method: "PUT",
        url: "/api/v1/receivables/" + receivable + "/classification",
        headers: { ...headers, "if-match": '"3"', "idempotency-key": randomUUID() },
        payload: {
          natureId: category,
          costCenterId: center.json().data.id,
          forecastAccountId: account,
          competenceOn: "2026-12-01",
        },
      })
      assert.equal(classified.statusCode, 200, classified.body)
      assert.equal(classified.json().data.forecastAccountId, account)
      const product = randomUUID()
      await pg.query(
        "INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'PROD','Produto','UN',10000,'active')",
        [product, tenant],
      )
      const orderInput = {
          supplierId: tenant,
          dueDate: "2027-01-01",
          items: [{ productId: product, quantity: "1.000000", unitCost: "1000.00" }],
        },
        orderKey = randomUUID(),
        ordersPath = "/api/v1/purchase-orders"
      const draft = await send(ordersPath, orderInput, 1, orderKey)
      assert.equal(draft.statusCode, 201, draft.body)
      assert.deepEqual(draft.json(), (await send(ordersPath, orderInput, 1, orderKey)).json())
      const purchase2 = draft.json().data.id,
        details = ordersPath + "/" + purchase2
      const changed = await app.inject({
        method: "PUT",
        url: details,
        headers: { ...headers, "if-match": '"1"' },
        payload: orderInput,
      })
      assert.equal(changed.statusCode, 200, changed.body)
      assert.equal((await app.inject({ url: ordersPath, headers })).json().data[0].id, purchase2)
      const fiscalDraft = await send(ordersPath, orderInput, 1),
        fiscalOrder = fiscalDraft.json().data.id
      const keyNfe = "35261004252011000110550010000000011000000017",
        monitorRun = randomUUID()
      const fisc = await pg.query(
        `INSERT INTO fiscal_received_nfes(tenant_id,access_key,issuer_document,issuer_name,recipient_document,number,series,issued_at,total_cents,item_count,environment,xml,xml_sha256,imported_by_identity_id)
        SELECT $1,$2,'04252011000110','Emitente','04252011000110',1,1,now(),100000,1,1,'<nfe/>',repeat('a',64),id FROM identities WHERE auth_subject='operator' RETURNING id`,
        [tenant, keyNfe],
      )
      await pg.query(
        "INSERT INTO fiscal_received_purchase_links(tenant_id,received_nfe_id,purchase_order_id,supplier_id) VALUES($1,$2,$3,$1)",
        [tenant, fisc.rows[0].id, fiscalOrder],
      )
      await pg.query(
        "INSERT INTO fiscal_monitor_runs(id,tenant_id,command_key,auth_subject,cursor_before) VALUES($1,$2,$3,'operator','000000000000000')",
        [monitorRun, tenant, randomUUID()],
      )
      const envelope = (code: string) =>
        `<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe"><evento><infEvento Id="ID110111${keyNfe}01"><tpAmb>1</tpAmb><CNPJ>04252011000110</CNPJ><chNFe>${keyNfe}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento></infEvento></evento><retEvento><infEvento><tpAmb>1</tpAmb><chNFe>${keyNfe}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><cStat>${code}</cStat><nProt>135260000000001</nProt></infEvento></retEvento></procEventoNFe>`
      const eventSql =
        "INSERT INTO fiscal_monitor_documents(tenant_id,run_id,nsu,schema,kind,xml,xml_sha256) VALUES($1,$2,$3,'procEventoNFe','event',$4,repeat('a',64))"
      await pg.query(eventSql, [tenant, monitorRun, "000000000000001", envelope("135")])
      const blocked = await send(ordersPath + "/" + fiscalOrder + "/confirm", {}, 1)
      assert.equal(blocked.statusCode, 409, blocked.body)
      assert.match(blocked.body, /cancelamento autorizado/)
      const confirmed = await send(details + "/confirm", {}, 2)
      assert.equal(confirmed.statusCode, 200, confirmed.body)
      assert.equal(confirmed.json().data.status, "confirmed")
      const receivePath = "/api/v1/purchase-orders/" + purchase2 + "/receipts",
        receiveKey = randomUUID(),
        items = {
          reference: "Recebimento verificado",
          occurredOn: "2027-01-01",
          items: [{ productId: product, quantity: "1.000000" }],
        }
      const arrived = await send(receivePath, items, 3, receiveKey)
      assert.equal(arrived.statusCode, 201, arrived.body)
      assert.deepEqual(arrived.json(), (await send(receivePath, items, 3, receiveKey)).json())
      const sourced = await send("/api/v1/financial-payables/" + arrived.json().payableId + "/payments", payment, 1)
      assert.equal(sourced.statusCode, 200, sourced.body)
      const reversedReceipt = await send(
        "/api/v1/purchase-receipts/" + arrived.json().receipt.data.id + "/reverse",
        { reason: "Estorno integral da compra de teste", occurredOn: "2027-01-03" },
        4,
      )
      assert.equal(reversedReceipt.statusCode, 200, reversedReceipt.body)
      assert.equal(reversedReceipt.json().data.paymentReversalIds.length, 1)
      assert.equal(
        (
          await pg.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2", [
            tenant,
            product,
          ])
        ).rows[0].quantity_micros,
        "0",
      )
      assert.equal(
        (await app.inject({ url: "/api/v1/financial-payables/" + arrived.json().payableId, headers })).json().data
          .status,
        "cancelled",
      )
      const staffPath = "/api/v1/staff/" + staff + "/payroll"
      const requestPay = await send(
        staffPath + "/requests",
        { kind: "payment", payment: { amount: "300.00", dueDate: "2027-01-20", category: "Benefício", note: "Vale" } },
        1,
      )
      assert.equal(requestPay.statusCode, 201, requestPay.body)
      const review = await send(
        "/api/v1/staff-payroll/requests/" + requestPay.json().id + "/review",
        { approve: true, reason: "Benefício conferido" },
        1,
        randomUUID(),
        "approver",
      )
      assert.equal(review.statusCode, 200, review.body)
      const payroll = (await app.inject({ url: staffPath, headers })).json()
      assert.ok(
        payroll.payments.some(
          (p: { category: string; amount: string }) => p.category === "Benefício" && p.amount === "300.00",
        ),
      )
      const recurringStaff = randomUUID(),
        recurringRequest = randomUUID(),
        profile = {
          salary: "2400.00",
          pixType: "",
          pixKey: "",
          bank: "",
          branch: "",
          account: "",
          recurring: true,
          businessDay: 5,
          startsOn: "2025-01-01",
          excludedDates: [],
        }
      await pg.query(
        "INSERT INTO staff(id,tenant_id,code,name,is_employee,is_seller,status) VALUES($1,$2,'F2','Recorrência',true,false,'active')",
        [recurringStaff, tenant],
      )
      await pg.query(
        "INSERT INTO staff_payroll_requests(id,tenant_id,staff_id,kind,payload,base_revision,status,requested_by,reviewed_by,review_reason,reviewed_at) VALUES($1,$2,$3,'settings',$4,0,'approved','operator','approver','Configuração aprovada',now())",
        [recurringRequest, tenant, recurringStaff, profile],
      )
      await pg.query("INSERT INTO staff_payroll_profiles(tenant_id,staff_id,revision,settings) VALUES($1,$2,1,$3)", [
        tenant,
        recurringStaff,
        profile,
      ])
      assert.deepEqual((await Promise.all([reconcilePayroll(pool), reconcilePayroll(pool)])).sort(), [0, 1])
      assert.equal(
        (await app.inject({ url: "/api/v1/staff/" + recurringStaff + "/payroll", headers })).json().payments[0].amount,
        "2400.00",
      )
      const settings = (await app.inject({ url: "/api/v1/financial-wallet-settings", headers })).json()
      const prefs = await app.inject({
        method: "PUT",
        url: "/api/v1/financial-wallet-settings",
        headers: { ...headers, "if-match": '"1"' },
        payload: { ...settings.data, paymentApprovalLimit: "100.00", restructureApprovalLimit: "0.00" },
      })
      assert.equal(prefs.statusCode, 200, prefs.body)
      const olderClient = { ...settings.data, paymentApprovalLimit: "100.00" }
      delete olderClient.restructureApprovalLimit
      const keep = await app.inject({
        method: "PUT",
        url: "/api/v1/financial-wallet-settings",
        headers: { ...headers, "if-match": '"2"' },
        payload: olderClient,
      })
      assert.equal(keep.statusCode, 200, keep.body)
      assert.equal(keep.json().data.restructureApprovalLimit, "0.00")
      const prefsKey = randomUUID(),
        prefsHeaders = { ...headers, "if-match": '"3"', "idempotency-key": prefsKey },
        lateSettings = {
          ...keep.json().data,
          interestMonthlyBps: 300,
          penaltyBps: 200,
          graceDays: 0,
          requireCostCenter: true,
          defaultCostCenterId: center.json().data.id,
        }
      const updated = await app.inject({
        method: "PUT",
        url: "/api/v1/financial-wallet-settings",
        headers: prefsHeaders,
        payload: lateSettings,
      })
      assert.equal(updated.statusCode, 200, updated.body)
      assert.deepEqual(
        updated.json(),
        (
          await app.inject({
            method: "PUT",
            url: "/api/v1/financial-wallet-settings",
            headers: prefsHeaders,
            payload: lateSettings,
          })
        ).json(),
      )
      const overdue = await send(
        "/api/v1/receivables/" + receivable + "/payments",
        {
          amount: "400.00",
          method: "bank_transfer",
          reference: "Baixa com encargos automáticos",
          occurredOn: "2027-01-31",
          financialAccountId: account,
        },
        4,
      )
      assert.equal(overdue.statusCode, 200, overdue.body)
      const overdueLine = overdue.json().payments.at(-1)
      assert.equal(overdueLine.interestAmount, "12.00")
      assert.equal(overdueLine.penaltyAmount, "8.00")
      assert.equal(overdueLine.netAmount, "420.00")
      assert.equal(overdueLine.costCenterId, center.json().data.id)
      const title = "/api/v1/financial-payables/" + salary,
        full = { ...payment, amount: "1000.00", penaltyAmount: "0.00", discountAmount: "10.00" }
      assert.equal((await send(title + "/payments", full, 3)).statusCode, 409)
      const pending = await send(title + "/approvals", full, 3)
      assert.equal(pending.statusCode, 201, pending.body)
      const approvalId = pending.json().data.id,
        decision = { decision: "approved", reason: "Valores conferidos" }
      assert.equal((await send(title + "/approvals/" + approvalId + "/decision", decision, 3)).statusCode, 409)
      const approved = await send(
        title + "/approvals/" + approvalId + "/decision",
        decision,
        3,
        randomUUID(),
        "approver",
      )
      assert.equal(approved.statusCode, 200, approved.body)
      assert.equal((await send(title + "/payments", { ...full, amount: "900.00", approvalId }, 3)).statusCode, 409)
      const paid = await send(title + "/payments", { ...full, approvalId }, 3)
      assert.equal(paid.statusCode, 200, paid.body)
      assert.equal(paid.json().data.status, "paid")
      assert.equal(paid.json().payments.at(-1).netAmount, "1000.00")
    } finally {
      await app.close()
      await api.end()
      await pg.end()
      try {
        await admin.query("DROP DATABASE " + name)
        await admin.query("DROP ROLE IF EXISTS " + role)
      } finally {
        await admin.end()
      }
    }
  },
)
