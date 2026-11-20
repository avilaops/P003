import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { Pool } from "pg"

import { buildApp } from "../src/app.js"
import { PgClientAdapter } from "../src/platform/database.js"

const route = "/api/v1/products/finishes"
const adminUrl = process.env.API_TS_TEST_ADMIN_URL

test("product finishes batches are limited, private and scoped to the active tenant", { skip: !adminUrl }, async t => {
  const suffix = randomUUID().replaceAll("-", "")
  const database = `api_ts_finishes_${suffix}`
  const role = `api_ts_finish_reader_${suffix}`
  const admin = new Pool({ connectionString: adminUrl })
  const databaseUrl = new URL(adminUrl!)
  databaseUrl.pathname = `/${database}`
  const seed = new Pool({ connectionString: databaseUrl.toString() })
  const connections = new Pool({ connectionString: databaseUrl.toString() })
  const app = buildApp({
    pool: {
      async connect() {
        const client = await connections.connect()
        await client.query(`SET ROLE ${role}`)
        return new PgClientAdapter(client)
      },
    },
    userinfoUrl: "http://auth.test/userinfo",
    fetchAuth: async (_url, init) => Response.json({
      sub: new Headers(init?.headers).get("authorization")?.slice(7),
      email: "reader@example.test",
    }),
  })
  t.after(async () => {
    try {
      await app.close()
      await connections.end()
      await seed.end()
      await admin.query(`DROP DATABASE IF EXISTS ${database}`)
      await admin.query(`DROP ROLE IF EXISTS ${role}`)
    } finally {
      await admin.end()
    }
  })
  await admin.query(`CREATE DATABASE ${database}`)
  const migrations = new URL("../../../migrations/", import.meta.url)
  for (const file of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
    await seed.query(await readFile(new URL(file, migrations), "utf8"))
  }
  await seed.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
  await seed.query(`
    GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT ON tenants, tenant_memberships, identities, membership_roles, roles,
      role_permissions, platform_administrators, permissions, registration_settings TO ${role};
    GRANT SELECT (tenant_id, id, name, structure_colors, swing_arm_colors, finishing_palette,
      upholstery_colors, plate_holder_colors, plate_holder_types, plate_holder_type) ON products TO ${role};
    GRANT SELECT (tenant_id, product_id, weight, dimensions_mm) ON product_catalog_profiles TO ${role};
  `)

  const tenant = randomUUID(), otherTenant = randomUUID()
  await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa A','04252011000110'),($2,'Empresa B','52998224725')", [tenant, otherTenant])
  await seed.query(`
    INSERT INTO identities(auth_subject,email,display_name)
    VALUES ('reader','reader@example.test','Leitor'), ('manager','manager@example.test','Gestor');
    INSERT INTO tenant_memberships(tenant_id,identity_id)
    SELECT tenants.id, identities.id FROM tenants CROSS JOIN identities;
    INSERT INTO roles(tenant_id,code,name)
    SELECT tenants.id, identities.auth_subject, identities.display_name FROM tenants CROSS JOIN identities;
    INSERT INTO membership_roles(membership_id,role_id)
    SELECT membership.id, roles.id FROM tenant_memberships membership
    JOIN identities ON identities.id=membership.identity_id
    JOIN roles ON roles.tenant_id=membership.tenant_id AND roles.code=identities.auth_subject;
    INSERT INTO role_permissions(role_id,permission_code)
    SELECT id, CASE code WHEN 'reader' THEN 'catalog.products.read' ELSE 'catalog.products.manage' END
    FROM roles WHERE code IN ('reader','manager');
  `)

  const legacyProduct = "aa000000-0000-3000-2000-000000000001"
  const secondProduct = "cc000000-0000-4000-8000-000000000003"
  const otherProduct = randomUUID(), missing = randomUUID()
  await seed.query(`
    INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status,structure_colors,
      swing_arm_colors,finishing_palette,upholstery_colors,plate_holder_colors,
      plate_holder_types,plate_holder_type,photo_data_url)
    VALUES
      ($1,$2,'LD-1','Banco','UN',10000,'active',ARRAY['Preto'],ARRAY['Prata'],'dhz-combined',
        ARRAY['Azul'],ARRAY['Vermelho'],'{}','olympic','data:image/jpeg;base64,/9j/2Q=='),
      ($3,$4,'LD-1','Nacional','UN',12345,'active','{}','{}','','{}','{}',ARRAY['Standard'],'',''),
      ($5,$2,'LD-2','Barra','UN',1000,'active','{}','{}','','{}','{}','{}','standard','')
  `, [legacyProduct, tenant, otherProduct, otherTenant, secondProduct])
  await seed.query(`
    INSERT INTO product_catalog_profiles(tenant_id,product_id,collection,muscle_group,
      technical_category,dimensions_mm,description,weight,weight_stack,public_path)
    VALUES ($1,$2,'core','Pernas','Bateria de pesos',ARRAY[1500,1200,1400],
      'Ficha original','150 kg','100 kg','/loja/banco/')
  `, [tenant, legacyProduct])
  await seed.query("INSERT INTO registration_settings(tenant_id,section,data,revision) VALUES($1,'products',$2,1)", [tenant, { upholsteryConfigurable: false }])

  function get(query: string, tenantId = tenant, subject = "reader") {
    return app.inject({ method: "GET", url: route + query, headers: { authorization: `Bearer ${subject}`, "x-tenant-id": tenantId } })
  }

  await t.test("returns only the finish fields with normalized legacy IDs and tenant-specific values", async () => {
    const query = `?ids=${otherProduct},${secondProduct},${legacyProduct.toUpperCase()},${legacyProduct},${missing}`
    const response = await get(query)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers["cache-control"], "no-store")
    assert.deepEqual(response.json(), {
      tenantId: tenant,
      data: [
        { id: secondProduct, name: "Barra", structureColors: [], swingArmColors: [],
          finishingPalette: "", upholsteryColors: [], upholsteryConfigurable: false,
          plateHolderColors: [], plateHolderTypes: ["Standard"], weight: null, dimensionsMm: null },
        { id: legacyProduct, name: "Banco", structureColors: ["Preto"], swingArmColors: ["Prata"],
          finishingPalette: "dhz-combined", upholsteryColors: ["Azul"], upholsteryConfigurable: false,
          plateHolderColors: ["Vermelho"], plateHolderTypes: ["Olímpico"], weight: "150 kg", dimensionsMm: [1500, 1200, 1400] },
      ],
      missingIds: [otherProduct, missing],
    })

    const other = await get(query, otherTenant)
    assert.equal(other.statusCode, 200, other.body)
    assert.deepEqual(other.json(), {
      tenantId: otherTenant,
      data: [{ id: otherProduct, name: "Nacional", structureColors: [], swingArmColors: [],
        finishingPalette: "", upholsteryColors: [], upholsteryConfigurable: true,
        plateHolderColors: [], plateHolderTypes: ["Standard"], weight: null, dimensionsMm: null }],
      missingIds: [secondProduct, legacyProduct, missing],
    })
  })

  await t.test("requires product read permission even for members who can manage products", async () => {
    const response = await get(`?ids=${legacyProduct}`, tenant, "manager")
    assert.equal(response.statusCode, 403, response.body)
    assert.equal(response.json().type, "https://erp.avilaops.com/problems/forbidden")
    assert.equal(response.headers["cache-control"], "no-store")
  })

  await t.test("accepts at most 100 supplied IDs and rejects malformed or ambiguous queries", async () => {
    const ids = Array.from({ length: 100 }, () => randomUUID())
    const response = await get(`?ids=${ids.join(",")}`)
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json(), { tenantId: tenant, data: [], missingIds: ids })
    for (const query of [
      "", "?ids=", "?ids=malformed", `?ids=${legacyProduct},`, `?ids=${legacyProduct},malformed`, `?ids=${legacyProduct}%0A`,
      `?ids=${legacyProduct}&ids=${otherProduct}`, `?ids=${legacyProduct}&page=1`,
      `?ids=${[...ids, ids[0]].join(",")}`,
    ]) {
      const invalid = await get(query)
      assert.equal(invalid.statusCode, 422, `${query}: ${invalid.body}`)
      assert.equal(invalid.json().type, "https://erp.avilaops.com/problems/invalid_input")
    }
  })
})
