import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { Pool as PgPool } from "pg"

import { buildApp } from "../src/app.js"
import { PgClientAdapter } from "../src/platform/database.js"
import { csvCell, parseCsv } from "../src/modules/data-transfer/csv.js"
import type { CatalogMedia } from "../src/platform/catalog-media.js"
import { databaseTestOptions, withTestContext, type TestContext } from "./support/test-context.js"

// Listas de preço (price_lists.rs), importação/exportação de produtos (data_transfer.rs) e perfil de catálogo por
// produto (catalog_publication.rs). `user` administra a empresa A; `denied` só consulta produtos;
// `outsider` administra apenas a empresa B. O canal de mídia do catálogo é um stub.

test("CSV parser handles quotes, delimiters and neutralizes spreadsheet formulas", () => {
  assert.deepEqual(parseCsv("sku;name\nA-1;\"Mesa; grande\"\n")[1], ["A-1", "Mesa; grande"])
  assert.throws(() => parseCsv("sku,name\n\"aberta\n"))
  assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)")
  assert.equal(csvCell("\tcmd"), "'\tcmd")
  assert.equal(csvCell('Ele "disse"'), '"Ele ""disse"""')
})

async function seedProducts(ctx: TestContext) {
  await ctx.seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT r.id,p.code FROM roles r CROSS JOIN permissions p WHERE r.code='user' AND r.tenant_id=$1 ON CONFLICT DO NOTHING", [ctx.tenant])
  await ctx.grant("denied", "catalog.products.read")
  // Mesmos privilégios da produção (deploy/bootstrap.sql e deploy/grant-catalog-publication.sql).
  await ctx.seed.query(`GRANT DELETE ON ALL TABLES IN SCHEMA public TO ${ctx.role}`)
  await ctx.seed.query(`GRANT USAGE ON SCHEMA system_config TO ${ctx.role}; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA system_config TO ${ctx.role}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA system_config TO ${ctx.role}`)
  const [p1, p2, archived, foreign, bare] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  await ctx.seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$6,'LD-1','Banco','UN',10000,'active'),($2,$6,'LD-2','Anilha','UN',2550,'active'),($3,$6,'LD-3','Antigo','UN',100,'archived'),($4,$7,'LD-9','Externo','UN',100,'active'),($5,$6,'LD-4','Sem perfil','UN',100,'active')", [p1, p2, archived, foreign, bare, ctx.tenant, ctx.otherTenant])
  const userIdentity = (await ctx.seed.query<{ id: string }>("SELECT id FROM identities WHERE auth_subject='user'")).rows[0]!.id
  return { p1, p2, archived, foreign, bare, userIdentity, tenant: ctx.tenant, other: ctx.otherTenant }
}
const headers = (tenantDefault: string) => (token: string, tenant = tenantDefault, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, "x-tenant-id": tenant, ...extra })
const key = () => ({ "idempotency-key": randomUUID() })

test("listas de preço", databaseTestOptions, async t => {
  await withTestContext({}, async ctx => {
    const { p1, p2, archived, foreign, tenant, other } = await seedProducts(ctx)
    const app = ctx.app, H = headers(tenant)
    const list = { code: " retail ", name: "Varejo", status: "active", validFrom: "2026-11-01", validUntil: "2026-12-31", notes: null, items: [{ productId: p1, price: "90.00" }, { productId: p2, price: "20.50" }] }
    let url = ""
    await t.test("GET /api/v1/price-lists + POST /api/v1/price-lists + GET /api/v1/price-lists/{id} + PUT /api/v1/price-lists/{id} [negado] sem token, de outra empresa e sem permissão de gerenciar", async () => {
      const id = randomUUID()
      for (const [method, path] of [["GET", "/api/v1/price-lists"], ["POST", "/api/v1/price-lists"], ["GET", `/api/v1/price-lists/${id}`], ["PUT", `/api/v1/price-lists/${id}`]] as const) {
        assert.equal((await app.inject({ method, url: path, headers: { "x-tenant-id": tenant, ...key(), "if-match": '"1"' }, payload: list })).statusCode, 401, path)
        assert.equal((await app.inject({ method, url: path, headers: H("outsider", tenant, { ...key(), "if-match": '"1"' }), payload: list })).statusCode, 403, path)
      }
      assert.equal((await app.inject({ method: "POST", url: "/api/v1/price-lists", headers: H("denied", tenant, key()), payload: list })).statusCode, 403)
      assert.equal((await app.inject({ method: "PUT", url: `/api/v1/price-lists/${id}`, headers: H("denied", tenant, { ...key(), "if-match": '"1"' }), payload: list })).statusCode, 403)
    })
    await t.test("POST /api/v1/price-lists [sucesso] cria com Idempotency-Key, inclusive em requisições simultâneas", async () => {
      assert.equal((await app.inject({ method: "POST", url: "/api/v1/price-lists", headers: H("user"), payload: list })).statusCode, 428)
      for (const payload of [{ ...list, items: [] }, { ...list, items: [{ productId: p1, price: "1.5" }] }, { ...list, items: [list.items[0], list.items[0]] }, { ...list, validUntil: "2026-10-01" }, { ...list, validFrom: "1800-01-01" }, { ...list, status: "x" }, { ...list, extra: 1 }, { ...list, code: "bad code" }]) {
        assert.equal((await app.inject({ method: "POST", url: "/api/v1/price-lists", headers: H("user", tenant, key()), payload })).statusCode, 422, JSON.stringify(payload).slice(0, 80))
      }
  for (const items of [[{ productId: archived, price: "1.00" }], [{ productId: foreign, price: "1.00" }]]) assert.equal((await app.inject({ method: "POST", url: "/api/v1/price-lists", headers: H("user", tenant, key()), payload: { ...list, items } })).statusCode, 422, "Inactive or foreign products are refused")
      const createKey = key()
      const created = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/v1/price-lists", headers: H("user", tenant, createKey), payload: list })))
      for (const response of created) assert.equal(response.statusCode, 201, response.body)
      assert.deepEqual(created[0]!.json(), created[1]!.json())
      const priceList = created[0]!.json()
      assert.equal(priceList.data.code, "RETAIL")
      assert.equal(priceList.data.revision, 1)
      assert.deepEqual(priceList.data.items.map((item: { price: string }) => item.price), ["20.50", "90.00"])
      assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM price_lists WHERE tenant_id=$1", [tenant])).rows[0].n, 1)
      assert.equal((await app.inject({ method: "POST", url: "/api/v1/price-lists", headers: H("user", tenant, createKey), payload: { ...list, name: "Outro" } })).statusCode, 409, "Same key, different body")
      assert.equal((await app.inject({ method: "POST", url: "/api/v1/price-lists", headers: H("user", tenant, key()), payload: list })).statusCode, 409, "Duplicate code")
      url = `/api/v1/price-lists/${priceList.data.id}`
    })
    await t.test("GET /api/v1/price-lists + GET /api/v1/price-lists/{id} [sucesso] lista com filtros e detalha com ETag", async () => {
  const detail = await app.inject({ method: "GET", url: url, headers: H("denied") })
      assert.equal(detail.statusCode, 200, detail.body)
      assert.equal(detail.headers.etag, '"1"')
      assert.equal(detail.json().canEdit, false)
      assert.equal((await app.inject({ method: "GET", url: `/api/v1/price-lists?q=retail&status=active`, headers: H("denied") })).json().total, 1)
      assert.equal((await app.inject({ method: "GET", url: `/api/v1/price-lists?limit=0`, headers: H("denied") })).statusCode, 422)
      assert.equal((await app.inject({ method: "GET", url, headers: H("outsider", other) })).statusCode, 404)
      assert.equal((await app.inject({ method: "GET", url: "/api/v1/price-lists", headers: H("outsider", other) })).json().total, 0)
    })
    await t.test("PUT /api/v1/price-lists/{id} [sucesso] altera com If-Match e Idempotency-Key e recusa revisão antiga", async () => {
  const update = { ...list, name: "Varejo 2", items: [{ productId: p1, price: "95.00" }] }
      assert.equal((await app.inject({ method: "PUT", url, headers: H("user", tenant, key()), payload: update })).statusCode, 428)
      assert.equal((await app.inject({ method: "PUT", url, headers: H("user", tenant, { "if-match": '"1"' }), payload: update })).statusCode, 428)
      assert.equal((await app.inject({ method: "PUT", url, headers: H("user", tenant, { ...key(), "if-match": '"7"' }), payload: update })).statusCode, 412)
      assert.equal((await app.inject({ method: "PUT", url, headers: H("denied", tenant, { ...key(), "if-match": '"1"' }), payload: update })).statusCode, 403)
      const updateKey = { ...key(), "if-match": '"1"' }
      const updates = await Promise.all([1, 2].map(() => app.inject({ method: "PUT", url, headers: H("user", tenant, updateKey), payload: update })))
      for (const response of updates) assert.equal(response.statusCode, 200, response.body)
      assert.equal(updates[0]!.json().data.revision, 2)
      assert.deepEqual(updates[0]!.json(), updates[1]!.json())
      assert.equal(updates[0]!.json().data.items.length, 1)
      assert.equal((await app.inject({ method: "PUT", url, headers: H("user", tenant, { ...key(), "if-match": '"1"' }), payload: update })).statusCode, 412, "Stale revision")
      // Tenant isolation.
      assert.equal((await app.inject({ method: "PUT", url, headers: H("outsider", other, { ...key(), "if-match": '"2"' }), payload: { ...update, items: [{ productId: foreign, price: "1.00" }] } })).statusCode, 404)
    })
  })
})

test("importação e exportação de produtos", databaseTestOptions, async t => {
  await withTestContext({}, async ctx => {
    const { bare, tenant, other } = await seedProducts(ctx)
    const app = ctx.app, H = headers(tenant)
  const csv = "sku,name,unit,ncm,cest,base_price,status\nld-10,Banco novo,un,12345678,,150.00,active\nLD-1,Banco repetido,UN,,,10.00,active\nLD-11,\"Mesa, grande\",UN,,,20.00,\n"
    const importUrl = "/api/v1/products/import"
    let job = ""
    await t.test("POST /api/v1/products/import + GET /api/v1/products/import/{id} + POST /api/v1/products/import/{id}/confirm + GET /api/v1/products/export [negado] sem token, de outra empresa e sem permissão", async () => {
      const id = `${importUrl}/${randomUUID()}`
      for (const [method, path] of [["POST", importUrl], ["GET", id], ["POST", `${id}/confirm`], ["GET", "/api/v1/products/export"]] as const) {
        assert.equal((await app.inject({ method, url: path, headers: { "x-tenant-id": tenant, ...key() }, payload: { filename: "p.csv", content: csv } })).statusCode, 401, path)
        assert.equal((await app.inject({ method, url: path, headers: H("outsider", tenant, key()), payload: { filename: "p.csv", content: csv } })).statusCode, 403, path)
        assert.equal((await app.inject({ method, url: path, headers: H("denied", tenant, key()), payload: { filename: "p.csv", content: csv } })).statusCode, 403, path)
      }
    })
    await t.test("POST /api/v1/products/import [sucesso] gera prévia; arquivo inválido responde 422 com as linhas", async () => {
  for (const payload of [{ filename: "p.txt", content: csv }, { filename: "p.csv" }, { filename: "p.csv", content: "" }, { filename: "p.csv", content: "sku,name\n" }, { filename: "p.csv", content: "sku,foo\nA,B\n" }, { filename: "p.csv", content: "sku,name,sku\nA,B,C\n" }, { filename: "p.csv", content: 'sku,name\nA,"aberta\n' }, { filename: "p.csv", content: csv, extra: 1 }]) {
        assert.equal((await app.inject({ method: "POST", url: importUrl, headers: H("user"), payload })).statusCode, 422, JSON.stringify(payload).slice(0, 80))
      }
      const bad = await app.inject({ method: "POST", url: importUrl, headers: H("user"), payload: { filename: "p.csv", content: "sku,name,unit,base_price\nLD-20,Ok,UN,1.00\nLD-21,,UN,1.00\nLD-22,Mau,UN,1,5\nLD-23,Preço,UN,abc\n" } })
      assert.equal(bad.statusCode, 422, bad.body)
      assert.deepEqual(bad.json().errors.map((item: { line: number }) => item.line), [3, 4, 5])
      assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM product_import_jobs")).rows[0].n, 0, "A rejected file stores nothing")
      const preview = await app.inject({ method: "POST", url: importUrl, headers: H("user"), payload: { filename: "p.csv", content: csv } })
      assert.equal(preview.statusCode, 201, preview.body)
      assert.deepEqual([preview.json().data.valid, preview.json().data.conflicts, preview.json().data.invalid], [2, 1, 0])
      const again = await app.inject({ method: "POST", url: importUrl, headers: H("user"), payload: { filename: "renamed.csv", content: csv } })
      assert.equal(again.statusCode, 200)
      assert.equal(again.json().data.id, preview.json().data.id, "Same content, same preview")
      job = `${importUrl}/${preview.json().data.id}`
    })
    await t.test("GET /api/v1/products/import/{id} [sucesso] consulta a prévia só na empresa", async () => {
      assert.equal((await app.inject({ method: "GET", url: job, headers: H("user") })).json().data.status, "previewed")
      assert.equal((await app.inject({ method: "GET", url: job, headers: H("outsider", other) })).statusCode, 404, "outra empresa não vê a prévia")
      assert.equal((await app.inject({ method: "GET", url: `${importUrl}/${randomUUID()}`, headers: H("user") })).statusCode, 404)
    })
    await t.test("POST /api/v1/products/import/{id}/confirm [sucesso] importa uma única vez com Idempotency-Key", async () => {
      assert.equal((await app.inject({ method: "POST", url: `${job}/confirm`, headers: H("user") })).statusCode, 428)
      assert.equal((await app.inject({ method: "POST", url: `${job}/confirm`, headers: H("outsider", other, key()) })).statusCode, 404)
  const confirmKey = key()
      const confirms = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: `${job}/confirm`, headers: H("user", tenant, confirmKey) })))
      for (const response of confirms) assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(confirms[0]!.json().data.result, { imported: 2, total: 3 })
      assert.equal((await app.inject({ method: "POST", url: `${job}/confirm`, headers: H("user", tenant, key()) })).json().data.status, "imported")
      const imported = await ctx.seed.query("SELECT sku,unit,price_cents::int AS cents FROM products WHERE tenant_id=$1 AND sku IN ('LD-10','LD-11') ORDER BY sku", [tenant])
      assert.deepEqual(imported.rows, [{ sku: "LD-10", unit: "UN", cents: 15000 }, { sku: "LD-11", unit: "UN", cents: 2000 }])
      assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM audit_log WHERE action='products.imported'")).rows[0].n, 1, "Imported exactly once")
      assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM products WHERE tenant_id=$1 AND sku='LD-1'", [tenant])).rows[0].n, 1, "Conflicting SKU was not duplicated")

      // A mesma chave usada em outra importação é conflito.
      const other2 = await app.inject({ method: "POST", url: importUrl, headers: H("user"), payload: { filename: "q.csv", content: "sku,name,unit,base_price\nLD-30,Outro,UN,1.00\n" } })
      assert.equal((await app.inject({ method: "POST", url: `${importUrl}/${other2.json().data.id}/confirm`, headers: H("user", tenant, confirmKey) })).statusCode, 409)
    })
    await t.test("GET /api/v1/products/export [sucesso] exporta CSV da empresa neutralizando fórmulas", async () => {
  await ctx.seed.query("UPDATE products SET name='=HYPERLINK(1)' WHERE tenant_id=$1 AND id=$2", [tenant, bare])
      assert.equal((await app.inject({ method: "GET", url: "/api/v1/products/export?status=x", headers: H("user") })).statusCode, 422)
      const exported = await app.inject({ method: "GET", url: "/api/v1/products/export?status=active", headers: H("user") })
      assert.equal(exported.statusCode, 200)
      assert.match(String(exported.headers["content-type"]), /^text\/csv/)
      assert.match(String(exported.headers["content-disposition"]), /produtos\.csv/)
      assert.ok(exported.body.startsWith("sku,name,unit,ncm,cest,base_price,status\r\n"))
      assert.ok(exported.body.includes("LD-10,Banco novo,UN,12345678,,150.00,active"))
      assert.ok(exported.body.includes("'=HYPERLINK(1)"))
      assert.ok(!exported.body.includes("LD-9") && !exported.body.includes("LD-3"), "No foreign or archived rows")
      assert.ok((await app.inject({ method: "GET", url: "/api/v1/products/export", headers: H("outsider", other) })).body.includes("LD-9"))
      assert.ok(!(await app.inject({ method: "GET", url: "/api/v1/products/export", headers: H("outsider", other) })).body.includes("LD-10"))
    })
  })
})

test("perfil de catálogo e mídias do produto", databaseTestOptions, async t => {
  const read: string[] = []
  await withTestContext({}, async ctx => {
    const { p1, p2, foreign, userIdentity, tenant, other } = await seedProducts(ctx)
    const media: CatalogMedia = { tenantId: tenant, async publish() {}, async readPrivate(key: string) { read.push(key); return Buffer.from("RIFF") } }
    // O app do contexto não tem canal de mídia; este usa o mesmo banco com o stub configurado para a empresa A.
    const app = buildApp({ ...appDependencies(ctx), catalogMedia: media }), unconfigured = ctx.app, H = headers(tenant)
    try {
    const catalog = `/api/v1/products/${p1}/catalog`
    const profile = { collection: "core", muscleGroup: "Peito", technicalCategory: "Banco", dimensionsMm: [1200, 800, 900], description: "Banco ajustável", weight: "30 kg", weightStack: "", mainMediaId: null }
    await t.test("GET /api/v1/products/{id}/catalog + PUT /api/v1/products/{id}/catalog + GET /api/v1/products/{id}/media/{media_id} [negado] sem token, de outra empresa e sem permissão de gerenciar", async () => {
      const mediaUrl = `/api/v1/products/${p1}/media/${randomUUID()}`
      for (const [method, path] of [["GET", catalog], ["PUT", catalog], ["GET", mediaUrl]] as const) {
        assert.equal((await app.inject({ method, url: path, headers: { "x-tenant-id": tenant, "if-match": '"0"' }, payload: profile })).statusCode, 401, path)
        assert.equal((await app.inject({ method, url: path, headers: H("outsider", tenant, { "if-match": '"0"' }), payload: profile })).statusCode, 403, path)
      }
      assert.equal((await app.inject({ method: "PUT", url: catalog, headers: H("denied", tenant, { "if-match": '"0"' }), payload: profile })).statusCode, 403)
    })
    await t.test("GET /api/v1/products/{id}/catalog + PUT /api/v1/products/{id}/catalog [sucesso] cria e altera o perfil com If-Match", async () => {
  const empty = await app.inject({ method: "GET", url: catalog, headers: H("denied") })
      assert.equal(empty.statusCode, 200, empty.body)
      assert.equal(empty.headers.etag, '"0"')
      assert.deepEqual([empty.json().data, empty.json().assets, empty.json().defaultCollection, empty.json().mediaConfigured, empty.json().canEdit], [null, [], "core", true, false])
      assert.equal((await app.inject({ method: "GET", url: `/api/v1/products/${randomUUID()}/catalog`, headers: H("denied") })).statusCode, 404)
      assert.equal((await app.inject({ method: "GET", url: catalog, headers: H("outsider", other) })).statusCode, 404, "Product of another tenant")
      assert.equal((await app.inject({ method: "PUT", url: catalog, headers: H("user"), payload: profile })).statusCode, 428)
      assert.equal((await app.inject({ method: "PUT", url: catalog, headers: H("user", tenant, { "if-match": '"3"' }), payload: profile })).statusCode, 412, "No profile yet")
      for (const payload of [{ ...profile, collection: "x" }, { ...profile, dimensionsMm: [0, 1, 1] }, { ...profile, dimensionsMm: [1, 1] }, { ...profile, mainMediaId: undefined }, { ...profile, catalogSources: [{ title: "Fonte", url: "http://inseguro.test" }] }, { ...profile, catalogSources: [{ title: "Fonte", url: "https://u:p@site.test" }] }, { ...profile, extra: true }, { ...profile, mainMediaId: randomUUID() }, { ...profile, newImage: "data:image/png;base64,AAAA" }, { ...profile, manufacturer: 7 }]) {
        assert.equal((await app.inject({ method: "PUT", url: catalog, headers: H("user", tenant, { "if-match": '"0"' }), payload })).statusCode, 422, JSON.stringify(payload).slice(0, 90))
      }
      const saved = await app.inject({ method: "PUT", url: catalog, headers: H("user", tenant, { "if-match": '"0"' }), payload: { ...profile, manufacturer: " Ludus ", catalogSources: [{ title: "Catálogo", url: "https://ludusequipamentos.com/c.pdf", pdfPage: 3 }] } })
      assert.equal(saved.statusCode, 200, saved.body)
      assert.deepEqual(saved.json(), { saved: true, revision: 1, mainMediaId: null })
      assert.equal(saved.headers.etag, '"1"')
      const stored = (await app.inject({ method: "GET", url: catalog, headers: H("denied") })).json()
      assert.equal(stored.data.publicPath, `/core/product-${p1}/`)
      assert.equal(stored.data.manufacturer, "Ludus")
      assert.deepEqual(stored.data.catalogSources, [{ title: "Catálogo", url: "https://ludusequipamentos.com/c.pdf", pdfPage: 3, printedPage: null }])
      // Omitted optional metadata is preserved; a stale writer loses.
      assert.equal((await app.inject({ method: "PUT", url: catalog, headers: H("user", tenant, { "if-match": '"0"' }), payload: profile })).statusCode, 412)
      const second = await app.inject({ method: "PUT", url: catalog, headers: H("user", tenant, { "if-match": '"1"' }), payload: { ...profile, description: "Nova" } })
      assert.equal(second.json().revision, 2)
      assert.equal((await app.inject({ method: "GET", url: catalog, headers: H("denied") })).json().data.manufacturer, "Ludus")
      assert.equal((await app.inject({ method: "PUT", url: `/api/v1/products/${foreign}/catalog`, headers: H("user", tenant, { "if-match": '"0"' }), payload: profile })).statusCode, 404, "Cannot write another tenant's product")
      assert.equal((await ctx.seed.query("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'catalog.profile.%'")).rows[0].n, 2)
      const nulls = await app.inject({ method: "PUT", url: catalog, headers: H("user", tenant, { "if-match": '"2"' }), payload: { ...profile, manufacturer: null, catalogSources: null } })
      assert.equal(nulls.statusCode, 200, nulls.body)
      assert.equal((await app.inject({ method: "GET", url: catalog, headers: H("denied") })).json().data.manufacturer, "Ludus", "null mantém o valor salvo")
    })
    await t.test("GET /api/v1/products/{id}/media/{media_id} [sucesso] entrega a imagem privada só para a empresa dona", async () => {
  const file = randomUUID(), mediaId = randomUUID()
      await ctx.seed.query("INSERT INTO system_config.files(tenant_id,id,storage_key,original_name,media_type,byte_size,sha256,status,created_by) VALUES($1,$2,'r2://ludus-equipamentos-midias/ludus/catalogo/uploads/abc/core/LD-1/web.webp','web.webp','image/webp',4,$3,'available',$4)", [tenant, file, "a".repeat(64), userIdentity])
      await ctx.seed.query("INSERT INTO product_media_assets(tenant_id,id,product_id,file_id,collection,variant,version,width_px,height_px) VALUES($1,$2,$3,$4,'core','webp',1,10,10)", [tenant, mediaId, p1, file])
      const withMedia = (await app.inject({ method: "GET", url: catalog, headers: H("denied") })).json()
      assert.deepEqual(withMedia.assets, [{ id: mediaId, variant: "webp", version: 1, width: 10, height: 10, mediaType: "image/webp" }])
      assert.equal((await app.inject({ method: "PUT", url: `/api/v1/products/${p2}/catalog`, headers: H("user", tenant, { "if-match": '"0"' }), payload: { ...profile, mainMediaId: mediaId } })).statusCode, 422, "Media of another product")
      assert.equal((await app.inject({ method: "PUT", url: catalog, headers: H("user", tenant, { "if-match": '"3"' }), payload: { ...profile, mainMediaId: mediaId } })).statusCode, 200)
      const mediaUrl = `${catalog.replace("/catalog", "")}/media/${mediaId}`
      const image = await app.inject({ method: "GET", url: mediaUrl, headers: H("denied") })
      assert.equal(image.statusCode, 200, image.body)
      assert.equal(image.headers["content-type"], "image/webp")
      assert.equal(image.headers["cache-control"], "private, no-store")
      assert.equal(image.headers["x-content-type-options"], "nosniff")
      assert.equal(image.rawPayload.toString(), "RIFF")
      assert.equal((await app.inject({ method: "GET", url: mediaUrl, headers: H("outsider", other) })).statusCode, 404, "Other tenants cannot read the image")
      assert.equal((await app.inject({ method: "GET", url: `${catalog.replace("/catalog", "")}/media/${randomUUID()}`, headers: H("denied") })).statusCode, 404)
      assert.equal((await unconfigured.inject({ method: "GET", url: mediaUrl, headers: H("denied") })).statusCode, 409, "Gateway not configured")
      assert.deepEqual(read, ["uploads/abc/core/LD-1/web.webp"])
    })
    } finally { await app.close() }
  })
})

function appDependencies(ctx: TestContext) {
  // Reaproveita a fixture: mesmo Auth simulado e mesma role NOSUPERUSER NOBYPASSRLS, por um pool próprio.
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL!); url.pathname = `/${ctx.database}`
  const runtime = new PgPool({ connectionString: url.href })
  ctx.app.addHook("onClose", async () => { await runtime.end() })
  return {
    userinfoUrl: "http://auth.test/userinfo",
    fetchAuth: async (_url: unknown, init?: RequestInit) => {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? ""
      return ["user", "denied", "outsider"].includes(token) ? Response.json({ sub: token, email: `${token}@example.test` }) : new Response(null, { status: 401 })
    },
    pool: { async connect() { const client = await runtime.connect(); await client.query(`SET ROLE ${ctx.role}`); return new PgClientAdapter(client) } },
  }
}
