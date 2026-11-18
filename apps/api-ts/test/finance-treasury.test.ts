import assert from "node:assert/strict"
import { createHmac, randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { createServer } from "node:http"
import { Pool } from "pg"
import { buildApp } from "../src/app.js"
import { PostgresPool, withTenantTransaction } from "../src/platform/database.js"
import { getCharge, observePayment, reserveCharge } from "../src/modules/finance-treasury/collections.js"
import {
  checkSignature,
  getPayment,
  issue,
  merchants,
  settlementReport,
  type BankPayment,
} from "../src/modules/finance-treasury/mercadopago.js"
import { parseEfiStatement } from "../src/modules/finance-treasury/efi-cnab.js"
import { parseOfx } from "../src/modules/finance-treasury/ofx.js"

test("production connection requires a distinct bank account and explicit deployment activation",()=>{
  const tenantId=randomUUID(),accountId=randomUUID()
  const previous=Object.fromEntries(["FINANCE_MP_CONNECTIONS","FINANCE_MP_ENABLE_PRODUCTION","FINANCE_MP_FIXTURE_TOKEN","FINANCE_MP_FIXTURE_WEBHOOK"].map(k=>[k,process.env[k]]))
  try {
    const item={tenantId,accountId,collectorId:"771",subject:"fixture",mode:"production",enabled:true,tokenEnv:"FINANCE_MP_FIXTURE_TOKEN",webhookEnv:"FINANCE_MP_FIXTURE_WEBHOOK"}
    Object.assign(process.env,{FINANCE_MP_CONNECTIONS:JSON.stringify([item]),FINANCE_MP_FIXTURE_TOKEN:"fixture-token-000000",FINANCE_MP_FIXTURE_WEBHOOK:"fixture-hook-000000"})
    delete process.env.FINANCE_MP_ENABLE_PRODUCTION
    assert.equal(merchants().find(c=>c.accountId===accountId),undefined)
    process.env.FINANCE_MP_ENABLE_PRODUCTION="true"
    assert.equal(merchants().find(c=>c.accountId===accountId)?.live,true)
    process.env.FINANCE_MP_CONNECTIONS=JSON.stringify([item,{...item,mode:"sandbox"}])
    assert.throws(()=>merchants(),/mais de um vínculo/)
  } finally {for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value}}
})

const ofx =
  "<OFX><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>364<ACCTID>12345</BANKACCTFROM><BANKTRANLIST><DTEND>20260131<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260130<TRNAMT>100.00<FITID>A-1<NAME>Depósito</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>100.00<DTASOF>20260131</LEDGERBAL></STMTRS></OFX>"
test("Mercado Pago adapter checks merchant before issuing, sends the persistent idempotency key, and verifies retrieved payment", async () => {
  const config = {
    tenantId: randomUUID(),
    accountId: randomUUID(),
    collectorId: "44",
    live: false,
    subject: "treasury",
    accessToken: "local-test-access",
    webhookSecret: "local-test-secret",
  }
  const reference = randomUUID(),
    request = { transaction_amount: 100, payment_method_id: "pix", external_reference: reference }
  let testSeller = true,
    live = false,
    posts = 0
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json")
    if (req.headers.authorization !== "Bearer local-test-access") {
      res.writeHead(401).end("{}")
      return
    }
    if (req.url === "/users/me") {
      res.end(JSON.stringify({ id: 44, tags: testSeller ? ["test_user"] : [], site_id: "MLB" }))
      return
    }
    if (req.url?.startsWith("/v1/payments/search?")) {
      const ref = new URL(req.url, "http://localhost").searchParams.get("external_reference")
      if (ref !== reference) {
        res.writeHead(400).end("{}")
        return
      }
      res.end(JSON.stringify({ results: posts ? [{ id: 123, external_reference: reference }] : [] }))
      return
    }
    if (req.method === "POST") {
      posts++
      const chunks = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      if (
        req.url !== "/v1/payments" ||
        req.headers["x-idempotency-key"] !== reference ||
        JSON.stringify(JSON.parse(Buffer.concat(chunks).toString())) !== JSON.stringify(request)
      ) {
        res.writeHead(400).end("{}")
        return
      }
    } else if (req.url !== "/v1/payments/123") {
      res.writeHead(404).end("{}")
      return
    }
    res.end(
      JSON.stringify({ ...request, id: 123, live_mode: live, collector_id: 44, currency_id: "BRL", status: "pending" }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === "object")
    const transport: typeof fetch = async (url, init) => {
      const remote = new URL(String(url))
      assert.ok(["api.mercadolibre.com", "api.mercadopago.com"].includes(remote.hostname))
      return fetch("http://127.0.0.1:" + address.port + remote.pathname + remote.search, init)
    }
    assert.equal((await issue(config, request, reference, transport)).id, "123")
    assert.equal((await issue(config, request, reference, transport)).id, "123")
    assert.equal((await getPayment(config, "123", transport)).status, "pending")
    testSeller = false
    await assert.rejects(() => issue(config, request, reference, transport), /vendedor e o ambiente/)
    assert.equal(posts, 1)
    live = true
    await assert.rejects(() => getPayment(config, "123", transport), /ambiente vinculados/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
})
test("OFX, Efí CNAB 240 and signed Mercado Pago notifications validate fixed fields and account identity", () => {
  assert.equal(parseOfx(ofx).lines[0]!.signedCents, 10000n)
  assert.throws(() => parseOfx(ofx.replace("20260130", "20260231")))
  const record = (fields: [number, string][]) => {
    const row = Array<string>(240).fill(" ")
    for (const [offset, value] of fields) row.splice(offset - 1, value.length, ...value)
    return row.join("")
  }
  const account = "00001" + " " + "000000012345" + "6" + " "
  const cnab = [
    record([[1, "36400000"]]),
    record([
      [1, "36400011E0400033"],
      [53, account],
      [143, "01012026"],
      [151, "000000000000000000C"],
    ]),
    record([
      [1, "3640001300001E"],
      [53, account],
      [143, "30012026"],
      [151, "000000000000010000C"],
      [177, "CREDITO"],
      [202, "2026-1"],
    ]),
    record([
      [1, "36400015"],
      [53, account],
      [143, "31012026"],
      [151, "000000000000010000C"],
      [171, "000003"],
    ]),
    record([
      [1, "36499999"],
      [18, "000001000005"],
    ]),
  ].join("\r\n")
  assert.deepEqual(
    parseEfiStatement(cnab).lines.map((v) => v.signedCents),
    [10000n],
  )
  assert.throws(() => parseEfiStatement(cnab.replace("000001000005", "000001000006")))
  const cfg = {
    tenantId: randomUUID(),
    accountId: randomUUID(),
    collectorId: "44",
    subject: "pilot",
    accessToken: "test",
    webhookSecret: "test-secret",
    live: false,
  }
  const now = 1700000000000,
    ts = now / 1000
  const hex = createHmac("sha256", cfg.webhookSecret)
    .update("id:123;request-id:abc;ts:" + ts + ";")
    .digest("hex")
  checkSignature(cfg, "ts=" + ts + ",v1=" + hex, "abc", "123", now)
  assert.throws(() => checkSignature(cfg, "ts=" + ts + ",v1=" + hex, "abc", "124", now))
  const csv =
    "EXTERNAL_REFERENCE;SOURCE_ID;USER_ID;TRANSACTION_TYPE;TRANSACTION_AMOUNT;TRANSACTION_CURRENCY;SETTLEMENT_NET_AMOUNT\r\nref;123;44;SETTLEMENT;100.00;BRL;98.00"
  assert.equal(settlementReport(csv, "44")[0]!.net, "98.00")
  assert.throws(() => settlementReport(csv, "99"))
})

test(
  "PostgreSQL treasury handles duplicate files, grouped matching, account locks and a single settlement across banking channels",
  { skip: !process.env.API_TS_TEST_ADMIN_URL },
  async () => {
    const url = new URL(process.env.API_TS_TEST_ADMIN_URL!),
      name = "finance_treasury_" + randomUUID().replaceAll("-", ""),
      admin = new Pool({ connectionString: url.toString() })
    await admin.query("CREATE DATABASE " + name)
    url.pathname = "/" + name
    const seed = new Pool({ connectionString: url.toString() }),
      pool = new PostgresPool(url.toString(), 3)
    const subject = "treasury-test",
      tenant = randomUUID(),
      account = randomUUID(),
      target = randomUUID(),
      user = randomUUID(),
      membership = randomUUID(),
      role = randomUUID(),
      party = randomUUID()
    const app = buildApp({
      pool,
      userinfoUrl: "https://example.test/auth",
      fetchAuth: async () => Response.json({ sub: subject, email: "tesouraria@example.test" }),
    })
    const headers = { authorization: "Bearer local", "x-tenant-id": tenant }
    const post = async (path: string, body: object, status = 201, key = randomUUID()) => {
      const result = await app.inject({
        method: "POST",
        url: "/api/v1/" + path,
        headers: { ...headers, "idempotency-key": key },
        payload: body,
      })
      assert.equal(result.statusCode, status, result.body)
      return result.json()
    }
    const config: Record<string, string> = {
      FINANCE_MP_SANDBOX_TENANT_ID: tenant,
      FINANCE_MP_SANDBOX_ACCOUNT_ID: account,
      FINANCE_MP_SANDBOX_COLLECTOR_ID: "44",
      FINANCE_MP_SANDBOX_ACCESS_TOKEN: "placeholder-only-local-fixture",
      FINANCE_MP_SANDBOX_WEBHOOK_SECRET: "placeholder-only-local-fixture",
      FINANCE_MP_SANDBOX_SUBJECT: subject,
    }
    const original = Object.fromEntries(Object.keys(config).map((k) => [k, process.env[k]]))
    try {
      const dir = new URL("../../../migrations/", import.meta.url)
      for (const f of (await readdir(dir)).filter((s) => s.endsWith(".sql")).sort())
        await seed.query(await readFile(new URL(f, dir), "utf8"))
      await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Piloto','04252011000110')", [tenant])
      await seed.query(
        "INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,$2,'tesouraria@example.test','Financeiro')",
        [user, subject],
      )
      await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [
        membership,
        tenant,
        user,
      ])
      await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'treasury','Tesouraria')", [
        role,
        tenant,
      ])
      await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, role])
      await seed.query(
        "INSERT INTO role_permissions(role_id,permission_code) SELECT $1,code FROM permissions WHERE code LIKE 'finance.%'",
        [role],
      )
      await seed.query(
        "INSERT INTO financial_accounts(id,tenant_id,code,name,status,account_type,account_number,revision) VALUES($1,$2,'TEST','Conta','active','bank','12345',1),($3,$2,'CX','Caixa','active','cash',null,1)",
        [account, tenant, target],
      )
      const entry = {
        accountId: account,
        description: "Parcela de teste",
        direction: "credit",
        occurredOn: "2026-01-30",
        amount: "60.00",
      }
      const same = randomUUID(),
        first = await post("financial-account-entries", entry, 201, same),
        replay = await post("financial-account-entries", entry, 201, same)
      assert.equal(first.data.id, replay.data.id)
      const second = await post("financial-account-entries", { ...entry, amount: "40.00" })
      const imported = await post("finance-treasury/import-ofx", { accountId: account, content: ofx })
      assert.equal(imported.data.imported, 1)
      assert.equal(
        (await post("finance-treasury/import-ofx", { accountId: account, content: ofx })).data.duplicate,
        true,
      )
      assert.equal(
        (await post("finance-treasury/import-ofx", { accountId: account, content: ofx + "\n" })).data.imported,
        0,
      )
      await post(
        "finance-treasury/import-ofx",
        { accountId: account, content: ofx.replace("100.00<FITID", "105.00<FITID") },
        409,
      )
      const period = { accountId: account, throughDate: "2026-01-31", reason: "Conferência final" }
      await post("finance-treasury/close-period", period, 409)
      const reconciliation = await app.inject({
        method: "GET",
        url: "/api/v1/finance-treasury/reconciliation?accountId=" + account,
        headers,
      })
      assert.equal(reconciliation.statusCode, 200, reconciliation.body)
      const line = reconciliation.json().data.lines[0]
      await post("finance-treasury/match", { accountId: account, lineId: line.id, entryIds: [first.data.id] }, 409)
      await post("finance-treasury/match", {
        accountId: account,
        lineId: line.id,
        entryIds: [first.data.id, second.data.id],
      })
      await post("finance-treasury/close-period", period)
      await post("financial-account-entries", entry, 409)
      await assert.rejects(
        seed.query(
          "INSERT INTO financial_account_entries(id,tenant_id,account_id,direction,amount_cents,occurred_on,description) VALUES(gen_random_uuid(),$1,$2,'credit',1,'2026-01-01','Teste')",
          [tenant, account],
        ),
        /fechado/,
      )
      await seed.query(
        "DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='finance.reconciliation.reopen'",
        [role],
      )
      await post("finance-treasury/reopen-period", period, 403)
      await seed.query(
        "INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'finance.reconciliation.reopen')",
        [role],
      )
      await post("finance-treasury/reopen-period", period)
      const tx = await post("financial-account-transfers", {
        sourceAccountId: account,
        targetAccountId: target,
        amount: "20.00",
        occurredOn: "2026-01-31",
        description: "Entre contas",
      })
      assert.equal(
        (
          await seed.query(
            "SELECT sum(CASE direction WHEN 'credit' THEN amount_cents ELSE -amount_cents END) net FROM financial_account_entries WHERE transfer_id=$1",
            [tx.transferId],
          )
        ).rows[0].net,
        "0",
      )
      await seed.query(
        "INSERT INTO pos_sessions(tenant_id,id,register,cash_account_id,opening_cents,opened_by) VALUES($1,gen_random_uuid(),'Principal',$2,0,$3)",
        [tenant, target, subject],
      )
      await post("financial-account-entries", { ...entry, accountId: target }, 409)
      Object.assign(process.env, config)
      await seed.query(
        "INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status,email) VALUES($1,$2,'fisica','Cliente Teste','52998224725',true,false,'active','test_user_br@testuser.com')",
        [party, tenant],
      )
      const orders = await seed.query(
        "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) SELECT gen_random_uuid(),$1,$2,'Teste','52998224725','2027-01-20',5000,'completed' FROM generate_series(1,2) RETURNING id",
        [tenant, party],
      )
      const titles = await seed.query(
        "INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) SELECT gen_random_uuid(),$1,id,'Teste','2027-01-20',5000,'open' FROM unnest($2::uuid[]) id RETURNING id",
        [tenant, orders.rows.map((r) => r.id)],
      )
      const ids = titles.rows.map((r) => String(r.id))
      const groupId=randomUUID()
      await seed.query("INSERT INTO finance_operations(id,tenant_id,kind,side,party_id,occurred_on,due_on,reason,principal_cents) VALUES($1,$2,'billing_group','receivable',$3,'2026-02-01','2027-03-01','Agrupamento de teste',10000)",[groupId,tenant,party])
      await seed.query("INSERT INTO finance_operation_items(id,tenant_id,operation_id,receivable_id,principal_cents) SELECT gen_random_uuid(),$1,$2,id,5000 FROM unnest($3::uuid[]) id",[tenant,groupId,ids])
      const charge = await withTenantTransaction(
        pool,
        tenant,
        subject,
        async (context) =>
          reserveCharge(
            { ...context, identity: { subject, email: "", name: "", emailVerified: false } },
            {},
            { accountId: account, receivableIds: ids, groupId, billingType: "PIX" },
            randomUUID(),
          ),
        true,
      )
      const feeExpense=randomUUID(),feeBank=randomUUID()
      await seed.query("INSERT INTO accounting_accounts(tenant_id,id,code,name,classification) VALUES($1,$2,'4.01','Tarifas','expense'),($1,$3,'1.01','Banco','asset')",[tenant,feeExpense,feeBank])
      await seed.query("INSERT INTO accounting_rules(tenant_id,event_type,debit_id,credit_id) VALUES($1,'collection.fee',$2,$3)",[tenant,feeExpense,feeBank])
      const payment: BankPayment = {
        id: "1234",
        live_mode: false,
        collector_id: "44",
        currency_id: "BRL",
        external_reference: charge,
        status: "approved",
        payment_method_id: "pix",
        transaction_amount: 100,
        date_approved: "2026-02-01T12:00:00-03:00",
        transaction_details: { net_received_amount: 98 },
      }
      for (const [channel, event] of [
        ["webhook", "1"],
        ["report", "1234"],
        ["webhook", "1"],
      ] as const)
        await withTenantTransaction(
          pool,
          tenant,
          subject,
          async (context) => {
            const ctx = { ...context, identity: { subject, email: "", name: "", emailVerified: false } }
            const result = await observePayment(ctx, {}, await getCharge(ctx, charge), payment, channel, event)
            assert.equal(result.state, "paid")
          },
          true,
        )
      const fees=await seed.query(`SELECT j.debit_id,j.credit_id,j.amount_cents,e.document_type,e.document_id,e.source_id
        FROM accounting_events e JOIN accounting_entries j ON j.tenant_id=e.tenant_id AND j.event_id=e.id
        WHERE e.tenant_id=$1 AND e.event_type='collection.fee'`,[tenant])
      const bankFee=(await seed.query("SELECT fee_entry_id FROM finance_collection_charges WHERE tenant_id=$1 AND id=$2",[tenant,charge])).rows[0]
      assert.deepEqual(fees.rows,[{debit_id:feeExpense,credit_id:feeBank,amount_cents:"200",document_type:"account",document_id:account,source_id:bankFee.fee_entry_id}])
      assert.equal(
        (await seed.query("SELECT count(*)::int n FROM receivable_payments WHERE receivable_id=ANY($1::uuid[])", [ids]))
          .rows[0].n,
        2,
      )
      assert.equal(
        (
          await seed.query(
            "SELECT sum(CASE direction WHEN 'credit' THEN amount_cents ELSE -amount_cents END)::text net FROM financial_account_entries WHERE reference='Mercado Pago • 1234'",
          )
        ).rows[0].net,
        "9800",
      )
      const bankFile=(fit:string,amount:string)=>ofx.replaceAll("202601","202803").replace("A-1",fit).replace("<TRNAMT>100.00","<TRNAMT>"+amount)
      const later={...entry,occurredOn:"2028-03-30"}
      await post("financial-account-entries",{...later,amount:"70.00"})
      const unique=await post("finance-treasury/import-ofx",{accountId:account,content:bankFile("AUTO1","70.00"),autoMatch:true})
      assert.equal(unique.data.matched,1)
      await post("financial-account-entries",{...later,amount:"65.00"})
      await post("financial-account-entries",{...later,amount:"65.00"})
      const ambiguous=await post("finance-treasury/import-ofx",{accountId:account,content:bankFile("AUTO2","65.00"),autoMatch:true})
      assert.equal(ambiguous.data.matched,0)
      await post("finance-treasury/import-ofx",{accountId:account,content:bankFile("TARIFA","-3.00"),autoMatch:true})
      const unclassified=(await seed.query("SELECT id FROM finance_bank_lines WHERE tenant_id=$1 AND fit_id='TARIFA'",[tenant])).rows[0]!
      const key=randomUUID(), detail={accountId:account,lineId:unclassified.id,reason:"Tarifa identificada"}
      const classified=await post("finance-treasury/classify-movement",detail,201,key)
      assert.deepEqual((await post("finance-treasury/classify-movement",detail,201,key)).data,classified.data)
      await post("finance-treasury/classify-movement",detail,409)
      const movement=(await seed.query("SELECT direction,amount_cents,category_id FROM financial_account_entries WHERE tenant_id=$1 AND reference=$2",[tenant,unclassified.id])).rows
      assert.equal(movement.length,1)
      assert.equal(movement[0].direction,"debit")
      assert.equal(movement[0].amount_cents,"300")
      assert.ok(movement[0].category_id)
    } finally {
      for (const [key, v] of Object.entries(original)) {
        if (v === undefined) delete process.env[key]
        else process.env[key] = v
      }
      await app.close()
      await pool.close()
      await seed.end()
      try {
        await admin.query("DROP DATABASE " + name)
      } finally {
        await admin.end()
      }
    }
  },
)
