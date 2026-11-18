import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import Fastify from "fastify"
import { Pool } from "pg"
import { registerPosSessionRoutes } from "../src/modules/pos-sessions/routes.js"
import { PgClientAdapter } from "../src/platform/database.js"
import { Problem } from "../src/platform/problem.js"
import { stringifyJson } from "../src/platform/json.js"

test(
  "Caixa físico • abertura, vendas existentes, transferências, estorno e conferência",
  { skip: !process.env.API_TS_TEST_ADMIN_URL },
  async () => {
    const url = new URL(process.env.API_TS_TEST_ADMIN_URL!),
      database = "pos_session_" + randomUUID().replaceAll("-", ""),
      role = database + "_app"
    const admin = new Pool({ connectionString: url.toString() })
    await admin.query("CREATE DATABASE " + database)
    url.pathname = "/" + database
    const seed = new Pool({ connectionString: url.toString() }),
      api = new Pool({ connectionString: url.toString() })
    const app = Fastify()
    app.setReplySerializer(stringifyJson)
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof Problem) reply.code(error.status).send(error.toJSON())
      else reply.code(500).send({ message: String(error) })
    })
    try {
      const dir = new URL("../../../migrations/", import.meta.url)
      for (const migration of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort())
        await seed.query(await readFile(new URL(migration, dir), "utf8"))
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS")
      await seed.query(
        "GRANT USAGE ON SCHEMA public TO " +
          role +
          "; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO " +
          role,
      )
      const pool = {
        async connect() {
          const c = await api.connect()
          await c.query("SET ROLE " + role)
          return new PgClientAdapter(c)
        },
      }
      registerPosSessionRoutes(app, {
        pool,
        userinfoUrl: "http://auth.test/userinfo",
        fetchAuth: async () =>
          Response.json({ sub: "operator", name: "Operador", email: "operator@example.test", email_verified: true }),
      })
      const tenant = randomUUID(),
        other = randomUUID(),
        permRole = randomUUID(),
        membership = randomUUID(),
        cash = randomUUID(),
        bank = randomUUID()
      await seed.query(
        "INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'PDV','04252011000110'),($2,'Outra','52998224725')",
        [tenant, other],
      )
      await seed.query(
        "INSERT INTO identities(auth_subject,email,display_name) VALUES('operator','operator@example.test','Operador')",
      )
      await seed.query(
        "INSERT INTO tenant_memberships(id,tenant_id,identity_id) SELECT $1,$2,id FROM identities WHERE auth_subject='operator'",
        [membership, tenant],
      )
      await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,'POS','Operador')", [permRole, tenant])
      await seed.query("INSERT INTO membership_roles VALUES($1,$2)", [membership, permRole])
      await seed.query(
        "INSERT INTO role_permissions SELECT $1,code FROM permissions WHERE code IN ('sales.pos.read','sales.pos.manage','sales.pos.close')",
        [permRole],
      )
      await seed.query(
        "INSERT INTO financial_accounts(id,tenant_id,code,name,status,revision,account_type) VALUES($1,$2,'C01','Caixa','active',1,'cash'),($3,$2,'B01','Banco','active',1,'bank')",
        [cash, tenant, bank],
      )
      for (const id of [cash, bank])
        await seed.query(
          "INSERT INTO financial_account_entries(id,tenant_id,account_id,direction,amount_cents,occurred_on,description) VALUES($1,$2,$3,'credit',10000,current_date,'Saldo inicial')",
          [randomUUID(), tenant, id],
        )
      const headers = { "x-tenant-id": tenant, authorization: "Bearer operator" },
        base = "/api/v1/pos/sessions"
      const send = (path: string, payload: object, rev?: number, key = randomUUID()) =>
        app.inject({
          method: "POST",
          url: base + path,
          headers: { ...headers, ...(rev ? { "if-match": '"' + rev + '"' } : {}), "idempotency-key": key },
          payload,
        })
      const get = (path: string) => app.inject({ url: base + path, headers })
      const check = (r: { body: string; statusCode: number; json: () => any }, code = 200) => {
        assert.equal(r.statusCode, code, r.body)
        return r.json()
      }
      assert.equal(check(await get("/current?register=Principal")).data, null)
      const input = { register: "Principal", cashAccountId: cash, openingAmount: "100.00" }
      assert.equal((await send("", { ...input, openingAmount: "100.01" })).statusCode, 409)
      const openKey = randomUUID(),
        opened = check(await send("", input, undefined, openKey), 201)
      assert.deepEqual(check(await send("", input, undefined, openKey), 201), opened)
      const id = opened.data.id,
        path = "/" + id
      assert.equal(check(await get("/current")).data.id, id)
      assert.equal((await send("", { ...input, register: "Outro" })).statusCode, 409)
      const supply = { direction: "supply", sourceAccountId: bank, amount: "40.00", reason: "Troco da tesouraria" }
      const period = randomUUID()
      await seed.query(
        "INSERT INTO finance_account_periods(tenant_id,id,account_id,through_date,closed_by,reason) VALUES($1,$2,$3,current_date+1,'operator','Conferência')",
        [tenant, period, bank],
      )
      assert.equal((await send(path + "/movements", supply, 1)).statusCode, 409)
      assert.equal(check(await get(path)).data.revision, 1)
      await seed.query(
        "UPDATE finance_account_periods SET reopened_by='operator',reopened_at=now(),reopen_reason='Reabertura' WHERE tenant_id=$1 AND id=$2",
        [tenant, period],
      )
      const key = randomUUID()
      const pair = await Promise.all([
        send(path + "/movements", supply, 1, key),
        send(path + "/movements", supply, 1, key),
      ])
      const moved = check(pair[0]!).data
      assert.deepEqual(check(pair[1]!).data, moved)
      const first = moved.movements[0]
      assert.equal(moved.totals.expectedCash, "140.00")
      assert.ok(first.transferId)
      const undo = { reversesMovementId: first.id, reason: "Reposição cancelada" }
      const undone = check(await send(path + "/movements", undo, 2)).data
      assert.equal(undone.totals.expectedCash, "100.00")
      assert.equal(undone.movements[0].reversesMovementId, first.id)
      assert.equal((await send(path + "/movements", undo, 3)).statusCode, 409)
      const balances = (
        await seed.query(
          "SELECT account_id,sum(CASE direction WHEN 'credit' THEN amount_cents ELSE -amount_cents END) AS balance FROM financial_account_entries WHERE tenant_id=$1 GROUP BY account_id",
          [tenant],
        )
      ).rows
      assert.ok(balances.every((r) => r.balance === "10000"))
      assert.equal(
        (
          await send(
            path + "/movements",
            { direction: "withdrawal", targetAccountId: bank, amount: "100.01", reason: "Retirada excessiva" },
            3,
          )
        ).statusCode,
        409,
      )
      // Original PDV checkout remains a producer of this session's sales and cash ledger.
      const sale = randomUUID(),
        entry = randomUUID()
      await seed.query(
        "INSERT INTO pos_sales(id,tenant_id,session_id,total_cents,created_by,receipt) VALUES($1,$2,$3,3500,'operator','{}')",
        [sale, tenant, id],
      )
      await seed.query(
        "INSERT INTO financial_account_entries(id,tenant_id,account_id,direction,amount_cents,occurred_on,description) VALUES($1,$2,$3,'credit',3500,current_date,'Venda de balcão')",
        [entry, tenant, cash],
      )
      await seed.query(
        "INSERT INTO pos_payments(id,tenant_id,sale_id,account_id,method,amount_cents,tendered_cents,entry_id) VALUES($1,$2,$3,$4,'cash',3500,5000,$5)",
        [randomUUID(), tenant, sale, cash, entry],
      )
      await seed.query("UPDATE pos_sessions SET revision=revision+1 WHERE id=$1", [id])
      const detail = check(await get(path)).data
      assert.equal(detail.salesTotal, 1)
      assert.equal(detail.totals.cash, "35.00")
      assert.equal(detail.totals.expectedCash, "135.00")
      const closedInput = { countedCash: "134.00", reason: "Diferença conferida" },
        closeKey = randomUUID()
      assert.equal((await send(path + "/close", closedInput, 3)).statusCode, 412)
      assert.equal((await send(path + "/close", { countedCash: "134.00" }, 4)).statusCode, 422)
      const closed = check(await send(path + "/close", closedInput, 4, closeKey))
      assert.equal(closed.data.totals.difference, "-1.00")
      assert.equal(closed.data.status, "closed")
      assert.deepEqual(check(await send(path + "/close", closedInput, 4, closeKey)), closed)
      assert.equal((await send(path + "/movements", supply, 5)).statusCode, 409)
      assert.equal(check(await get("/current?register=Principal")).data, null)
      assert.equal(check(await get("?status=closed&register=Principal&limit=1")).total, 1)
      assert.equal(check(await get("?status=open")).total, 0)
      assert.equal((await get("?startDate=2030-01-01&endDate=2025-01-01")).statusCode, 422)
      assert.equal(
        (await app.inject({ url: base + path, headers: { ...headers, "x-tenant-id": other } })).statusCode,
        403,
      )
      await seed.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_code='sales.pos.close'", [
        permRole,
      ])
      assert.equal((await send(path + "/close", closedInput, 4, closeKey)).statusCode, 403)
      assert.equal(
        (
          await seed.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id=$1 AND entity_type='pos'", [
            tenant,
          ])
        ).rows[0].n,
        4,
      )
      assert.equal(
        (
          await seed.query("SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id=$1 AND aggregate_type='pos'", [
            tenant,
          ])
        ).rows[0].n,
        4,
      )
    } finally {
      await app.close()
      await api.end()
      await seed.end()
      try {
        await admin.query("DROP DATABASE " + database)
        await admin.query("DROP ROLE IF EXISTS " + role)
      } finally {
        await admin.end()
      }
    }
  },
)
