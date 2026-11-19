import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { Pool } from "pg"

import { buildApp } from "../src/app.js"
import type { CatalogMedia } from "../src/platform/catalog-media.js"
import { PgClientAdapter, type DatabasePool } from "../src/platform/database.js"
import { parseCsv, csvCell } from "../src/modules/data-transfer/csv.js"

test("CSV parser handles quotes, delimiters and neutralizes spreadsheet formulas", () => {
  assert.deepEqual(parseCsv("sku;name\nA-1;\"Mesa; grande\"\n")[1], ["A-1", "Mesa; grande"])
  assert.throws(() => parseCsv("sku,name\n\"aberta\n"))
  assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)")
  assert.equal(csvCell('Ele "disse"'), '"Ele ""disse"""')
})

// Opt in with a disposable PostgreSQL administrator URL; the database and role are removed afterwards.
test("price lists, product CSV transfer and catalog profiles keep contracts, idempotency and tenant isolation", { skip: !process.env.API_TS_TEST_ADMIN_URL }, async () => {
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL!)
  const suffix = randomUUID().replaceAll("-", ""), database = `api_ts_test_${suffix}`, role = `api_ts_role_${suffix}`
  const admin = new Pool({ connectionString: url.toString() })
  await admin.query(`CREATE DATABASE ${database}`)
  url.pathname = `/${database}`
  const seed = new Pool({ connectionString: url.toString() })
  const connections = new Pool({ connectionString: url.toString() })
  try {
    const directory = new URL("../../../migrations/", import.meta.url)
    for (const file of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) await seed.query(await readFile(new URL(file, directory), "utf8"))
    await seed.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    await seed.query(`GRANT USAGE ON SCHEMA public,system_config TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public,system_config TO ${role}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA system_config TO ${role}`)
    const [tenant, other] = [randomUUID(), randomUUID()]
    await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa A','04252011000110'),($2,'Empresa B','52998224725')", [tenant, other])
    // admin: everything; reader: read only; nobody: member without permissions; bob: administrator of B only.
    const grants: Record<string, [string, string[]]> = {
      admin: [tenant, ["catalog.products.read", "catalog.products.manage", "catalog.products.import", "catalog.products.export"]],
      reader: [tenant, ["catalog.products.read"]],
      nobody: [tenant, []],
      bob: [other, ["catalog.products.read", "catalog.products.manage", "catalog.products.import", "catalog.products.export"]],
    }
    const identities: Record<string, string> = {}
    for (const [name, [tenantId, permissions]] of Object.entries(grants)) {
      const identity = randomUUID(), roleId = randomUUID()
      identities[name] = identity
      await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,$2,$3,$2)", [identity, name, `${name}@example.test`])
      await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [randomUUID(), tenantId, identity])
      await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,$3,$3)", [roleId, tenantId, `r-${name}`])
      await seed.query("INSERT INTO membership_roles(membership_id,role_id) SELECT id,$2 FROM tenant_memberships WHERE tenant_id=$1 AND identity_id=$3", [tenantId, roleId, identity])
      for (const permission of permissions) await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)", [roleId, permission])
    }
    const [p1, p2, archived, foreign, bare] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$6,'LD-1','Banco','UN',10000,'active'),($2,$6,'LD-2','Anilha','UN',2550,'active'),($3,$6,'LD-3','Antigo','UN',100,'archived'),($4,$7,'LD-9','Externo','UN',100,'active'),($5,$6,'LD-4','Sem perfil','UN',100,'active')", [p1, p2, archived, foreign, bare, tenant, other])

    const gateway: CatalogMedia = { tenantId: tenant, async publish() {}, async readPrivate(key: string) { assert.equal(key, "uploads/abc/core/LD-1/web.webp"); return Buffer.from("RIFF") } }
    const pool: DatabasePool = { async connect() { const client = await connections.connect(); await client.query(`SET ROLE ${role}`); return new PgClientAdapter(client) } }
    const buildWith = (catalogMedia?: CatalogMedia) => buildApp({ pool, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async (_url, init) => { const token = new Headers(init?.headers).get("authorization")!.slice(7); return Response.json({ sub: token, email: `${token}@example.test`, email_verified: true }) }, ...(catalogMedia ? { catalogMedia } : {}) } as Parameters<typeof buildApp>[0])
    const app = buildWith(gateway)
    const as = (user: string, tenantId = tenant, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${user}`, "x-tenant-id": tenantId, ...extra })
    const key = () => ({ "idempotency-key": randomUUID() })

    // ---- price lists ----
    const list = { code: " retail ", name: "Varejo", status: "active", validFrom: "2026-11-01", validUntil: "2026-12-31", notes: null, items: [{ productId: p1, price: "90.00" }, { productId: p2, price: "20.50" }] }
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/price-lists", headers: { "x-tenant-id": tenant } })).statusCode, 401)
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/price-lists", headers: as("nobody") })).statusCode, 403)
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/price-lists", headers: as("reader", tenant, key()), payload: list })).statusCode, 403)
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/price-lists", headers: as("admin"), payload: list })).statusCode, 428)
    for (const payload of [{ ...list, items: [] }, { ...list, items: [{ productId: p1, price: "1.5" }] }, { ...list, items: [list.items[0], list.items[0]] }, { ...list, validUntil: "2026-10-01" }, { ...list, status: "x" }, { ...list, extra: 1 }, { ...list, code: "bad code" }]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/v1/price-lists", headers: as("admin", tenant, key()), payload })).statusCode, 422, JSON.stringify(payload).slice(0, 80))
    }
    for (const items of [[{ productId: archived, price: "1.00" }], [{ productId: foreign, price: "1.00" }]]) assert.equal((await app.inject({ method: "POST", url: "/api/v1/price-lists", headers: as("admin", tenant, key()), payload: { ...list, items } })).statusCode, 422, "Inactive or foreign products are refused")
    const createKey = key()
    const created = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/v1/price-lists", headers: as("admin", tenant, createKey), payload: list })))
    for (const response of created) assert.equal(response.statusCode, 201, response.body)
    assert.deepEqual(created[0]!.json(), created[1]!.json())
    const priceList = created[0]!.json()
    assert.equal(priceList.data.code, "RETAIL")
    assert.equal(priceList.data.revision, 1)
    assert.deepEqual(priceList.data.items.map((item: { price: string }) => item.price), ["20.50", "90.00"])
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM price_lists WHERE tenant_id=$1", [tenant])).rows[0].n, 1)
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/price-lists", headers: as("admin", tenant, createKey), payload: { ...list, name: "Outro" } })).statusCode, 409, "Same key, different body")
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/price-lists", headers: as("admin", tenant, key()), payload: list })).statusCode, 409, "Duplicate code")
    const detail = await app.inject({ method: "GET", url: `/api/v1/price-lists/${priceList.data.id}`, headers: as("reader") })
    assert.equal(detail.statusCode, 200, detail.body)
    assert.equal(detail.headers.etag, '"1"')
    assert.equal(detail.json().canEdit, false)
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/price-lists?q=retail&status=active`, headers: as("reader") })).json().total, 1)
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/price-lists?limit=0`, headers: as("reader") })).statusCode, 422)
    const update = { ...list, name: "Varejo 2", items: [{ productId: p1, price: "95.00" }] }
    const url = `/api/v1/price-lists/${priceList.data.id}`
    assert.equal((await app.inject({ method: "PUT", url, headers: as("admin", tenant, key()), payload: update })).statusCode, 428)
    assert.equal((await app.inject({ method: "PUT", url, headers: as("admin", tenant, { "if-match": '"1"' }), payload: update })).statusCode, 428)
    assert.equal((await app.inject({ method: "PUT", url, headers: as("admin", tenant, { ...key(), "if-match": '"7"' }), payload: update })).statusCode, 412)
    assert.equal((await app.inject({ method: "PUT", url, headers: as("reader", tenant, { ...key(), "if-match": '"1"' }), payload: update })).statusCode, 403)
    const updateKey = { ...key(), "if-match": '"1"' }
    const updates = await Promise.all([1, 2].map(() => app.inject({ method: "PUT", url, headers: as("admin", tenant, updateKey), payload: update })))
    for (const response of updates) assert.equal(response.statusCode, 200, response.body)
    assert.equal(updates[0]!.json().data.revision, 2)
    assert.deepEqual(updates[0]!.json(), updates[1]!.json())
    assert.equal(updates[0]!.json().data.items.length, 1)
    assert.equal((await app.inject({ method: "PUT", url, headers: as("admin", tenant, { ...key(), "if-match": '"1"' }), payload: update })).statusCode, 412, "Stale revision")
    // Tenant isolation.
    assert.equal((await app.inject({ method: "GET", url, headers: as("bob", other) })).statusCode, 404)
    assert.equal((await app.inject({ method: "GET", url, headers: as("bob", tenant) })).statusCode, 403)
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/price-lists", headers: as("bob", other) })).json().total, 0)
    assert.equal((await app.inject({ method: "PUT", url, headers: as("bob", other, { ...key(), "if-match": '"2"' }), payload: { ...update, items: [{ productId: foreign, price: "1.00" }] } })).statusCode, 404)

    // ---- product CSV import/export ----
    const csv = "sku,name,unit,ncm,cest,base_price,status\nld-10,Banco novo,un,12345678,,150.00,active\nLD-1,Banco repetido,UN,,,10.00,active\nLD-11,\"Mesa, grande\",UN,,,20.00,\n"
    const importUrl = "/api/v1/products/import"
    assert.equal((await app.inject({ method: "POST", url: importUrl, headers: { "x-tenant-id": tenant }, payload: { filename: "p.csv", content: csv } })).statusCode, 401)
    assert.equal((await app.inject({ method: "POST", url: importUrl, headers: as("reader"), payload: { filename: "p.csv", content: csv } })).statusCode, 403)
    for (const payload of [{ filename: "p.txt", content: csv }, { filename: "p.csv" }, { filename: "p.csv", content: "" }, { filename: "p.csv", content: "sku,name\n" }, { filename: "p.csv", content: "sku,foo\nA,B\n" }, { filename: "p.csv", content: "sku,name,sku\nA,B,C\n" }, { filename: "p.csv", content: 'sku,name\nA,"aberta\n' }, { filename: "p.csv", content: csv, extra: 1 }]) {
      assert.equal((await app.inject({ method: "POST", url: importUrl, headers: as("admin"), payload })).statusCode, 422, JSON.stringify(payload).slice(0, 80))
    }
    const bad = await app.inject({ method: "POST", url: importUrl, headers: as("admin"), payload: { filename: "p.csv", content: "sku,name,unit,base_price\nLD-20,Ok,UN,1.00\nLD-21,,UN,1.00\nLD-22,Mau,UN,1,5\nLD-23,Preço,UN,abc\n" } })
    assert.equal(bad.statusCode, 422, bad.body)
    assert.deepEqual(bad.json().errors.map((item: { line: number }) => item.line), [3, 4, 5])
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM product_import_jobs")).rows[0].n, 0, "A rejected file stores nothing")
    const preview = await app.inject({ method: "POST", url: importUrl, headers: as("admin"), payload: { filename: "p.csv", content: csv } })
    assert.equal(preview.statusCode, 201, preview.body)
    assert.deepEqual([preview.json().data.valid, preview.json().data.conflicts, preview.json().data.invalid], [2, 1, 0])
    const again = await app.inject({ method: "POST", url: importUrl, headers: as("admin"), payload: { filename: "renamed.csv", content: csv } })
    assert.equal(again.statusCode, 200)
    assert.equal(again.json().data.id, preview.json().data.id, "Same content, same preview")
    const job = `${importUrl}/${preview.json().data.id}`
    assert.equal((await app.inject({ method: "GET", url: job, headers: as("admin") })).json().data.status, "previewed")
    assert.equal((await app.inject({ method: "GET", url: job, headers: as("reader") })).statusCode, 403)
    assert.equal((await app.inject({ method: "GET", url: job, headers: as("bob", other) })).statusCode, 404, "Other tenants cannot see the job")
    assert.equal((await app.inject({ method: "POST", url: `${job}/confirm`, headers: as("reader", tenant, key()) })).statusCode, 403)
    assert.equal((await app.inject({ method: "POST", url: `${job}/confirm`, headers: as("admin") })).statusCode, 428)
    assert.equal((await app.inject({ method: "POST", url: `${job}/confirm`, headers: as("bob", other, key()) })).statusCode, 404)
    assert.equal((await app.inject({ method: "GET", url: `${importUrl}/${randomUUID()}`, headers: as("admin") })).statusCode, 404)
    const confirmKey = key()
    const confirms = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: `${job}/confirm`, headers: as("admin", tenant, confirmKey) })))
    for (const response of confirms) assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(confirms[0]!.json().data.result, { imported: 2, total: 3 })
    assert.equal((await app.inject({ method: "POST", url: `${job}/confirm`, headers: as("admin", tenant, key()) })).json().data.status, "imported")
    const imported = await seed.query("SELECT sku,unit,price_cents::int AS cents FROM products WHERE tenant_id=$1 AND sku IN ('LD-10','LD-11') ORDER BY sku", [tenant])
    assert.deepEqual(imported.rows, [{ sku: "LD-10", unit: "UN", cents: 15000 }, { sku: "LD-11", unit: "UN", cents: 2000 }])
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM audit_log WHERE action='products.imported'")).rows[0].n, 1, "Imported exactly once")
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM products WHERE tenant_id=$1 AND sku='LD-1'", [tenant])).rows[0].n, 1, "Conflicting SKU was not duplicated")

    await seed.query("UPDATE products SET name='=HYPERLINK(1)' WHERE tenant_id=$1 AND id=$2", [tenant, bare])
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/products/export", headers: { "x-tenant-id": tenant } })).statusCode, 401)
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/products/export", headers: as("reader") })).statusCode, 403)
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/products/export?status=x", headers: as("admin") })).statusCode, 422)
    const exported = await app.inject({ method: "GET", url: "/api/v1/products/export?status=active", headers: as("admin") })
    assert.equal(exported.statusCode, 200)
    assert.match(String(exported.headers["content-type"]), /^text\/csv/)
    assert.match(String(exported.headers["content-disposition"]), /produtos\.csv/)
    assert.ok(exported.body.startsWith("sku,name,unit,ncm,cest,base_price,status\r\n"))
    assert.ok(exported.body.includes("LD-10,Banco novo,UN,12345678,,150.00,active"))
    assert.ok(exported.body.includes("'=HYPERLINK(1)"))
    assert.ok(!exported.body.includes("LD-9") && !exported.body.includes("LD-3"), "No foreign or archived rows")
    assert.ok((await app.inject({ method: "GET", url: "/api/v1/products/export", headers: as("bob", other) })).body.includes("LD-9"))
    assert.ok(!(await app.inject({ method: "GET", url: "/api/v1/products/export", headers: as("bob", other) })).body.includes("LD-10"))

    // ---- catalog profile and media ----
    const catalog = `/api/v1/products/${p1}/catalog`
    const profile = { collection: "core", muscleGroup: "Peito", technicalCategory: "Banco", dimensionsMm: [1200, 800, 900], description: "Banco ajustável", weight: "30 kg", weightStack: "", mainMediaId: null }
    assert.equal((await app.inject({ method: "GET", url: catalog, headers: { "x-tenant-id": tenant } })).statusCode, 401)
    assert.equal((await app.inject({ method: "GET", url: catalog, headers: as("nobody") })).statusCode, 403)
    const empty = await app.inject({ method: "GET", url: catalog, headers: as("reader") })
    assert.equal(empty.statusCode, 200, empty.body)
    assert.equal(empty.headers.etag, '"0"')
    assert.deepEqual([empty.json().data, empty.json().assets, empty.json().defaultCollection, empty.json().mediaConfigured, empty.json().canEdit], [null, [], "core", true, false])
    assert.equal((await app.inject({ method: "GET", url: `/api/v1/products/${randomUUID()}/catalog`, headers: as("reader") })).statusCode, 404)
    assert.equal((await app.inject({ method: "GET", url: catalog, headers: as("bob", other) })).statusCode, 404, "Product of another tenant")
    assert.equal((await app.inject({ method: "PUT", url: catalog, headers: as("reader", tenant, { "if-match": '"0"' }), payload: profile })).statusCode, 403)
    assert.equal((await app.inject({ method: "PUT", url: catalog, headers: as("admin"), payload: profile })).statusCode, 428)
    assert.equal((await app.inject({ method: "PUT", url: catalog, headers: as("admin", tenant, { "if-match": '"3"' }), payload: profile })).statusCode, 412, "No profile yet")
    for (const payload of [{ ...profile, collection: "x" }, { ...profile, dimensionsMm: [0, 1, 1] }, { ...profile, dimensionsMm: [1, 1] }, { ...profile, mainMediaId: undefined }, { ...profile, catalogSources: [{ title: "Fonte", url: "http://inseguro.test" }] }, { ...profile, catalogSources: [{ title: "Fonte", url: "https://u:p@site.test" }] }, { ...profile, extra: true }, { ...profile, mainMediaId: randomUUID() }, { ...profile, newImage: "data:image/png;base64,AAAA" }]) {
      assert.equal((await app.inject({ method: "PUT", url: catalog, headers: as("admin", tenant, { "if-match": '"0"' }), payload })).statusCode, 422, JSON.stringify(payload).slice(0, 90))
    }
    const saved = await app.inject({ method: "PUT", url: catalog, headers: as("admin", tenant, { "if-match": '"0"' }), payload: { ...profile, manufacturer: " Ludus ", catalogSources: [{ title: "Catálogo", url: "https://ludusequipamentos.com/c.pdf", pdfPage: 3 }] } })
    assert.equal(saved.statusCode, 200, saved.body)
    assert.deepEqual(saved.json(), { saved: true, revision: 1, mainMediaId: null })
    assert.equal(saved.headers.etag, '"1"')
    const stored = (await app.inject({ method: "GET", url: catalog, headers: as("reader") })).json()
    assert.equal(stored.data.publicPath, `/core/product-${p1}/`)
    assert.equal(stored.data.manufacturer, "Ludus")
    assert.deepEqual(stored.data.catalogSources, [{ title: "Catálogo", url: "https://ludusequipamentos.com/c.pdf", pdfPage: 3, printedPage: null }])
    // Omitted optional metadata is preserved; a stale writer loses.
    assert.equal((await app.inject({ method: "PUT", url: catalog, headers: as("admin", tenant, { "if-match": '"0"' }), payload: profile })).statusCode, 412)
    const second = await app.inject({ method: "PUT", url: catalog, headers: as("admin", tenant, { "if-match": '"1"' }), payload: { ...profile, description: "Nova" } })
    assert.equal(second.json().revision, 2)
    assert.equal((await app.inject({ method: "GET", url: catalog, headers: as("reader") })).json().data.manufacturer, "Ludus")
    assert.equal((await app.inject({ method: "PUT", url: `/api/v1/products/${foreign}/catalog`, headers: as("admin", tenant, { "if-match": '"0"' }), payload: profile })).statusCode, 404, "Cannot write another tenant's product")
    assert.equal((await seed.query("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'catalog.profile.%'")).rows[0].n, 2)

    // Media: seed an available derivative owned by LD-1.
    const file = randomUUID(), media = randomUUID()
    await seed.query("INSERT INTO system_config.files(tenant_id,id,storage_key,original_name,media_type,byte_size,sha256,status,created_by) VALUES($1,$2,'r2://ludus-equipamentos-midias/ludus/catalogo/uploads/abc/core/LD-1/web.webp','web.webp','image/webp',4,$3,'available',$4)", [tenant, file, "a".repeat(64), identities.admin])
    await seed.query("INSERT INTO product_media_assets(tenant_id,id,product_id,file_id,collection,variant,version,width_px,height_px) VALUES($1,$2,$3,$4,'core','webp',1,10,10)", [tenant, media, p1, file])
    const withMedia = (await app.inject({ method: "GET", url: catalog, headers: as("reader") })).json()
    assert.deepEqual(withMedia.assets, [{ id: media, variant: "webp", version: 1, width: 10, height: 10, mediaType: "image/webp" }])
    assert.equal((await app.inject({ method: "PUT", url: `/api/v1/products/${p2}/catalog`, headers: as("admin", tenant, { "if-match": '"0"' }), payload: { ...profile, mainMediaId: media } })).statusCode, 422, "Media of another product")
    assert.equal((await app.inject({ method: "PUT", url: catalog, headers: as("admin", tenant, { "if-match": '"2"' }), payload: { ...profile, mainMediaId: media } })).statusCode, 200)
    const mediaUrl = `${catalog.replace("/catalog", "")}/media/${media}`
    assert.equal((await app.inject({ method: "GET", url: mediaUrl, headers: { "x-tenant-id": tenant } })).statusCode, 401)
    assert.equal((await app.inject({ method: "GET", url: mediaUrl, headers: as("nobody") })).statusCode, 403)
    const image = await app.inject({ method: "GET", url: mediaUrl, headers: as("reader") })
    assert.equal(image.statusCode, 200, image.body)
    assert.equal(image.headers["content-type"], "image/webp")
    assert.equal(image.headers["cache-control"], "private, no-store")
    assert.equal(image.headers["x-content-type-options"], "nosniff")
    assert.equal(image.rawPayload.toString(), "RIFF")
    assert.equal((await app.inject({ method: "GET", url: mediaUrl, headers: as("bob", other) })).statusCode, 404, "Other tenants cannot read the image")
    assert.equal((await app.inject({ method: "GET", url: `${catalog.replace("/catalog", "")}/media/${randomUUID()}`, headers: as("reader") })).statusCode, 404)
    assert.equal((await buildWith().inject({ method: "GET", url: mediaUrl, headers: as("reader") })).statusCode, 409, "Gateway not configured")
    await app.close()
  } finally {
    await connections.end()
    await seed.end()
    await admin.query(`DROP DATABASE ${database}`)
    await admin.query(`DROP ROLE IF EXISTS ${role}`)
    await admin.end()
  }
})
