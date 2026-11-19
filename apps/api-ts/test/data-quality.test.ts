import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { findDuplicates, nameSimilarity, normalizeName } from "../src/modules/data-quality/similarity.js"
import { databaseTestOptions, withTestContext } from "./support/test-context.js"

test("normalização ignora acento, caixa e pontuação", () => {
  assert.equal(normalizeName("Agachamento  Pêndulo!"), "agachamentopendulo")
})

test("A tela de duplicados lista os pares suspeitos: nome parecido, mesmo e-mail e mesmo telefone", () => {
  const items = [
    { id: "1", name: "Agachamento Pêndulo" }, { id: "2", name: "Agachamento Pendulum" }, { id: "3", name: "Supino Reto" },
    { id: "4", name: "Ana Souza", email: "Ana@x.com" }, { id: "5", name: "Beatriz Lima", email: "ana@x.com", phone: "(11) 99999-0000" }, { id: "6", name: "Carlos Rocha", phone: "11 99999 0000" },
  ]
  const pairs = findDuplicates(items)
  assert.deepEqual(pairs.map(pair => [pair.a, pair.b, ...pair.reasons]), [["4", "5", "same_email"], ["5", "6", "same_phone"], ["1", "2", "similar_name"]])
  assert.ok(nameSimilarity("Supino Reto", "Agachamento Pêndulo") < 0.5)
  assert.deepEqual(findDuplicates([{ id: "1", name: "Abc" }, { id: "2", name: "Abc" }]), [], "nomes curtos não geram falso positivo")
})

async function seedParty(ctx: { seed: import("pg").Pool; tenant: string }, name: string, taxId: string, extra: { customer?: boolean; supplier?: boolean; email?: string } = {}) {
  const id = randomUUID()
  await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,email,is_customer,is_supplier,status) VALUES($1,$2,'fisica',$3,$4,$5,$6,$7,'active')", [id, ctx.tenant, name, taxId, extra.email ?? null, extra.customer ?? true, extra.supplier ?? false])
  return id
}
const merge = (ctx: any, body: object, who = "user", key?: string) => ctx.as(who).post("/api/v1/data-quality/merge", { body, ...(key ? { idempotencyKey: key } : {}) })

test("POST /api/v1/data-quality/merge: a mesclagem preserva os documentos dos dois registros", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["catalog.parties.read", "catalog.parties.manage"] }, async ctx => {
    const principal = await seedParty(ctx, "Maria da Silva", "52998224725"), secundario = await seedParty(ctx, "Maria de Silva", "11144477735", { customer: false, supplier: true })
    const orderA = randomUUID(), orderB = randomUUID(), receivable = randomUUID(), purchase = randomUUID()
    await ctx.seed.query(`INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES
      ($1,$3,$4,'Maria da Silva','52998224725','2026-12-01',1000,'draft'),($2,$3,$5,'Maria de Silva','11144477735','2026-12-02',2000,'draft')`, [orderA, orderB, ctx.tenant, principal, secundario])
    await ctx.seed.query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Maria de Silva','2026-12-02',2000,'open')", [receivable, ctx.tenant, orderB])
    await ctx.seed.query("INSERT INTO purchase_orders(id,tenant_id,supplier_id,supplier_name,supplier_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Maria de Silva','11144477735','2026-12-03',500,'draft')", [purchase, ctx.tenant, secundario])

    const found = await ctx.as("user").get("/api/v1/data-quality/party/duplicates")
    assert.equal(found.statusCode, 200, found.body)
    assert.equal(found.json().data.length, 1)
    const pair = found.json().data[0], [first, second] = pair.a.id === principal ? [pair.a, pair.b] : [pair.b, pair.a]
    assert.deepEqual(pair.reasons, ["similar_name"])

    const body = { entity: "party", primaryId: principal, secondaryId: secundario, primaryRevision: first.revision, secondaryRevision: second.revision }
    const key = randomUUID(), done = await merge(ctx, body, "user", key)
    assert.equal(done.statusCode, 200, done.body)
    assert.equal(done.json().moved["sales_orders.customer_id"], 1)
    assert.equal((await merge(ctx, body, "user", key)).statusCode, 200, "mesma chave repete o resultado")

    const orders = (await ctx.seed.query("SELECT id FROM sales_orders WHERE tenant_id=$1 AND customer_id=$2 ORDER BY number", [ctx.tenant, principal])).rows.map(row => row.id)
    assert.deepEqual(orders, [orderA, orderB], "pedidos dos dois lados no registro principal")
    assert.equal((await ctx.seed.query("SELECT 1 FROM purchase_orders WHERE supplier_id=$1", [principal])).rowCount, 1, "pedido de compra do secundário movido")
    assert.equal((await ctx.seed.query("SELECT 1 FROM receivables r JOIN sales_orders o ON o.tenant_id=r.tenant_id AND o.id=r.order_id WHERE r.id=$1 AND o.customer_id=$2", [receivable, principal])).rowCount, 1, "título segue o pedido")
    const after = (await ctx.seed.query("SELECT id,status,is_customer,is_supplier FROM parties WHERE tenant_id=$1 AND id IN ($2,$3)", [ctx.tenant, principal, secundario])).rows
    assert.deepEqual(after.find(row => row.id === principal), { id: principal, status: "active", is_customer: true, is_supplier: true })
    assert.equal(after.find(row => row.id === secundario).status, "archived")
    const audit = await ctx.seed.query("SELECT action FROM audit_log WHERE tenant_id=$1 AND action LIKE 'party.%merge%' ORDER BY action", [ctx.tenant])
    assert.deepEqual(audit.rows.map(row => row.action), ["party.archived_by_merge", "party.merged"])
  })
})

test("POST /api/v1/data-quality/merge: 401/403, 422, 404, 409 e 412", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["catalog.parties.read", "catalog.parties.manage"] }, async ctx => {
    const a = await seedParty(ctx, "Pessoa Um", "52998224725"), b = await seedParty(ctx, "Pessoa Dois", "11144477735")
    const body = { entity: "party", primaryId: a, secondaryId: b, primaryRevision: 1, secondaryRevision: 1 }
    assert.equal((await merge(ctx, body, "anonymous")).statusCode, 401)
    assert.equal((await merge(ctx, body, "denied")).statusCode, 403)
    assert.equal((await ctx.as("user").post("/api/v1/data-quality/merge", { body, tenant: ctx.otherTenant })).statusCode, 403)
    await ctx.grant("denied", "catalog.parties.read")
    assert.equal((await merge(ctx, body, "denied")).statusCode, 403, "leitura não basta para mesclar")
    assert.equal((await merge(ctx, { ...body, secondaryId: a })).statusCode, 422)
    assert.equal((await merge(ctx, { ...body, extra: 1 })).statusCode, 422)
    assert.equal((await merge(ctx, { ...body, secondaryId: randomUUID() })).statusCode, 404)
    assert.equal((await merge(ctx, { ...body, secondaryRevision: 9 })).statusCode, 412)
    const key = randomUUID()
    assert.equal((await merge(ctx, body, "user", key)).statusCode, 200)
    assert.equal((await merge(ctx, { ...body, secondaryRevision: 2 }, "user", key)).statusCode, 409, "chave reutilizada com outros dados")
    assert.equal((await merge(ctx, { ...body, primaryRevision: 2, secondaryRevision: 2 })).statusCode, 409, "secundário já arquivado")
  })
})

test("GET /api/v1/data-quality/*: leitura exige permissão, filtro por empresa e completude", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["catalog.parties.read", "catalog.products.read"] }, async ctx => {
    await seedParty(ctx, "Sem Endereço", "52998224725")
    await ctx.seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'A1','Banco Scott Reto','UN',100,'active'),($3,$2,'A2','Banco Scott Retto','UN',100,'active')", [randomUUID(), ctx.tenant, randomUUID()])
    const parties = await ctx.as("user").get("/api/v1/data-quality/party/completeness")
    assert.equal(parties.statusCode, 200, parties.body)
    assert.equal(parties.json().counts.address.total, 1)
    const products = await ctx.as("user").get("/api/v1/data-quality/product/completeness")
    assert.deepEqual([products.json().counts.photo.total, products.json().counts.ncm.total], [2, 2])
    const dup = await ctx.as("user").get("/api/v1/data-quality/product/duplicates")
    assert.equal(dup.json().data.length, 1)
    assert.equal(dup.json().canMerge, false)
    assert.equal((await ctx.as("denied").get("/api/v1/data-quality/product/duplicates")).statusCode, 403)
    assert.equal((await ctx.as("anonymous").get("/api/v1/data-quality/party/completeness")).statusCode, 401)
    assert.equal((await ctx.as("user").get("/api/v1/data-quality/outro/completeness")).statusCode, 422)
    assert.equal((await ctx.as("outsider").get("/api/v1/data-quality/party/completeness")).json().total, undefined, "outra empresa não vê estes dados")
  })
})

test("POST /api/v1/data-quality/merge: produtos movem linhas de pedido e arquivam o duplicado; conflito de dados próprios dá 409", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["catalog.products.read", "catalog.products.manage"] }, async ctx => {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()], order = randomUUID()
    await ctx.seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$4,'P1','Agachamento Pêndulo','UN',100,'active'),($2,$4,'P2','Agachamento Pendulum','UN',100,'active'),($3,$4,'P3','Agachamento Pendulun','UN',100,'active')", [a, b, c, ctx.tenant])
    const party = await seedParty(ctx, "Cliente", "52998224725")
    await ctx.seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente','52998224725','2026-12-01',100,'draft')", [order, ctx.tenant, party])
    await ctx.seed.query("INSERT INTO price_lists(id,tenant_id,code,name,status,revision) VALUES($1,$2,'L1','Lista','active',1)", [order, ctx.tenant])
    await ctx.seed.query("INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price_cents) VALUES($1,$2,$3,100),($1,$2,$4,100)", [ctx.tenant, order, a, b])
    const body = { entity: "product", primaryId: a, secondaryId: b, primaryRevision: 1, secondaryRevision: 1 }
    const conflict = await merge(ctx, body)
    assert.equal(conflict.statusCode, 409, conflict.body)
    assert.match(conflict.json().detail ?? conflict.body, /price_list_items/)
    assert.equal((await ctx.seed.query("SELECT status FROM products WHERE id=$1", [b])).rows[0].status, "active", "falha não deixa mesclagem pela metade")
    const ok = await merge(ctx, { ...body, secondaryId: c })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal((await ctx.seed.query("SELECT status FROM products WHERE id=$1", [c])).rows[0].status, "archived")
  })
})
