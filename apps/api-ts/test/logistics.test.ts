import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { databaseTestOptions, withTestContext, type TestContext } from "./support/test-context.js"

// Porte das 15 rotas de logística (PR #288). Divergências do Rust estão em docs/migracao/07-porte-logistica.md.
const POSTINGS = ["logistics.postings.read", "logistics.postings.manage"]
const CHECKOUT = ["logistics.checkout.read", "logistics.checkout.manage"]
const json = (response: { body: string }) => JSON.parse(response.body)
const posting = { recipientName: " Academia Central ", service: "SEDEX", destinationCity: "Curitiba", destinationState: "pr", packageCount: 2, weightGrams: 12_500, declaredValueCents: 350_000 }

/** Pedido confirmado com duas linhas (2 e 1 unidades), na empresa indicada. */
async function seedOrder(ctx: TestContext, tenant = ctx.tenant, status = "confirmed", lines = 2) {
  const order = randomUUID()
  await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Cliente','52998224725',true,false,'active') ON CONFLICT DO NOTHING", [tenant])
  await ctx.seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-01',30000,$3)", [order, tenant, status])
  for (let line = 1; line <= lines; line++) {
    const product = randomUUID(), sku = `LD-${product.slice(0, 8).toUpperCase()}`
    await ctx.seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,$3,'Banco supino','UN',10000,'active')", [product, tenant, sku])
    await ctx.seed.query("INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents) VALUES($1,$2,$3,$4,$5,'Banco supino','UN',$6,10000,$7)", [tenant, order, line, product, sku, line === 1 ? 2_000_000 : 1_000_000, line === 1 ? 20000 : 10000])
  }
  return order
}

/** Conferência aberta, com as duas linhas conferidas e revisão devolvida. */
async function openCheckout(ctx: TestContext, tenant = ctx.tenant) {
  const order = await seedOrder(ctx, tenant)
  const persona = tenant === ctx.tenant ? "user" : "outsider"
  const started = await ctx.as(persona).post("/api/v1/logistics/checkouts", { body: { orderId: order }, tenant })
  assert.equal(started.statusCode, 201, started.body)
  return { order, id: json(started).data.id as string, client: ctx.as(persona), tenant }
}

test("POST /api/v1/logistics/postings + GET /api/v1/logistics/postings + GET /api/v1/logistics/postings/{id} + POST /api/v1/logistics/postings/{id}/status [sucesso] cria, lista, detalha e avança a postagem", databaseTestOptions, async () => {
  await withTestContext({ permissions: POSTINGS }, async ctx => {
    const user = ctx.as("user")
    const key = randomUUID()
    const created = await user.post("/api/v1/logistics/postings", { body: posting, idempotencyKey: key })
    assert.equal(created.statusCode, 201, created.body)
    assert.equal(created.headers.etag, '"1"')
    assert.match(String(created.headers["content-type"]), /^application\/json/)
    const item = json(created).data
    assert.equal(item.recipientName, "Academia Central")
    assert.equal(item.destinationState, "PR")
    assert.equal(item.status, "prepared")
    assert.equal(item.revision, 1)
    assert.match(item.code, /^OBJ-[0-9A-F]{8}$/)
    assert.equal(item.carrier, null)

    // Idempotência: mesma chave e mesmos dados devolvem o mesmo resultado (200, sem nova linha); dados diferentes, 409.
    const replayed = await user.post("/api/v1/logistics/postings", { body: posting, idempotencyKey: key })
    assert.equal(replayed.statusCode, 200)
    assert.deepEqual(json(replayed), json(created))
    assert.equal((await user.post("/api/v1/logistics/postings", { body: { ...posting, packageCount: 3 }, idempotencyKey: key })).statusCode, 409)
    await user.post("/api/v1/logistics/postings", { body: { ...posting, recipientName: "Clube Norte", destinationCity: "Belém", destinationState: "PA", carrier: "Correios", trackingCode: "AA123456789BR" } })

    const listed = await user.get("/api/v1/logistics/postings")
    assert.equal(listed.statusCode, 200)
    assert.equal(json(listed).data.length, 2)
    assert.equal(json(listed).canEdit, true)
    assert.equal(json(listed).limit, 50)
    assert.deepEqual(json(await user.get("/api/v1/logistics/postings", { query: { q: "belém" } })).data.map((row: { recipientName: string }) => row.recipientName), ["Clube Norte"])
    assert.equal(json(await user.get("/api/v1/logistics/postings", { query: { status: "posted" } })).data.length, 0)
    assert.equal(json(await user.get("/api/v1/logistics/postings", { query: { limit: 1, offset: 1 } })).data.length, 1)
    assert.equal((await user.get("/api/v1/logistics/postings", { query: { status: "lost" } })).statusCode, 422)
    assert.equal((await user.get("/api/v1/logistics/postings", { query: { limit: "muitos" } })).statusCode, 422)

    const detail = await user.get(`/api/v1/logistics/postings/${item.id}`)
    assert.equal(detail.statusCode, 200)
    assert.equal(detail.headers.etag, '"1"')
    assert.equal(json(detail).data.weightGrams, 12_500)
    assert.equal((await user.get(`/api/v1/logistics/postings/${randomUUID()}`)).statusCode, 404)
    assert.equal((await user.get("/api/v1/logistics/postings/nao-e-uuid")).statusCode, 404)

    const status = (body: unknown, revision?: number, idempotencyKey?: string) => user.post(`/api/v1/logistics/postings/${item.id}/status`, { body, ...(revision === undefined ? {} : { revision }), ...(idempotencyKey ? { idempotencyKey } : {}) })
    const statusKey = randomUUID()
    const posted = await status({ status: "posted" }, 1, statusKey)
    assert.equal(posted.statusCode, 200, posted.body)
    assert.equal(posted.headers.etag, '"2"')
    assert.deepEqual(json(posted).data, { id: item.id, status: "posted", revision: 2 })
    assert.deepEqual(json(await status({ status: "posted" }, 1, statusKey)), json(posted))
    assert.equal((await status({ status: "in_transit" })).statusCode, 428)
    assert.equal((await status({ status: "in_transit" }, 1)).statusCode, 412)
    assert.equal((await status({ status: "prepared" }, 2)).statusCode, 409)
    assert.equal((await status({ status: "delivered" }, 2)).statusCode, 409)
    assert.equal((await status({ status: "lost" }, 2)).statusCode, 422)
    assert.equal((await status({ status: "in_transit", extra: true }, 2)).statusCode, 422)
    assert.equal((await status({ status: "in_transit" }, 2)).statusCode, 200)
    assert.equal((await status({ status: "delivered" }, 3)).statusCode, 200)
    assert.equal((await status({ status: "cancelled" }, 4)).statusCode, 409)

    const audit = await ctx.seed.query("SELECT action FROM audit_log WHERE entity_type='logistics_posting' AND entity_id=$1 ORDER BY occurred_at,id", [item.id])
    assert.deepEqual(audit.rows.map(row => row.action), ["logistics.posting.created", "logistics.posting.status_changed", "logistics.posting.status_changed", "logistics.posting.status_changed"])
    const outbox = await ctx.seed.query("SELECT count(*)::int AS total FROM outbox_events WHERE aggregate_id=$1", [item.id])
    assert.equal(outbox.rows[0].total, 4)
  })
})

test("POST /api/v1/logistics/postings [sucesso] valida a entrada com 422", databaseTestOptions, async () => {
  await withTestContext({ permissions: POSTINGS }, async ctx => {
    const user = ctx.as("user")
    for (const bad of [{ ...posting, extra: 1 }, { ...posting, recipientName: "A" }, { ...posting, destinationState: "PRR" }, { ...posting, destinationState: "1A" }, { ...posting, packageCount: 0 }, { ...posting, weightGrams: 0 }, { ...posting, declaredValueCents: -1 }, { ...posting, service: "SE\u0007DEX" }, { ...posting, carrier: "x".repeat(81) }, { ...posting, orderId: "pedido" }, {}]) {
      assert.equal((await user.post("/api/v1/logistics/postings", { body: bad })).statusCode, 422, JSON.stringify(bad))
    }
    // Pedido de outra empresa não vira referência válida.
    const foreignOrder = await seedOrder(ctx, ctx.otherTenant)
    assert.equal((await user.post("/api/v1/logistics/postings", { body: { ...posting, orderId: foreignOrder } })).statusCode, 422)
    assert.equal((await user.post("/api/v1/logistics/postings", { body: posting, idempotencyKey: "x" })).statusCode, 422)
  })
})

test("GET /api/v1/logistics/postings + GET /api/v1/logistics/postings/{id} + POST /api/v1/logistics/postings + POST /api/v1/logistics/postings/{id}/status [negado] sem token, sem permissão, só leitura e outra empresa", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["logistics.postings.read"] }, async ctx => {
    const own = json(await ctx.as("outsider").post("/api/v1/logistics/postings", { body: posting, tenant: ctx.otherTenant })).data
    const routes = [
      (persona: "user" | "denied" | "anonymous", tenant?: string) => ctx.as(persona).get("/api/v1/logistics/postings", tenant ? { tenant } : {}),
      (persona: "user" | "denied" | "anonymous", tenant?: string) => ctx.as(persona).get(`/api/v1/logistics/postings/${own.id}`, tenant ? { tenant } : {}),
      (persona: "user" | "denied" | "anonymous", tenant?: string) => ctx.as(persona).post("/api/v1/logistics/postings", { body: posting, ...(tenant ? { tenant } : {}) }),
      (persona: "user" | "denied" | "anonymous", tenant?: string) => ctx.as(persona).post(`/api/v1/logistics/postings/${own.id}/status`, { body: { status: "posted" }, revision: 1, ...(tenant ? { tenant } : {}) }),
    ]
    for (const route of routes) {
      assert.equal((await route("anonymous")).statusCode, 401)
      assert.equal((await route("denied")).statusCode, 403)
      assert.equal((await route("user", ctx.otherTenant)).statusCode, 403)
    }
    // Só leitura: lê, não escreve.
    assert.equal((await routes[0]!("user")).statusCode, 200)
    assert.equal((await routes[2]!("user")).statusCode, 403)
    // Isolamento: a postagem da empresa B não aparece nem muda pela empresa A.
    await ctx.grant("user", "logistics.postings.manage")
    assert.deepEqual(json(await routes[0]!("user")).data, [])
    assert.equal((await routes[1]!("user")).statusCode, 404)
    assert.equal((await routes[3]!("user")).statusCode, 404)
    const untouched = await ctx.seed.query("SELECT status,revision::int FROM logistics_postings WHERE id=$1", [own.id])
    assert.deepEqual(untouched.rows[0], { status: "prepared", revision: 1 })
  })
})

test("POST /api/v1/logistics/checkouts + GET /api/v1/logistics/checkouts + GET /api/v1/logistics/checkouts/{id} + POST /api/v1/logistics/checkouts/{id}/lines/{line}/check + POST /api/v1/logistics/checkouts/{id}/complete [sucesso] confere o pedido e conclui", databaseTestOptions, async () => {
  await withTestContext({ permissions: CHECKOUT }, async ctx => {
    const user = ctx.as("user")
    const order = await seedOrder(ctx)
    const key = randomUUID()
    const started = await user.post("/api/v1/logistics/checkouts", { body: { orderId: order }, idempotencyKey: key })
    assert.equal(started.statusCode, 201, started.body)
    assert.equal(started.headers.etag, '"1"')
    const checkout = json(started).data
    assert.deepEqual({ ...checkout, id: undefined }, { id: undefined, orderId: order, status: "counting", revision: 1 })
    assert.deepEqual(json(await user.post("/api/v1/logistics/checkouts", { body: { orderId: order }, idempotencyKey: key })), json(started))
    // Uma conferência por pedido: nova chave devolve a existente com 200.
    const again = await user.post("/api/v1/logistics/checkouts", { body: { orderId: order } })
    assert.equal(again.statusCode, 200)
    assert.equal(json(again).data.id, checkout.id)
    assert.equal((await user.post("/api/v1/logistics/checkouts", { body: { orderId: order.toUpperCase() }, idempotencyKey: key })).statusCode, 200)
    assert.equal((await user.post("/api/v1/logistics/checkouts", { body: { orderId: await seedOrder(ctx, ctx.tenant, "draft") } })).statusCode, 404)
    assert.equal((await user.post("/api/v1/logistics/checkouts", { body: { orderId: await seedOrder(ctx, ctx.tenant, "confirmed", 0) } })).statusCode, 409)
    for (const bad of [{}, { orderId: "x" }, { orderId: order, extra: 1 }]) assert.equal((await user.post("/api/v1/logistics/checkouts", { body: bad })).statusCode, 422)

    const listed = await user.get("/api/v1/logistics/checkouts")
    assert.equal(listed.statusCode, 200)
    assert.deepEqual(json(listed).data.map((row: { id: string }) => row.id), [checkout.id])
    const detail = await user.get(`/api/v1/logistics/checkouts/${checkout.id}`)
    assert.equal(detail.headers.etag, '"1"')
    assert.deepEqual(json(detail).data.lines.map((line: { lineNumber: number; expectedQuantityMicros: number; checkedQuantityMicros: number }) => [line.lineNumber, line.expectedQuantityMicros, line.checkedQuantityMicros]), [[1, 2_000_000, 0], [2, 1_000_000, 0]])
    assert.deepEqual(json(detail).data.packages, [])

    const check = (line: number | string, quantity: unknown, revision?: number, idempotencyKey?: string) => user.post(`/api/v1/logistics/checkouts/${checkout.id}/lines/${line}/check`, { body: { checkedQuantityMicros: quantity }, ...(revision === undefined ? {} : { revision }), ...(idempotencyKey ? { idempotencyKey } : {}) })
    assert.equal((await check(1, 2_000_001, 1)).statusCode, 422) // conferência a mais
    assert.equal((await check(1, -1, 1)).statusCode, 422)
    assert.equal((await check(1, "2", 1)).statusCode, 422)
    assert.equal((await check(1, 1_000_000)).statusCode, 428)
    assert.equal((await check(1, 1_000_000, 7)).statusCode, 412)
    assert.equal((await check(99, 1_000_000, 1)).statusCode, 404)
    assert.equal((await check("abc", 1_000_000, 1)).statusCode, 404)
    const checkKey = randomUUID()
    const first = await check(1, 2_000_000, 1, checkKey)
    assert.equal(first.statusCode, 200, first.body)
    assert.equal(first.headers.etag, '"2"')
    assert.deepEqual(json(first).data, { id: checkout.id, lineNumber: 1, checkedQuantityMicros: 2_000_000, revision: 2 })
    assert.deepEqual(json(await check(1, 2_000_000, 1, checkKey)), json(first))
    assert.equal((await check(2, 1_000_000, 1, checkKey)).statusCode, 409) // mesma chave, outra linha

    const complete = (revision?: number) => user.post(`/api/v1/logistics/checkouts/${checkout.id}/complete`, revision === undefined ? {} : { revision })
    assert.equal((await complete(2)).statusCode, 409) // linha 2 pendente
    assert.equal((await complete()).statusCode, 428)
    assert.equal((await user.post(`/api/v1/logistics/checkouts/${checkout.id}/complete`, { revision: 2, body: { force: true } })).statusCode, 422)
    assert.equal((await check(2, 1_000_000, 2)).statusCode, 200)
    assert.equal((await complete(2)).statusCode, 412)
    const completed = await complete(3)
    assert.equal(completed.statusCode, 200, completed.body)
    assert.deepEqual(json(completed).data, { id: checkout.id, orderId: order, status: "completed", revision: 4 })
    assert.notEqual(json(await user.get(`/api/v1/logistics/checkouts/${checkout.id}`)).data.completedAt, null)
    assert.equal((await check(1, 0, 4)).statusCode, 409) // fechada
    assert.equal((await complete(4)).statusCode, 409)

    const audit = await ctx.seed.query("SELECT action FROM audit_log WHERE entity_type='logistics_checkout' AND entity_id=$1 ORDER BY occurred_at,id", [checkout.id])
    assert.deepEqual(audit.rows.map(row => row.action), ["logistics.checkout.started", "logistics.checkout.line_checked", "logistics.checkout.line_checked", "logistics.checkout.completed"])
  })
})

test("POST /api/v1/logistics/checkouts/{id}/lines/{line}/check [sucesso] concorrência com o mesmo If-Match: só uma conferência vence", databaseTestOptions, async () => {
  await withTestContext({ permissions: CHECKOUT }, async ctx => {
    const { id, client } = await openCheckout(ctx)
    const replies = await Promise.all([1, 2].map(line => client.post(`/api/v1/logistics/checkouts/${id}/lines/${line}/check`, { body: { checkedQuantityMicros: 1_000_000 }, revision: 1 })))
    assert.deepEqual(replies.map(reply => reply.statusCode).sort(), [200, 412])
    assert.equal(json(await client.get(`/api/v1/logistics/checkouts/${id}`)).data.revision, 2)
  })
})

test("POST /api/v1/logistics/checkouts/{id}/packages + POST /api/v1/logistics/checkouts/{id}/packages/{package_id}/status [sucesso] registra volumes e avança etiquetado → embalado", databaseTestOptions, async () => {
  await withTestContext({ permissions: CHECKOUT }, async ctx => {
    const { id, client } = await openCheckout(ctx)
    const box = { weightGrams: 8_000, lengthMm: 1200, widthMm: 400, heightMm: 300, labelCode: " CX-1 " }
    for (const bad of [{ ...box, weightGrams: 0 }, { ...box, lengthMm: 100_000 }, { ...box, extra: 1 }, { weightGrams: 1 }]) {
      assert.equal((await client.post(`/api/v1/logistics/checkouts/${id}/packages`, { body: bad, revision: 1 })).statusCode, 422)
    }
    assert.equal((await client.post(`/api/v1/logistics/checkouts/${id}/packages`, { body: box })).statusCode, 428)
    assert.equal((await client.post(`/api/v1/logistics/checkouts/${id}/packages`, { body: box, revision: 3 })).statusCode, 412)
    assert.equal((await client.post(`/api/v1/logistics/checkouts/${randomUUID()}/packages`, { body: box, revision: 1 })).statusCode, 404)
    const key = randomUUID()
    const added = await client.post(`/api/v1/logistics/checkouts/${id}/packages`, { body: box, revision: 1, idempotencyKey: key })
    assert.equal(added.statusCode, 201, added.body)
    assert.equal(added.headers.etag, '"2"')
    const pack = json(added).data
    assert.deepEqual({ ...pack, id: undefined }, { id: undefined, checkoutId: id, packageNumber: 1, weightGrams: 8_000, lengthMm: 1200, widthMm: 400, heightMm: 300, labelCode: "CX-1", status: "prepared", revision: 2 })
    const replay = await client.post(`/api/v1/logistics/checkouts/${id}/packages`, { body: box, revision: 1, idempotencyKey: key })
    assert.equal(replay.statusCode, 200)
    assert.deepEqual(json(replay), json(added))
    const second = json(await client.post(`/api/v1/logistics/checkouts/${id}/packages`, { body: { ...box, labelCode: null }, revision: 2 })).data
    assert.equal(second.packageNumber, 2)

    const move = (packageId: string, status: string, revision?: number) => client.post(`/api/v1/logistics/checkouts/${id}/packages/${packageId}/status`, { body: { status }, ...(revision === undefined ? {} : { revision }) })
    assert.equal((await move(pack.id, "packed", 3)).statusCode, 409) // pula etapa
    assert.equal((await move(pack.id, "prepared", 3)).statusCode, 422)
    assert.equal((await move(pack.id, "labelled")).statusCode, 428)
    assert.equal((await move(pack.id, "labelled", 2)).statusCode, 412)
    assert.equal((await move(randomUUID(), "labelled", 3)).statusCode, 404)
    const labelled = await move(pack.id, "labelled", 3)
    assert.equal(labelled.statusCode, 200, labelled.body)
    assert.deepEqual(json(labelled).data, { id: pack.id, checkoutId: id, packageNumber: 1, status: "labelled", revision: 4 })
    assert.equal((await move(pack.id, "labelled", 4)).statusCode, 409)
    assert.equal((await move(pack.id, "packed", 4)).statusCode, 200)
    const detail = json(await client.get(`/api/v1/logistics/checkouts/${id}`)).data
    assert.deepEqual(detail.packages.map((item: { packageNumber: number; status: string }) => [item.packageNumber, item.status]), [[1, "packed"], [2, "prepared"]])
  })
})

test("GET /api/v1/logistics/checkouts + GET /api/v1/logistics/checkouts/{id} + POST /api/v1/logistics/checkouts + POST /api/v1/logistics/checkouts/{id}/lines/{line}/check + POST /api/v1/logistics/checkouts/{id}/packages + POST /api/v1/logistics/checkouts/{id}/packages/{package_id}/status + POST /api/v1/logistics/checkouts/{id}/complete [negado] sem token, sem permissão, só leitura e outra empresa", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["logistics.checkout.read"] }, async ctx => {
    const foreign = await openCheckout(ctx, ctx.otherTenant)
    const pack = json(await foreign.client.post(`/api/v1/logistics/checkouts/${foreign.id}/packages`, { body: { weightGrams: 1, lengthMm: 1, widthMm: 1, heightMm: 1 }, revision: 1, tenant: ctx.otherTenant })).data
    const ownOrder = await seedOrder(ctx)
    type Who = "user" | "denied" | "anonymous"
    const reads = [
      (who: Who, tenant?: string) => ctx.as(who).get("/api/v1/logistics/checkouts", tenant ? { tenant } : {}),
      (who: Who, tenant?: string) => ctx.as(who).get(`/api/v1/logistics/checkouts/${foreign.id}`, tenant ? { tenant } : {}),
    ]
    const writes = [
      (who: Who, tenant?: string) => ctx.as(who).post("/api/v1/logistics/checkouts", { body: { orderId: ownOrder }, ...(tenant ? { tenant } : {}) }),
      (who: Who, tenant?: string) => ctx.as(who).post(`/api/v1/logistics/checkouts/${foreign.id}/lines/1/check`, { body: { checkedQuantityMicros: 1 }, revision: 2, ...(tenant ? { tenant } : {}) }),
      (who: Who, tenant?: string) => ctx.as(who).post(`/api/v1/logistics/checkouts/${foreign.id}/packages`, { body: { weightGrams: 1, lengthMm: 1, widthMm: 1, heightMm: 1 }, revision: 2, ...(tenant ? { tenant } : {}) }),
      (who: Who, tenant?: string) => ctx.as(who).post(`/api/v1/logistics/checkouts/${foreign.id}/packages/${pack.id}/status`, { body: { status: "labelled" }, revision: 2, ...(tenant ? { tenant } : {}) }),
      (who: Who, tenant?: string) => ctx.as(who).post(`/api/v1/logistics/checkouts/${foreign.id}/complete`, { revision: 2, ...(tenant ? { tenant } : {}) }),
    ]
    for (const route of [...reads, ...writes]) {
      assert.equal((await route("anonymous")).statusCode, 401)
      assert.equal((await route("denied")).statusCode, 403)
      assert.equal((await route("user", ctx.otherTenant)).statusCode, 403)
    }
    for (const route of writes) assert.equal((await route("user")).statusCode, 403) // só leitura
    // Isolamento: a conferência da empresa B não aparece nem muda pela empresa A.
    assert.deepEqual(json(await reads[0]!("user")).data, [])
    assert.equal((await reads[1]!("user")).statusCode, 404)
    await ctx.grant("user", "logistics.checkout.manage")
    for (const route of writes.slice(1)) assert.equal((await route("user")).statusCode, 404)
    // Pedido de outra empresa não inicia conferência aqui.
    assert.equal((await ctx.as("user").post("/api/v1/logistics/checkouts", { body: { orderId: foreign.order } })).statusCode, 404)
    const untouched = await ctx.seed.query("SELECT status,revision::int FROM logistics_checkouts WHERE id=$1", [foreign.id])
    assert.deepEqual(untouched.rows[0], { status: "counting", revision: 2 })
  })
})

/** Conferência com um volume etiquetado e outro embalado. */
async function preparedPackages(ctx: TestContext, tenant = ctx.tenant) {
  const { id, client } = await openCheckout(ctx, tenant)
  const box = { weightGrams: 5_000, lengthMm: 600, widthMm: 400, heightMm: 300 }
  const options = { tenant }
  const first = json(await client.post(`/api/v1/logistics/checkouts/${id}/packages`, { body: { ...box, labelCode: "CX-A" }, revision: 1, ...options })).data
  const second = json(await client.post(`/api/v1/logistics/checkouts/${id}/packages`, { body: { ...box, labelCode: "CX-B" }, revision: 2, ...options })).data
  for (const [packageId, status, revision] of [[first.id, "labelled", 3], [second.id, "labelled", 4], [second.id, "packed", 5]] as const) {
    const moved = await client.post(`/api/v1/logistics/checkouts/${id}/packages/${packageId}/status`, { body: { status }, revision, ...options })
    assert.equal(moved.statusCode, 200, moved.body)
  }
  return { id, client, labelled: first.id as string, packed: second.id as string }
}

test("POST /api/v1/logistics/checkouts/{id}/labels + GET /api/v1/logistics/checkouts/{id}/labels + GET /api/v1/logistics/labels [sucesso] enfileira e lista etiquetas sem vazar outra conferência ou empresa", databaseTestOptions, async () => {
  await withTestContext({ permissions: CHECKOUT }, async ctx => {
    const { id, client, labelled } = await preparedPackages(ctx)
    const other = await openCheckout(ctx)
    await preparedPackages(ctx, ctx.otherTenant).then(async foreign => {
      assert.equal((await foreign.client.post(`/api/v1/logistics/checkouts/${foreign.id}/labels`, { tenant: ctx.otherTenant })).statusCode, 201)
    })
    assert.equal((await client.post(`/api/v1/logistics/checkouts/${other.id}/labels`)).statusCode, 409) // sem volume etiquetado
    assert.equal((await client.post(`/api/v1/logistics/checkouts/${randomUUID()}/labels`)).statusCode, 404)
    assert.equal((await client.post(`/api/v1/logistics/checkouts/${id}/labels`, { body: { printer: "zebra" } })).statusCode, 422)
    assert.equal((await client.post(`/api/v1/logistics/checkouts/${id}/labels`, { idempotencyKey: "nao-uuid" })).statusCode, 422)
    const key = randomUUID()
    const queued = await client.post(`/api/v1/logistics/checkouts/${id}/labels`, { idempotencyKey: key })
    assert.equal(queued.statusCode, 201, queued.body)
    assert.match(String(queued.headers["content-type"]), /^application\/json/)
    assert.equal(json(queued).data.status, "queued")
    assert.equal(json(queued).data.jobIds.length, 1) // só o volume etiquetado (o embalado já passou da etapa)
    const replay = await client.post(`/api/v1/logistics/checkouts/${id}/labels`, { idempotencyKey: key })
    assert.equal(replay.statusCode, 200)
    assert.deepEqual(json(replay), json(queued))
    // Reenfileirar o mesmo volume reaproveita o trabalho existente.
    assert.deepEqual(json(await client.post(`/api/v1/logistics/checkouts/${id}/labels`)).data.jobIds, json(queued).data.jobIds)

    const all = await client.get("/api/v1/logistics/labels")
    assert.equal(all.statusCode, 200)
    assert.match(String(all.headers["content-type"]), /^application\/json/)
    assert.deepEqual(json(all).data.map((job: { packageId: string; labelCode: string; checkoutId: string }) => [job.checkoutId, job.packageId, job.labelCode]), [[id, labelled, "CX-A"]])
    const scoped = await client.get(`/api/v1/logistics/checkouts/${id}/labels`)
    assert.equal(scoped.statusCode, 200)
    assert.equal(json(scoped).data.length, 1)
    assert.deepEqual(json(await client.get(`/api/v1/logistics/checkouts/${other.id}/labels`)).data, [])
    assert.equal((await client.get(`/api/v1/logistics/checkouts/${randomUUID()}/labels`)).statusCode, 404)
  })
})

test("POST /api/v1/logistics/postings/{id}/packages [sucesso] vincula volumes embalados e recusa volume já vinculado ou postagem encerrada", databaseTestOptions, async () => {
  await withTestContext({ permissions: [...CHECKOUT, ...POSTINGS] }, async ctx => {
    const { id, client, packed } = await preparedPackages(ctx)
    const target = json(await client.post("/api/v1/logistics/postings", { body: posting })).data
    const rival = json(await client.post("/api/v1/logistics/postings", { body: posting })).data
    const link = (postingId: string, body: unknown, idempotencyKey?: string) => client.post(`/api/v1/logistics/postings/${postingId}/packages`, { body, ...(idempotencyKey ? { idempotencyKey } : {}) })
    for (const bad of [{}, { checkoutId: "x" }, { checkoutId: id, extra: 1 }]) assert.equal((await link(target.id, bad)).statusCode, 422)
    assert.equal((await link(randomUUID(), { checkoutId: id })).statusCode, 404)
    assert.equal((await link(target.id, { checkoutId: randomUUID() })).statusCode, 409)
    const key = randomUUID()
    const linked = await link(target.id, { checkoutId: id }, key)
    assert.equal(linked.statusCode, 200, linked.body)
    assert.deepEqual(json(linked).data, { postingId: target.id, checkoutId: id, packageIds: [packed] })
    assert.deepEqual(json(await link(target.id, { checkoutId: id }, key)), json(linked))
    assert.equal((await link(target.id, { checkoutId: id })).statusCode, 200) // repetir na mesma postagem é inofensivo
    assert.equal((await link(rival.id, { checkoutId: id })).statusCode, 409) // já vinculado a outra postagem
    assert.equal((await client.post(`/api/v1/logistics/postings/${rival.id}/status`, { body: { status: "cancelled" }, revision: 1 })).statusCode, 200)
    assert.equal((await link(rival.id, { checkoutId: id })).statusCode, 409)
    const rows = await ctx.seed.query("SELECT posting_id,package_id FROM logistics_posting_packages")
    assert.deepEqual(rows.rows, [{ posting_id: target.id, package_id: packed }])
  })
})

test("GET /api/v1/logistics/labels + GET /api/v1/logistics/checkouts/{id}/labels + POST /api/v1/logistics/checkouts/{id}/labels + POST /api/v1/logistics/postings/{id}/packages [negado] sem token, sem permissão, só leitura e outra empresa", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["logistics.checkout.read"] }, async ctx => {
    const foreign = await preparedPackages(ctx, ctx.otherTenant)
    const foreignPosting = json(await foreign.client.post("/api/v1/logistics/postings", { body: posting, tenant: ctx.otherTenant })).data
    assert.equal((await foreign.client.post(`/api/v1/logistics/checkouts/${foreign.id}/labels`, { tenant: ctx.otherTenant })).statusCode, 201)
    type Who = "user" | "denied" | "anonymous"
    const reads = [
      (who: Who, tenant?: string) => ctx.as(who).get("/api/v1/logistics/labels", tenant ? { tenant } : {}),
      (who: Who, tenant?: string) => ctx.as(who).get(`/api/v1/logistics/checkouts/${foreign.id}/labels`, tenant ? { tenant } : {}),
    ]
    const writes = [
      (who: Who, tenant?: string) => ctx.as(who).post(`/api/v1/logistics/checkouts/${foreign.id}/labels`, tenant ? { tenant } : {}),
      (who: Who, tenant?: string) => ctx.as(who).post(`/api/v1/logistics/postings/${foreignPosting.id}/packages`, { body: { checkoutId: foreign.id }, ...(tenant ? { tenant } : {}) }),
    ]
    for (const route of [...reads, ...writes]) {
      assert.equal((await route("anonymous")).statusCode, 401)
      assert.equal((await route("denied")).statusCode, 403)
      assert.equal((await route("user", ctx.otherTenant)).statusCode, 403)
    }
    for (const route of writes) assert.equal((await route("user")).statusCode, 403)
    // Isolamento: as etiquetas da empresa B não aparecem na A.
    assert.deepEqual(json(await reads[0]!("user")).data, [])
    assert.equal((await reads[1]!("user")).statusCode, 404)
    await ctx.grant("user", "logistics.checkout.manage")
    assert.equal((await writes[0]!("user")).statusCode, 404)
    // Vincular volumes altera a postagem: sem gestão de postagens continua negado.
    assert.equal((await writes[1]!("user")).statusCode, 403)
    await ctx.grant("user", "logistics.postings.read", "logistics.postings.manage")
    assert.equal((await writes[1]!("user")).statusCode, 404)
    const linked = await ctx.seed.query("SELECT count(*)::int AS total FROM logistics_posting_packages")
    assert.equal(linked.rows[0].total, 0)
  })
})
