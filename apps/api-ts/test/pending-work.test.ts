import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { databaseTestOptions, withTestContext, type TestContext } from "./support/test-context.js"

const everything = ["sales.orders.read", "sales.proposals.read", "finance.receivables.read", "finance.payables.read", "finance.accounts.read", "finance.categories.read", "fiscal.config.read"]
type Item = { key: string; group: string; count: number; amountCents: string | null; href: string }

async function seedCommerce(ctx: TestContext, tenant = ctx.tenant) {
  const customer = randomUUID(), stale = randomUUID(), fresh = randomUUID(), billed = randomUUID(), later = randomUUID()
  await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente','52998224725',true,false,'active')", [customer, tenant])
  await ctx.seed.query(`INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status,updated_at) VALUES
    ($1,$4,$5,'Cliente','52998224725',current_date,30450,'draft',now()-interval '10 days'),
    ($2,$4,$5,'Cliente','52998224725',current_date,10000,'draft',now()),
    ($3,$4,$5,'Cliente','52998224725',current_date,20000,'accepted',now()),
    ($6,$4,$5,'Cliente','52998224725',current_date,5000,'accepted',now())`, [stale, fresh, billed, tenant, customer, later])
  const overdue = randomUUID()
  await ctx.seed.query(`INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES
    ($1,$3,$2,'Cliente',(now() AT TIME ZONE 'America/Sao_Paulo')::date-5,12345,'open'),
    ($4,$3,$5,'Cliente',(now() AT TIME ZONE 'America/Sao_Paulo')::date+20,5000,'open')`, [overdue, billed, tenant, randomUUID(), later])
  const proposals = { expired: randomUUID(), expiring: randomUUID(), current: randomUUID() }
  const client = await ctx.seed.connect()
  try {
    await client.query("BEGIN")
    for (const [id, days] of [[proposals.expired, -2], [proposals.expiring, 2], [proposals.current, 30]] as const) {
      await client.query("INSERT INTO sales_proposals(id,tenant_id) VALUES($1,$2)", [id, tenant])
      await client.query(`INSERT INTO sales_proposal_versions(tenant_id,proposal_id,version,customer_id,customer_name,customer_tax_id,valid_until,payment_terms,delivery_terms,amount_cents,status,created_by,sent_at)
        VALUES($1,$2,1,$3,'Cliente','52998224725',(now() AT TIME ZONE 'America/Sao_Paulo')::date+$4::int,'À vista','Retirada',15000,'sent','user',now())`, [tenant, id, customer, days])
    }
    await client.query("COMMIT")
  } finally { client.release() }
  return { stale, overdue, proposals }
}

const listTotal = async (ctx: TestContext, href: string) => {
  const target = new URL(href, "http://erp.test")
  const query = Object.fromEntries(target.searchParams)
  const api = target.pathname === "/vendas/pedidos" ? "/api/v1/orders" : target.pathname === "/vendas/propostas" ? "/api/v1/proposals" : target.pathname === "/relatorios/financeiro" ? "/api/v1/finance/portfolio" : target.pathname === "/vendas/aprovacoes" ? "/api/v1/commercial/policies/queue" : ""
  assert.ok(api, "destino sem lista conhecida: " + href)
  const response = await ctx.as("user").get(api, { query: api.startsWith("/api/v1/finance") || api.includes("/queue") ? query : { view: "workspace", ...query } })
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json()
  return Number(body.total ?? body.data.length)
}

test("GET /api/v1/pending-work [sucesso] Cada pendência leva à lista com o mesmo total", databaseTestOptions, async () => {
  await withTestContext({ permissions: everything }, async ctx => {
    await seedCommerce(ctx)
    await seedCommerce(ctx, ctx.otherTenant) // dados da outra empresa não entram no painel
    const response = await ctx.as("user").get("/api/v1/pending-work")
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers["cache-control"], "no-store")
    const body = response.json() as { tenantId: string; total: number; items: Item[] }
    assert.equal(body.tenantId, ctx.tenant)
    const byKey = Object.fromEntries(body.items.map(item => [item.key, item]))
    assert.deepEqual(Object.keys(byKey).sort(), ["finance.overdue-receivables", "sales.expired-proposals", "sales.expiring-proposals", "sales.stale-orders", "setup.certificate", "setup.financial-account"])
    assert.equal(byKey["sales.stale-orders"]!.count, 1)
    assert.equal(byKey["sales.stale-orders"]!.amountCents, "30450")
    assert.equal(byKey["finance.overdue-receivables"]!.count, 1)
    assert.equal(byKey["finance.overdue-receivables"]!.amountCents, "12345")
    assert.equal(byKey["sales.expired-proposals"]!.count, 1)
    assert.equal(byKey["sales.expiring-proposals"]!.count, 1)
    assert.equal(body.total, body.items.reduce((sum, item) => sum + item.count, 0))
    for (const item of body.items.filter(item => item.group !== "setup")) assert.equal(await listTotal(ctx, item.href), item.count, item.key + " → " + item.href)
  })
})

test("GET /api/v1/pending-work [sucesso] itens resolvidos somem do painel", databaseTestOptions, async () => {
  await withTestContext({ permissions: everything }, async ctx => {
    const seeded = await seedCommerce(ctx)
    const keys = async () => ((await ctx.as("user").get("/api/v1/pending-work")).json().items as Item[]).map(item => item.key)
    assert.ok((await keys()).includes("sales.stale-orders"))
    await ctx.seed.query("UPDATE sales_orders SET status='cancelled' WHERE id=$1", [seeded.stale])
    await ctx.seed.query("UPDATE receivables SET status='cancelled' WHERE id=$1", [seeded.overdue])
    const after = await keys()
    assert.equal(after.includes("sales.stale-orders"), false)
    assert.equal(after.includes("finance.overdue-receivables"), false)
  })
})

test("GET /api/v1/pending-work [sucesso] cada item respeita a permissão do usuário", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["sales.orders.read"] }, async ctx => {
    await seedCommerce(ctx)
    const items = (await ctx.as("user").get("/api/v1/pending-work")).json().items as Item[]
    assert.deepEqual(items.map(item => item.key), ["sales.stale-orders"])
  })
})

test("GET /api/v1/pending-work [negado] sem permissão, sem token e de outra empresa", databaseTestOptions, async () => {
  await withTestContext({ permissions: everything }, async ctx => {
    assert.equal((await ctx.as("denied").get("/api/v1/pending-work")).statusCode, 403)
    assert.equal((await ctx.as("anonymous").get("/api/v1/pending-work")).statusCode, 401)
    assert.equal((await ctx.as("outsider").get("/api/v1/pending-work")).statusCode, 403)
  })
})

test("GET /api/v1/pending-work [422] recusa filtros desconhecidos", databaseTestOptions, async () => {
  await withTestContext({ permissions: everything }, async ctx => {
    const response = await ctx.as("user").get("/api/v1/pending-work", { query: { group: "sales" } })
    assert.equal(response.statusCode, 422, response.body)
  })
})
