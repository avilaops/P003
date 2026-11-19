import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import test from "node:test"
import Fastify from "fastify"
import { Pool } from "pg"
import { registerLogisticsShipments } from "../src/modules/logistics-shipments/routes.js"
import { PgClientAdapter } from "../src/platform/database.js"
import { Problem } from "../src/platform/problem.js"
import { stringifyJson } from "../src/platform/json.js"

test(
  "Expedição • Um pedido expedido mostra romaneio, volumes, transportadora e data de entrega no detalhe",
  { skip: !process.env.API_TS_TEST_ADMIN_URL },
  async () => {
    const url = new URL(process.env.API_TS_TEST_ADMIN_URL!),
      name = "ship_" + randomUUID().replaceAll("-", ""),
      role = name + "_app"
    const admin = new Pool({ connectionString: url.toString() })
    await admin.query("CREATE DATABASE " + name)
    url.pathname = "/" + name
    const pg = new Pool({ connectionString: url.toString() }),
      api = new Pool({ connectionString: url.toString() })
    const app = Fastify()
    app.setReplySerializer(stringifyJson)
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof Problem) reply.code(err.status).send(err.toJSON())
      else reply.code(500).send({ error: String(err) })
    })
    try {
      const dir = new URL("../../../migrations/", import.meta.url)
      for (const file of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort())
        await pg.query(await readFile(new URL(file, dir), "utf8"))
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS")
      await pg.query(
        `GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO ${role}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
      )
      const tenant = randomUUID(), other = randomUUID(), order = randomUUID(), draft = randomUUID(), foreign = randomUUID()
      await pg.query(
        "INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa','04252011000110'),($2,'Outra','52998224725')",
        [tenant, other],
      )
      await pg.query(
        "INSERT INTO identities(auth_subject,email,display_name) VALUES('operator','operator@example.test','Operador'),('reader','reader@example.test','Leitor'),('nobody','nobody@example.test','Sem acesso'),('outsider','outsider@example.test','Outro')",
      )
      const roles = { operator: randomUUID(), reader: randomUUID(), nobody: randomUUID(), outsider: randomUUID() }
      const grants: Record<string, [string, string]> = {
        operator: [tenant, "logistics.shipments.%"], reader: [tenant, "logistics.shipments.read"],
        nobody: [tenant, "none.none"], outsider: [other, "logistics.shipments.%"],
      }
      for (const [user, id] of Object.entries(roles)) {
        const [t, perm] = grants[user]!, m = randomUUID()
        await pg.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,$3,$3)", [id, t, user])
        await pg.query("INSERT INTO role_permissions SELECT $1,code FROM permissions WHERE code LIKE $2", [id, perm])
        await pg.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) SELECT $1,$2,id FROM identities WHERE auth_subject=$3", [m, t, user])
        await pg.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [m, id])
      }
      for (const t of [tenant, other])
        await pg.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Cliente','52998224725',true,false,'active')", [t])
      for (const [id, status, t] of [[order, "confirmed", tenant], [draft, "draft", tenant], [foreign, "confirmed", other]] as const)
        await pg.query(
          "INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-01',100000,$3)",
          [id, t, status],
        )
      const pool = {
        async connect() {
          const c = await api.connect()
          await c.query("SET ROLE " + role)
          return new PgClientAdapter(c)
        },
      }
      registerLogisticsShipments(app, {
        pool,
        userinfoUrl: "http://auth.test/userinfo",
        fetchAuth: async (_url, init) => {
          const sub = new Headers(init?.headers).get("authorization")!.slice(7)
          return Response.json({ sub, email: sub + "@example.test", name: sub, email_verified: true })
        },
      })
      const as = (user: string, t = tenant) => ({ authorization: "Bearer " + user, "x-tenant-id": t })
      const create = (orderId: string, user = "operator", key = randomUUID()) =>
        app.inject({ method: "POST", url: "/api/v1/logistics/shipments", payload: { orderId }, headers: { ...as(user), "idempotency-key": key } })
      const move = (id: string, revision: number, payload: object, user = "operator", key = randomUUID()) =>
        app.inject({ method: "POST", url: `/api/v1/logistics/shipments/${id}/status`, payload, headers: { ...as(user), "if-match": `"${revision}"`, "idempotency-key": key } })

      // 401 / 403 / 422 / 409 na criação
      assert.equal((await app.inject({ method: "POST", url: "/api/v1/logistics/shipments", payload: { orderId: order } })).statusCode, 401)
      assert.equal((await create(order, "reader")).statusCode, 403)
      assert.equal((await create(order, "nobody")).statusCode, 403)
      assert.equal((await create("não-é-uuid")).statusCode, 422)
      assert.equal((await create(draft)).statusCode, 409)
      assert.equal((await create(foreign)).statusCode, 404, "pedido de outra empresa não é visível")

      const key = randomUUID()
      const [first, again] = await Promise.all([create(order, "operator", key), create(order, "operator", key)])
      assert.equal(first.statusCode, 201, first.body)
      assert.equal(again.statusCode, 200, again.body)
      assert.equal(first.json().data.id, again.json().data.id)
      assert.equal((await create(order)).statusCode, 409, "um pedido tem uma única expedição")
      const id = first.json().data.id as string
      assert.equal(first.json().data.status, "to_separate")

      // leitura e isolamento por empresa
      assert.equal((await app.inject({ url: "/api/v1/logistics/shipments/" + id, headers: as("reader") })).statusCode, 200)
      assert.equal((await app.inject({ url: "/api/v1/logistics/shipments/" + id, headers: as("nobody") })).statusCode, 403)
      assert.equal((await app.inject({ url: "/api/v1/logistics/shipments/" + id, headers: as("outsider", other) })).statusCode, 404)
      assert.equal((await app.inject({ url: "/api/v1/logistics/shipments?orderId=" + order, headers: as("reader") })).json().total, 1)

      // máquina de estados: 422 (entrada), 409 (pular etapa), 412 (revisão antiga)
      assert.equal((await move(id, 1, { status: "voando" })).statusCode, 422)
      assert.equal((await move(id, 1, { status: "shipped" })).statusCode, 409)
      assert.equal((await move(id, 1, { status: "separated" }, "reader")).statusCode, 403)
      const separated = await move(id, 1, { status: "separated" })
      assert.equal(separated.statusCode, 200, separated.body)
      assert.equal((await move(id, 1, { status: "checked" })).statusCode, 412)
      assert.equal((await move(id, 2, { status: "checked" })).statusCode, 409, "sem checkout concluído não há conferência")

      // conferência e volumes vêm do checkout logístico
      const checkout = randomUUID(), product = randomUUID()
      await pg.query("INSERT INTO logistics_checkouts(id,tenant_id,order_id,status,completed_at) VALUES($1,$2,$3,'completed',now())", [checkout, tenant, order])
      await pg.query("UPDATE logistics_shipments SET checkout_id=$1 WHERE tenant_id=$2 AND id=$3", [checkout, tenant, id])
      const checked = await move(id, 2, { status: "checked" })
      assert.equal(checked.statusCode, 200, checked.body)
      assert.equal((await move(id, 3, { status: "shipped" })).statusCode, 422, "expedir exige transportadora")
      assert.equal((await move(id, 3, { status: "shipped", carrierName: "Transportes Teste" })).statusCode, 409, "expedir exige volumes")
      await pg.query(
        "INSERT INTO logistics_checkout_packages(id,tenant_id,checkout_id,package_number,weight_grams,length_mm,width_mm,height_mm) VALUES($1,$2,$3,1,12000,500,400,300),($4,$2,$3,2,8000,400,300,200)",
        [randomUUID(), tenant, checkout, randomUUID()],
      )
      const shipped = await move(id, 3, { status: "shipped", carrierName: "Transportes Teste", vehiclePlate: "ABC1D23", driverName: "Motorista Teste", trackingCode: "TRK0001" })
      assert.equal(shipped.statusCode, 200, shipped.body)
      assert.equal(shipped.json().data.manifest.number, "ROM-000001")
      const delivered = await move(id, 4, { status: "delivered" })
      assert.equal(delivered.statusCode, 200, delivered.body)
      assert.equal((await move(id, 5, { status: "delivered" })).statusCode, 409, "entregue é terminal")

      // aceite: detalhe com romaneio, volumes, transportadora e data de entrega
      const detail = (await app.inject({ url: "/api/v1/logistics/shipments/" + id, headers: as("reader") })).json().data
      assert.equal(detail.status, "delivered")
      assert.equal(detail.carrierName, "Transportes Teste")
      assert.ok(detail.deliveredAt)
      assert.equal(detail.manifest.number, "ROM-000001")
      assert.equal(detail.manifest.vehiclePlate, "ABC1D23")
      assert.equal(detail.manifest.packageCount, 2)
      assert.equal(detail.manifest.totalWeightGrams, 20000)
      assert.equal(detail.packages.length, 2)
      assert.deepEqual(detail.events.map((e: { status: string }) => e.status), ["to_separate", "separated", "checked", "shipped", "delivered"])
      const outbox = await pg.query("SELECT 1 FROM outbox_events WHERE tenant_id=$1 AND event_type='logistics.shipment.delivered'", [tenant])
      assert.equal(outbox.rowCount, 1, "entrega publica o evento para Vendas e Garantia")
    } finally {
      await app.close()
      await api.end()
      await pg.end()
      await admin.query("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)")
      await admin.end()
    }
  },
)
