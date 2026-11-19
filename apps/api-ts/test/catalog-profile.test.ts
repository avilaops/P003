import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { Pool } from "pg"
import sharp from "sharp"

import { buildApp } from "../src/app.js"
import type { CatalogMedia } from "../src/platform/catalog-media.js"
import { PgClientAdapter } from "../src/platform/database.js"

const adminUrl = process.env.API_TS_TEST_ADMIN_URL

test("ficha técnica e fotos do catálogo do produto", { skip: !adminUrl }, async t => {
  const suffix = randomUUID().replaceAll("-", "")
  const database = `api_ts_catalog_${suffix}`
  const role = `api_ts_catalog_role_${suffix}`
  const admin = new Pool({ connectionString: adminUrl })
  const databaseUrl = new URL(adminUrl!)
  databaseUrl.pathname = `/${database}`
  const seed = new Pool({ connectionString: databaseUrl.toString() })
  const connections = new Pool({ connectionString: databaseUrl.toString() })
  const tenant = randomUUID(), otherTenant = randomUUID()
  const objects = new Map<string, Uint8Array>([["v1/core/LD-WH001/web.webp", new Uint8Array([1, 2, 3, 4])]])
  const uploads: string[] = []
  const catalogMedia: CatalogMedia = {
    tenantId: tenant,
    async publish() { throw Error("publish not used by this test") },
    async upload(key, _type, _sha, bytes) { uploads.push(key); objects.set(key.replace(/^ludus\/catalogo\//, ""), bytes) },
    async readPrivate(key) { const bytes = objects.get(key); if (!bytes) throw Error("missing object"); return bytes },
  }
  const app = buildApp({
    pool: { async connect() { const client = await connections.connect(); await client.query(`SET ROLE ${role}`); return new PgClientAdapter(client) } },
    userinfoUrl: "http://auth.test/userinfo", catalogMedia,
    fetchAuth: async (_url, init) => Response.json({ sub: new Headers(init?.headers).get("authorization")?.slice(7), email: "user@example.test" }),
  })
  t.after(async () => {
    try { await app.close(); await connections.end(); await seed.end(); await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.query(`DROP ROLE IF EXISTS ${role}`) }
    finally { await admin.end() }
  })
  await admin.query(`CREATE DATABASE ${database}`)
  const migrations = new URL("../../../migrations/", import.meta.url)
  for (const file of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) await seed.query(await readFile(new URL(file, migrations), "utf8"))
  await seed.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
  await seed.query(`
    GRANT USAGE ON SCHEMA public, system_config TO ${role};
    GRANT SELECT ON tenants, tenant_memberships, identities, membership_roles, roles, role_permissions, platform_administrators, permissions, products, product_categories TO ${role};
    GRANT SELECT, INSERT, UPDATE ON product_catalog_profiles, product_media_assets, system_config.files, system_config.file_versions TO ${role};
    GRANT INSERT ON audit_log, outbox_events TO ${role};
    GRANT UPDATE ON products, tenants TO ${role};
    GRANT EXECUTE ON FUNCTION system_config.has_permission(text) TO ${role};
  `)
  await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa A','04252011000110'),($2,'Empresa B','52998224725')", [tenant, otherTenant])
  await seed.query(`
    INSERT INTO identities(auth_subject,email,display_name) VALUES ('reader','reader@example.test','Leitor'), ('manager','manager@example.test','Gestor'), ('outsider','outsider@example.test','Sem acesso');
    INSERT INTO tenant_memberships(tenant_id,identity_id) SELECT tenants.id, identities.id FROM tenants CROSS JOIN identities WHERE identities.auth_subject<>'outsider';
    INSERT INTO roles(tenant_id,code,name) SELECT tenants.id, identities.auth_subject, identities.display_name FROM tenants CROSS JOIN identities WHERE identities.auth_subject<>'outsider';
    INSERT INTO membership_roles(membership_id,role_id) SELECT membership.id, roles.id FROM tenant_memberships membership JOIN identities ON identities.id=membership.identity_id JOIN roles ON roles.tenant_id=membership.tenant_id AND roles.code=identities.auth_subject;
    INSERT INTO role_permissions(role_id,permission_code) SELECT id,'catalog.products.read' FROM roles WHERE code IN ('reader','manager');
    INSERT INTO role_permissions(role_id,permission_code) SELECT id,'catalog.products.manage' FROM roles WHERE code='manager';
  `)
  const product = randomUUID(), bare = randomUUID(), foreign = randomUUID()
  await seed.query(`INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES ($1,$2,'LD-WH001','Agachamento Búlgaro','UN',100,'active'),($3,$2,'LD-WH002','Agachamento Pêndulo','UN',100,'active'),($4,$5,'LD-WH001','Outra empresa','UN',100,'active')`, [product, tenant, bare, foreign, otherTenant])
  await seed.query(`INSERT INTO product_catalog_profiles(tenant_id,product_id,collection,muscle_group,technical_category,dimensions_mm,description,weight,weight_stack,public_path,manufacturer,live_area)
    VALUES ($1,$2,'core','Pernas e glúteos','Peso livre',ARRAY[1200,1000,900],'','50 kg','','/core/product-x/','Fornecedor original','')`, [tenant, product])
  const fileId = (await seed.query<{ id: string }>("INSERT INTO system_config.files(tenant_id,storage_key,original_name,media_type,byte_size,sha256,status,created_by) SELECT $1,'r2://ludus-equipamentos-midias/ludus/catalogo/v1/core/LD-WH001/web.webp','LD-WH001-web','image/webp',4,repeat('a',64),'available',id FROM identities WHERE auth_subject='manager' RETURNING id", [tenant])).rows[0]!.id
  const mediaId = (await seed.query<{ id: string }>("INSERT INTO product_media_assets(tenant_id,product_id,file_id,collection,variant,version,width_px,height_px) VALUES($1,$2,$3,'core','webp',1,1536,1024) RETURNING id", [tenant, product, fileId])).rows[0]!.id

  const call = (method: "GET" | "PUT", url: string, subject = "manager", headers: Record<string, string> = {}, payload?: unknown, tenantId = tenant) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${subject}`, "x-tenant-id": tenantId, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const sheet = { collection: "core", muscleGroup: "Pernas e glúteos", technicalCategory: "Peso livre", dimensionsMm: [1200, 1000, 900], description: "Texto informado pelo usuário", weight: "50 kg", weightStack: "", mainMediaId: null }

  await t.test("GET /api/v1/products/{id}/catalog [sucesso] devolve ficha, galeria e revisão", async () => {
    const response = await call("GET", `/api/v1/products/${product}/catalog`, "reader")
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers.etag, '"1"')
    const body = response.json()
    assert.equal(body.canEdit, false)
    assert.equal(body.mediaConfigured, true)
    assert.equal(body.defaultCollection, "core")
    assert.deepEqual(body.data.dimensionsMm, [1200, 1000, 900])
    assert.equal(body.data.manufacturer, "Fornecedor original")
    assert.deepEqual(body.assets.map((asset: { id: string; variant: string }) => [asset.id, asset.variant]), [[mediaId, "webp"]])
    const empty = await call("GET", `/api/v1/products/${bare}/catalog`)
    assert.equal(empty.headers.etag, '"0"')
    assert.equal(empty.json().data, null)
  })

  await t.test("PUT /api/v1/products/{id}/catalog [sucesso] grava, preserva campos omitidos e registra auditoria", async () => {
    const saved = await call("PUT", `/api/v1/products/${product}/catalog`, "manager", { "if-match": '"1"' }, { ...sheet, mainMediaId: mediaId, liveArea: "  5,28 m²  " })
    assert.equal(saved.statusCode, 200, saved.body)
    assert.deepEqual(saved.json(), { saved: true, revision: 2, mainMediaId: mediaId })
    assert.equal(saved.headers.etag, '"2"')
    const row = (await seed.query("SELECT revision,manufacturer,live_area,description,main_media_id FROM product_catalog_profiles WHERE tenant_id=$1 AND product_id=$2", [tenant, product])).rows[0]
    assert.deepEqual(row, { revision: "2", manufacturer: "Fornecedor original", live_area: "5,28 m²", description: "Texto informado pelo usuário", main_media_id: mediaId })
    const audit = (await seed.query("SELECT action,details FROM audit_log WHERE tenant_id=$1 AND entity_id=$2", [tenant, product])).rows
    assert.deepEqual(audit, [{ action: "catalog.profile.updated", details: { revision: 2 } }])
    const created = await call("PUT", `/api/v1/products/${bare}/catalog`, "manager", { "if-match": '"0"' }, { ...sheet, manufacturer: "Fornecedor" })
    assert.equal(created.statusCode, 200, created.body)
    const createdRow = (await seed.query("SELECT revision,public_path,manufacturer,catalog_sources FROM product_catalog_profiles WHERE tenant_id=$1 AND product_id=$2", [tenant, bare])).rows[0]
    assert.deepEqual(createdRow, { revision: "1", public_path: `/core/product-${bare}/`, manufacturer: "Fornecedor", catalog_sources: [] })
    const withPhoto = await call("PUT", `/api/v1/products/${bare}/catalog`, "manager", { "if-match": '"1"' }, { ...sheet, newImage: "data:image/png;base64,iVBORw0KGgo=" })
    assert.equal(withPhoto.statusCode, 422, "foto inválida é recusada antes de qualquer envio")
    assert.deepEqual(uploads, [])
    const photo = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: { r: 30, g: 30, b: 30 } } }).png().toBuffer()
    const stored = await call("PUT", `/api/v1/products/${bare}/catalog`, "manager", { "if-match": '"1"' }, { ...sheet, newImage: `data:image/png;base64,${photo.toString("base64")}` })
    assert.equal(stored.statusCode, 200, stored.body)
    assert.deepEqual((uploads as string[]).map(key => key.split("/").slice(-3).join("/")), ["core/LD-WH002/web.webp", "core/LD-WH002/thumbnail.webp", "core/LD-WH002/source.png"])
    const media = (await seed.query("SELECT m.variant,m.version,m.width_px,m.height_px,f.media_type,f.original_name FROM product_media_assets m JOIN system_config.files f ON f.id=m.file_id WHERE m.tenant_id=$1 AND m.product_id=$2 ORDER BY m.width_px DESC", [tenant, bare])).rows
    assert.deepEqual(media, [
      { variant: "source", version: 1, width_px: 2400, height_px: 1200, media_type: "image/png", original_name: "LD-WH002-source.png" },
      { variant: "webp", version: 1, width_px: 1600, height_px: 800, media_type: "image/webp", original_name: "LD-WH002-web.webp" },
      { variant: "thumbnail", version: 1, width_px: 400, height_px: 200, media_type: "image/webp", original_name: "LD-WH002-thumbnail.webp" },
    ])
    const main = (await seed.query("SELECT m.variant FROM product_catalog_profiles p JOIN product_media_assets m ON m.id=p.main_media_id WHERE p.tenant_id=$1 AND p.product_id=$2", [tenant, bare])).rows
    assert.deepEqual(main, [{ variant: "webp" }])
    assert.equal(stored.json().revision, 2)
  })

  await t.test("GET /api/v1/products/{id}/media/{mediaId} [sucesso] entrega a foto privada com o tamanho registrado", async () => {
    const response = await call("GET", `/api/v1/products/${product}/media/${mediaId}`, "reader")
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers["content-type"], "image/webp")
    assert.equal(response.headers["cache-control"], "private, no-store")
    assert.deepEqual([...response.rawPayload], [1, 2, 3, 4])
  })

  await t.test("GET /api/v1/products/catalog-pending [sucesso] lista os campos vazios de cada produto ativo", async () => {
    const response = await call("GET", "/api/v1/products/catalog-pending", "reader")
    assert.equal(response.statusCode, 200, response.body)
    const body = response.json()
    assert.equal(body.canEdit, false)
    assert.equal(body.activeProducts, 2)
    const bySku = Object.fromEntries(body.data.map((row: { sku: string; missing: string[] }) => [row.sku, row.missing]))
    assert.deepEqual(bySku["LD-WH001"], ["manufacturerModel", "ncm"])
    assert.deepEqual(bySku["LD-WH002"], ["manufacturerModel", "liveArea", "ncm"])
    assert.equal(body.totals.ncm, 2)
  })

  await t.test("GET /api/v1/products/catalog-pending [negado] sem permissão ou sem vínculo com a empresa", async () => {
    assert.equal((await call("GET", "/api/v1/products/catalog-pending", "outsider")).statusCode, 403)
    const foreignView = (await call("GET", "/api/v1/products/catalog-pending", "reader", {}, undefined, otherTenant)).json()
    assert.deepEqual(foreignView.data.map((row: { name: string }) => row.name), ["Outra empresa"])
  })

  await t.test("GET /api/v1/products/{id}/catalog + PUT /api/v1/products/{id}/catalog + GET /api/v1/products/{id}/media/{mediaId} [negado] sem permissão, sem vínculo, de outra empresa ou com revisão antiga", async () => {
    assert.equal((await call("GET", `/api/v1/products/${product}/catalog`, "outsider")).statusCode, 403)
    assert.equal((await call("GET", `/api/v1/products/${foreign}/catalog`)).statusCode, 404)
    assert.equal((await call("PUT", `/api/v1/products/${product}/catalog`, "reader", { "if-match": '"2"' }, sheet)).statusCode, 403)
    assert.equal((await call("PUT", `/api/v1/products/${product}/catalog`, "manager", { "if-match": '"1"' }, sheet)).statusCode, 412)
    assert.equal((await call("PUT", `/api/v1/products/${product}/catalog`, "manager", {}, sheet)).statusCode, 428)
    assert.equal((await call("PUT", `/api/v1/products/${product}/catalog`, "manager", { "if-match": '"2"' }, { ...sheet, mainMediaId: randomUUID() })).statusCode, 422)
    assert.equal((await call("GET", `/api/v1/products/${product}/media/${mediaId}`, "outsider")).statusCode, 403)
    assert.equal((await call("GET", `/api/v1/products/${foreign}/media/${mediaId}`)).statusCode, 404)
    assert.equal((await call("GET", `/api/v1/products/${product}/media/${mediaId}`, "manager", {}, undefined, otherTenant)).statusCode, 404)
    const unchanged = (await seed.query("SELECT revision FROM product_catalog_profiles WHERE tenant_id=$1 AND product_id=$2", [tenant, product])).rows[0]
    assert.deepEqual(unchanged, { revision: "2" })
  })
})
