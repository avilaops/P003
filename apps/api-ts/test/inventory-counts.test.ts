import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { copyFile, mkdtemp, readdir, rmdir, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runMigrations } from "../src/platform/migrations.js"
import { stockFixture } from "./stock-fixture.js"

const admin = process.env.API_TS_TEST_ADMIN_URL
test("physical inventory workflows with tenant RLS and exact local quantities", { skip: !admin }, async (t) => {
  const { app, seed, tenant, otherTenant, close } = await stockFixture(admin!)
  t.after(close)
  const call = (method: "POST" | "GET" | "PUT", path: string, body?: object, user = "editor", key: string = randomUUID(), company = tenant) =>
    app.inject({
      method,
      url: "/api/v1" + path,
      headers: { authorization: "Bearer fixture-" + user + "-token", "x-tenant-id": company, "idempotency-key": key },
      ...(body ? { payload: body } : {}),
    })
  const path = "/inventory-counts"
  assert.equal((await call("GET", path)).statusCode, 403)
  await seed.query(`INSERT INTO role_permissions(role_id,permission_code)
    SELECT id,'inventory.counts.read' FROM roles;
    INSERT INTO role_permissions(role_id,permission_code) SELECT id,'inventory.counts.manage' FROM roles WHERE code='editor';
    INSERT INTO role_permissions(role_id,permission_code) SELECT id,'inventory.counts.approve' FROM roles WHERE code IN ('editor','visitor')`)
  const category = randomUUID(),
    product = randomUUID(),
    other = randomUUID(),
    site = randomUUID()
  await seed.query(
    "INSERT INTO product_categories(id,tenant_id,code,name,status,revision,sort_order) VALUES($1,$2,'FIS','Físicos','active',1,0)",
    [category, tenant],
  )
  await seed.query(
    "INSERT INTO products(id,tenant_id,sku,name,unit,category_id,price_cents,status) VALUES($1,$2,'FIS/1','Produto','KG',$3,123,'active'),($4,$2,'OUT/2','Outro','UN',null,10,'active')",
    [product, tenant, category, other],
  )
  await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,10000000)", [tenant, product])
  await seed.query("INSERT INTO warehouses(id,tenant_id,code,name,status,revision) VALUES($1,$2,'LOJA','Loja','active',1)", [site, tenant])
  const settings = await call("PUT", "/stock/locations", { enabled: true, salesId: null, purchaseId: null, productionId: null, revision: 1 })
  assert.equal(settings.statusCode, 200, settings.body)
  const opening = settings.json().openingId
  const transfer = await call("POST", "/stock/transfers", {
    fromId: opening,
    toId: site,
    reason: "Estoque loja",
    items: [{ productId: product, quantity: "2.000000" }],
  })
  assert.equal(transfer.statusCode, 201, transfer.body)
  const create = async (options: object = {}) => {
    const res = await call("POST", path, { reference: "Contagem física", warehouseId: site, categoryId: category, ...options })
    assert.equal(res.statusCode, 201, res.body)
    return res.json().id as string
  }
  const line = { productId: product, countedQuantity: "1.750001" }
  const qty = async () =>
    (
      await seed.query("SELECT quantity_micros FROM stock_positions WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3", [
        tenant,
        product,
        site,
      ])
    ).rows[0].quantity_micros
  await t.test("blind scope, blocking, recount, independent authority and linked adjustment", async () => {
    assert.equal((await call("POST", path, { reference: "Teste" })).statusCode, 422)
    assert.equal((await call("POST", path, { reference: "Teste", warehouseId: site }, "reader")).statusCode, 403)
    const id = await create({ blind: true, lockMovements: true, recountPercent: 10.25 })
    const get = await call("GET", path + "/" + id, undefined, "reader")
    assert.equal(get.statusCode, 200, get.body)
    assert.equal(get.json().lines.length, 1)
    assert.equal(get.json().canEdit, false)
    assert.equal(get.json().lines[0].expectedQuantity, null)
    assert.equal((await call("GET", path + "/" + id, undefined, "reader", randomUUID(), otherTenant)).statusCode, 404)
    const move = { productId: product, warehouseId: site, direction: "receipt", reason: "Durante contagem", quantity: "1.000000" }
    assert.equal((await call("POST", "/stock/movements", move)).statusCode, 409)
    assert.equal((await call("POST", "/stock/movements", { ...move, warehouseId: opening })).statusCode, 201)
    const key = randomUUID()
    assert.equal((await call("POST", path + "/" + id + "/lines", line, "editor", key)).statusCode, 204)
    assert.equal((await call("POST", path + "/" + id + "/lines", line, "editor", key)).statusCode, 204)
    assert.equal((await call("POST", path + "/" + id + "/approve", {}, "visitor")).statusCode, 409)
    assert.equal((await call("POST", path + "/" + id + "/lines", { ...line, recount: true, countedQuantity: "1.900000" })).statusCode, 409)
    assert.equal((await call("POST", path + "/" + id + "/lines", { ...line, recount: true })).statusCode, 204)
    const inspection=(await call("GET",path+"/"+id,undefined,"visitor")).json().lines[0]
    assert.equal(inspection.difference,"-0.249999")
    assert.equal(inspection.expectedQuantity,"2.000000")
    assert.equal((await call("GET",path+"/"+id,undefined,"editor")).json().lines[0].expectedQuantity,null)
    assert.equal((await call("POST", path + "/" + id + "/approve", {})).statusCode, 403)
    const approve = randomUUID(),
      url = path + "/" + id + "/approve"
    const done = await call("POST", url, {}, "visitor", approve)
    assert.equal(done.statusCode, 200, done.body)
    assert.equal((await call("POST", url, {}, "visitor", approve)).statusCode, 200)
    assert.equal(await qty(), "1750001")
    const moves = await seed.query(
      "SELECT warehouse_id,direction,quantity_micros FROM stock_movements WHERE tenant_id=$1 AND inventory_count_id=$2",
      [tenant, id],
    )
    assert.deepEqual(moves.rows, [{ warehouse_id: site, direction: "issue", quantity_micros: "249999" }])
    const next = await create()
    assert.equal((await call("POST", path + "/" + next + "/lines", line, "editor", key)).statusCode, 409)
    assert.equal((await call("POST", path + "/" + next + "/cancel", { reason: "Escopo incorreto" })).statusCode, 200)
  })
  await t.test("round-trip movement after opening invalidates approval and permits cancellation and restart", async () => {
    const id = await create()
    assert.equal((await call("POST", path + "/" + id + "/lines", line)).statusCode, 204)
    for (const direction of ["receipt", "issue"]) {
      assert.equal(
        (
          await call("POST", "/stock/movements", {
            productId: product,
            warehouseId: site,
            quantity: "0.500000",
            direction,
            reason: "Movimento durante o inventário",
          })
        ).statusCode,
        201,
      )
    }
    assert.equal((await call("POST", path + "/" + id + "/approve", {}, "visitor")).statusCode, 409)
    assert.equal((await call("POST", path + "/" + id + "/cancel", { reason: "Recomeçar com posição atual" })).statusCode, 200)
    const fresh = await create()
    assert.equal((await call("POST", path + "/" + fresh + "/lines", line)).statusCode, 204)
    assert.equal((await call("POST", path + "/" + fresh + "/approve", {}, "visitor")).statusCode, 200)
    assert.equal(await qty(), "1750001")
  })
})

test("upgrade retains a previously counted session, grants and command receipts", { skip: !admin }, async (t) => {
  const dir = fileURLToPath(new URL("../../../migrations/", import.meta.url))
  const before = await mkdtemp(join(tmpdir(), "p003-count-before-"))
  t.after(async () => {
    for (const file of await readdir(before)) await unlink(join(before, file))
    await rmdir(before)
  })
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql") && name < "202611170042")
  for (const file of files) await copyFile(join(dir, file), join(before, file))
  const { app, seed, tenant, close } = await stockFixture(admin!, before)
  t.after(close)
  const product = randomUUID(),
    id = randomUUID(),
    stale = randomUUID(),
    key = randomUUID()
  await seed.query(
    "INSERT INTO role_permissions(role_id,permission_code) SELECT id,unnest(ARRAY['inventory.counts.read','inventory.counts.manage']) FROM roles WHERE code IN ('editor','visitor')",
  )
  await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'HIST','Histórico','KG',100,'active')", [
    product,
    tenant,
  ])
  await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,1500000)", [tenant, product])
  await seed.query(
    "INSERT INTO inventory_counts(tenant_id,id,reference,created_by,created_at) VALUES($1,$2,'Historicamente contado','editor',now()),($1,$3,'Sessão antiga','editor',now()-interval '2 days')",
    [tenant, id, stale],
  )
  await seed.query(
    "INSERT INTO inventory_count_lines(tenant_id,count_id,product_id,expected_quantity_micros,counted_quantity_micros,counted_at) VALUES($1,$2,$3,1500000,1250000,now()),($1,$4,$3,1000000,null,null)",
    [tenant, id, product, stale],
  )
  await seed.query(
    "INSERT INTO stock_movements(tenant_id,id,product_id,direction,quantity_micros,balance_after_micros,reason,created_at) VALUES($1,$2,$3,'receipt',500000,1500000,'Recebimento anterior',now()-interval '1 day')",
    [tenant, randomUUID(), product],
  )
  await seed.query(
    `INSERT INTO audit_log(identity_id,tenant_id,action,entity_type,entity_id,details)
    SELECT id,$1,'inventory.count.line_counted','inventory_count',$2,$3 FROM identities WHERE auth_subject='editor'`,
    [tenant, id, { productId: product, countedQuantity: "1.250000" }],
  )
  const input = { productId: product, countedQuantity: "1.250000", note: null }
  await seed.query(
    "INSERT INTO domain_commands(tenant_id,auth_subject,command_key,scope,request,result) VALUES($1,'editor',$2,'inventory.count.line',$3,$4)",
    [tenant, key, input, { productId: product, countId: id }],
  )
  const migrated = await runMigrations(seed, { directory: dir })
  assert.ok(migrated.applied.includes("202611170042"))
  const req = (path: string, user: string, body: object, cmd: string = randomUUID()) =>
    app.inject({
      method: "POST",
      url: "/api/v1/inventory-counts/" + path,
      headers: { authorization: "Bearer fixture-" + user + "-token", "idempotency-key": cmd, "x-tenant-id": tenant },
      payload: body,
    })
  assert.equal((await req(id + "/lines", "editor", input, key)).statusCode, 204)
  assert.equal((await req(stale + "/lines", "editor", input, key)).statusCode, 409)
  const detail = await app.inject({
    method: "GET",
    url: "/api/v1/inventory-counts/" + stale,
    headers: { authorization: "Bearer fixture-editor-token", "x-tenant-id": tenant },
  })
  assert.equal(detail.json().lines[0].stockChanged, true)
  const approved = await req(id + "/approve", "visitor", {})
  assert.equal(approved.statusCode, 200, approved.body)
  const rows = await seed.query("SELECT quantity_micros FROM stock_balances WHERE tenant_id=$1 AND product_id=$2", [tenant, product])
  assert.equal(rows.rows[0].quantity_micros, "1250000")
})
