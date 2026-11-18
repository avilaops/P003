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
  async () => {
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

      await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='finance.receivables.read'", [role])
      const restricted = await app.inject({ method: "GET", url: "/api/v1/finance/portfolio", headers })
      assert.equal(restricted.json().total, 0)
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
