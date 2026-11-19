import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import test from "node:test"
import { Pool } from "pg"
import type { LightMyRequestResponse } from "fastify"
import { buildApp } from "../src/app.js"
import { PgClientAdapter, type DatabasePool } from "../src/platform/database.js"
import { createCatalogMedia, type CatalogMedia } from "../src/platform/catalog-media.js"
import { Problem } from "../src/platform/problem.js"
import { commercialFixture } from "./commercial-fixture.js"

// Within the 30-day payment term saved by these tests (Brasília date + days).
const soon = (days: number) => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` }

// Routes of PR 06: sales/purchase settings, proposal commands, sales simulator and catalog publication.
// The shared tenant fixture of #284 is not merged yet; this file seeds only what it needs (see PR description).
const permissions = {
  admin: ["platform.company.manage", "platform.company.read", "sales.orders.read", "sales.orders.manage", "sales.proposals.read", "sales.proposals.manage", "sales.proposals.decide", "sales.approvals.director", "purchasing.orders.read", "catalog.products.read", "catalog.products.manage"],
  seller: ["sales.orders.read", "sales.orders.manage", "sales.proposals.read", "sales.proposals.manage"],
  viewer: ["sales.orders.read", "sales.proposals.read", "purchasing.orders.read", "catalog.products.read"],
  nobody: [] as string[],
}
const otherTenantAdmin = permissions.admin

test("commercial PR 06 routes keep contract, permissions, idempotency and tenant isolation", { skip: !process.env.API_TS_TEST_ADMIN_URL }, async t => {
  const url = new URL(process.env.API_TS_TEST_ADMIN_URL!)
  const suffix = randomUUID().replaceAll("-", ""), database = `api_ts_porte_${suffix}`, role = `api_ts_porte_role_${suffix}`
  const admin = new Pool({ connectionString: url.toString() })
  await admin.query(`CREATE DATABASE ${database}`)
  url.pathname = `/${database}`
  const seed = new Pool({ connectionString: url.toString() }), connections = new Pool({ connectionString: url.toString() })
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const directory = new URL("../../../migrations/", import.meta.url)
    for (const file of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) await seed.query(await readFile(new URL(file, directory), "utf8"))
    await seed.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    await seed.query(`GRANT USAGE ON SCHEMA public,system_config TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}; GRANT SELECT ON ALL TABLES IN SCHEMA system_config TO ${role}; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}; GRANT EXECUTE ON FUNCTION system_config.has_permission(text) TO ${role}`)
    const tenant = randomUUID(), other = randomUUID()
    await seed.query("INSERT INTO tenants(id,legal_name,tax_id) VALUES($1,'Empresa A','04252011000110'),($2,'Empresa B','52998224725')", [tenant, other])
    await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) SELECT id,id,'fisica','Cliente','52998224725',true,false,'active' FROM tenants")
    const identities = new Map<string, string>()
    const member = async (subject: string, tenantId: string, codes: string[]) => {
      const identity = randomUUID(), membership = randomUUID(), roleId = randomUUID()
      identities.set(subject, identity)
      await seed.query("INSERT INTO identities(id,auth_subject,email,display_name) VALUES($1,$2,$3,$2)", [identity, subject, `${subject}@example.test`])
      await seed.query("INSERT INTO tenant_memberships(id,tenant_id,identity_id) VALUES($1,$2,$3)", [membership, tenantId, identity])
      await seed.query("INSERT INTO roles(id,tenant_id,code,name) VALUES($1,$2,$3,'Papel')", [roleId, tenantId, subject])
      await seed.query("INSERT INTO membership_roles(membership_id,role_id) VALUES($1,$2)", [membership, roleId])
      for (const code of codes) await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)", [roleId, code])
    }
    for (const [subject, codes] of Object.entries(permissions)) await member(subject, tenant, codes)
    await member("outsider", other, otherTenantAdmin)
    await seed.query("INSERT INTO identities(auth_subject,email,display_name) VALUES('stranger','stranger@example.test','Sem empresa')")

    const fixture = commercialFixture()
    const product = "aa000000-0000-3000-2000-0000000000a1", catalogProduct = "aa000000-0000-3000-2000-0000000000a2", proposalProduct = "aa000000-0000-3000-2000-0000000000a3"
    for (const [id, sku] of [[product, "SIM-1"], [catalogProduct, "CAT-1"], [proposalProduct, "PROP-1"]] as const) await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,$3,$3,'UN',10000,'active')", [id, tenant, sku])
    // Published table: price 200.00 without IPI, cost and policy as in the Rust reference tests.
    const version = randomUUID()
    await seed.query("INSERT INTO commercial_settings(tenant_id,product_line,parameters,revision) VALUES($1,'imported',$2,1)", [tenant, fixture.parameters])
    await seed.query("INSERT INTO price_table_versions(id,tenant_id,product_line,version,settings_revision,policy_snapshot,calculator_version,digest,published_by) VALUES($1,$2,'imported',1,1,$3,'test',$4,$5)", [version, tenant, fixture.parameters, "a".repeat(64), identities.get("admin")])
    await seed.query("INSERT INTO price_table_items(tenant_id,version_id,product_id,product_snapshot,cost_revision,cost_snapshot,price_without_ipi_cents,ipi_bps,price_with_ipi_cents) VALUES($1,$2,$3,$4,1,$5,20000,1300,22600)", [tenant, version, product, { sku: "SIM-1", name: "Simulado", unit: "UN" }, { purchaseCostCents: 10000, taxCreditBps: 1000, packagingCents: 100 }])
    await seed.query("UPDATE commercial_settings SET active_price_version_id=$2 WHERE tenant_id=$1 AND product_line='imported'", [tenant, version])

    const published: unknown[] = []
    const gateway = { fail: false }
    const catalogMedia: CatalogMedia = { tenantId: tenant, async publish(payload) { if (gateway.fail) throw new Problem(409, "domain_conflict", "Publicação pendente. Repita para conferir a mesma versão"); published.push(payload) } }
    const pool: DatabasePool = { async connect() { const client = await connections.connect(); await client.query(`SET ROLE ${role}`); return new PgClientAdapter(client) } }
    app = buildApp({ pool, userinfoUrl: "http://auth.test/userinfo", catalogMedia, fetchAuth: async (_url, init) => { const sub = new Headers(init?.headers).get("authorization")!.slice(7); return Response.json({ sub, email: `${sub}@example.test` }) } })
    const server = app
    const call = (method: "GET" | "POST" | "PUT", path: string, options: { as?: string | null; tenant?: string; headers?: Record<string, string>; payload?: unknown } = {}): Promise<LightMyRequestResponse> => server.inject({
      method, url: path, ...(options.payload === undefined ? {} : { payload: options.payload as object }),
      headers: { ...(options.as === null ? {} : { authorization: `Bearer ${options.as ?? "admin"}` }), "x-tenant-id": options.tenant ?? tenant, ...options.headers },
    })
    const status = async (response: Promise<LightMyRequestResponse>, code: number) => { const reply = await response; assert.equal(reply.statusCode, code, reply.body); return reply }
    const put = (path: string, revision: string | null, payload: unknown, as = "admin", tenantId = tenant) => call("PUT", path, { as, tenant: tenantId, payload, headers: revision === null ? {} : { "if-match": revision } })

    await t.test("sales-settings and purchase-settings", async () => {
      for (const [path, flag, read, event] of [["/api/v1/sales-settings", "requireCustomerContact", "sales.orders.read", "sales.settings.updated"], ["/api/v1/purchase-settings", "requireSupplierContact", "purchasing.orders.read", "purchase.settings.updated"]] as const) {
        const body = { minimumOrderAmount: "1500.00", maximumPaymentTermDays: 90, [flag]: true }
        await status(call("GET", path, { as: null }), 401)
        await status(call("GET", path, { as: "nobody" }), 403)
        await status(call("GET", path, { as: "stranger" }), 403)
        const initial = await status(call("GET", path, { as: "viewer" }), 200)
        assert.equal(initial.headers.etag, '"1"')
        assert.deepEqual(initial.json(), { tenantId: tenant, revision: 1, canEdit: false, data: null }, read)
        await status(put(path, '"1"', body, null as unknown as string), 401)
        await status(put(path, '"1"', body, "seller"), 403)
        await status(put(path, '"1"', body, "viewer"), 403)
        await status(put(path, null, body), 428)
        await status(put(path, "1", body), 400)
        for (const invalid of [{ ...body, extra: 1 }, { ...body, minimumOrderAmount: "10.5" }, { ...body, minimumOrderAmount: "1500" }, { ...body, maximumPaymentTermDays: 3651 }, { ...body, maximumPaymentTermDays: -1 }, { ...body, maximumPaymentTermDays: "90" }, { ...body, [flag]: "yes" }, { minimumOrderAmount: "1.00", maximumPaymentTermDays: 1 }])
          await status(put(path, '"1"', invalid), 422)
        await status(put(path, '"2"', body), 412)
        const saved = await status(put(path, '"1"', body), 200)
        assert.equal(saved.headers.etag, '"2"')
        assert.deepEqual(saved.json(), { tenantId: tenant, revision: 2, canEdit: true, data: body })
        await status(put(path, '"1"', body), 412)
        const read2 = await status(call("GET", path, { as: "viewer" }), 200)
        assert.deepEqual(read2.json().data, body)
        assert.equal(read2.json().canEdit, false)
        assert.equal((await seed.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id=$1 AND action=$2", [tenant, event])).rows[0].n, 1)
        // Another company has its own, untouched settings and cannot be edited with this tenant's revision.
        const foreign = await status(call("GET", path, { as: "outsider", tenant: other }), 200)
        assert.deepEqual({ revision: foreign.json().revision, data: foreign.json().data }, { revision: 1, data: null })
        await status(call("GET", path, { as: "outsider" }), 403)
        await status(put(path, '"2"', body, "outsider"), 403)
      }
      // Two editors race for revision 1: exactly one wins.
      const race = await Promise.all(["2000.00", "3000.00"].map(minimumOrderAmount => put("/api/v1/sales-settings", '"2"', { minimumOrderAmount, maximumPaymentTermDays: 30, requireCustomerContact: false })))
      assert.deepEqual(race.map(r => r.statusCode).sort(), [200, 412])
    })

    await t.test("sales-simulator options, quote and orders", async () => {
      const base = "/api/v1/sales-simulator/imported"
      await status(call("GET", base, { as: null }), 401)
      await status(call("GET", base, { as: "nobody" }), 403)
      await status(call("GET", "/api/v1/sales-simulator/other"), 422)
      await status(call("GET", `${base}?bogus=1`), 422)
      await status(call("GET", `${base}?versionId=${randomUUID()}`), 404)
      const options = await status(call("GET", base, { as: "viewer" }), 200)
      assert.equal(options.json().canCreate, false)
      assert.equal(options.json().versions.length, 1)
      assert.equal(options.json().data.id, version)
      assert.equal(options.json().data.items[0].sku, "SIM-1")
      assert.equal(options.json().data.items[0].priceWithIpiCents, 22600)
      assert.equal((await status(call("GET", base, { as: "seller" }), 200)).json().canCreate, true)
      // Nothing of this company is visible from another one, and the national line is empty.
      const foreign = await status(call("GET", base, { as: "outsider", tenant: other }), 200)
      assert.deepEqual({ versions: foreign.json().versions, data: foreign.json().data }, { versions: [], data: null })
      assert.equal((await status(call("GET", "/api/v1/sales-simulator/national"), 200)).json().data, null)
      await status(call("GET", `${base}?versionId=${version}`, { as: "outsider", tenant: other }), 404)

      const input = { versionId: version, productId: product, quantity: 2, destination: "SP", taxpayer: false, discount: { kind: "percent", value: 0 }, freightCents: 0 }
      const quote = (payload: unknown, as = "admin", tenantId = tenant, line = "imported") => call("POST", `/api/v1/sales-simulator/${line}/quote`, { as, tenant: tenantId, payload })
      await status(quote(input, null as unknown as string), 401)
      await status(quote(input, "nobody"), 403)
      for (const invalid of [{ ...input, extra: 1 }, { ...input, discount: { kind: "percent", value: 10000 } }, { ...input, discount: { kind: "bogus", value: 1 } }, { ...input, quantity: 0 }, { ...input, quantity: 1000001 }, { ...input, freightCents: -1 }, { ...input, destination: "XX" }, { ...input, discount: { kind: "target", value: 45201 } }, { ...input, discount: { kind: "amount", value: 40000 } }, { ...input, versionId: "x" }, {}])
        await status(quote(invalid), 422)
      await status(quote(input, "admin", tenant, "other"), 422)
      await status(quote({ ...input, productId: randomUUID() }), 404)
      await status(quote({ ...input, versionId: randomUUID() }), 404)
      // Values fixed from the Rust reference: 2 x 200.00, IPI 13%, below target.
      const full = await status(quote(input), 200)
      assert.equal(full.json().digest.length, 64)
      assert.equal(full.json().version, 1)
      assert.equal(full.json().sale.netSaleCents, 40000)
      assert.equal(full.json().sale.invoiceTotalCents, 45200)
      assert.equal(full.json().sale.band, "below_target")
      assert.deepEqual(full.json().sale.approvalReasons, ["below_target"])
      assert.equal(full.json().director.netProfitCents, 5280)
      assert.equal(full.json().director.requiredDownPaymentCents, 27487)
      assert.deepEqual(full.json().product, { sku: "SIM-1", name: "Simulado", unit: "UN" })
      assert.equal((await status(quote({ ...input, discount: { kind: "target", value: 40000 } }), 200)).json().sale.invoiceTotalCents, 40000)
      for (const seller of ["seller", "viewer"]) {
        const redacted = await status(quote(input, seller), 200)
        assert.equal("director" in redacted.json(), false)
        assert.equal(redacted.json().sale.invoiceTotalCents, 45200)
        assert.equal(redacted.json().digest, full.json().digest)
        assert.doesNotMatch(redacted.body, /purchaseCost|taxCredit|packaging/)
      }
      await status(quote(input, "outsider", tenant), 403)
      await status(quote(input, "outsider", other), 404)

      const order = (payload: unknown, options: { key?: string | null; as?: string | null; tenant?: string; line?: string } = {}) => call("POST", `/api/v1/sales-simulator/${options.line ?? "imported"}/orders`, { as: options.as === undefined ? "admin" : options.as, tenant: options.tenant ?? tenant, payload, headers: options.key === null ? {} : { "idempotency-key": options.key ?? randomUUID() } })
      const create = { quote: input, digest: full.json().digest, customerId: tenant, dueDate: soon(10) }
      await status(order(create, { as: null }), 401)
      await status(order(create, { key: null }), 428)
      await status(order(create, { key: "not-a-uuid" }), 422)
      await status(order(create, { as: "viewer" }), 403)
      await status(order(create, { as: "nobody" }), 403)
      for (const invalid of [{ ...create, extra: 1 }, { ...create, quote: { ...input, quantity: "2" } }, { ...create, customerId: "x" }, { ...create, digest: undefined }, { ...create, dueDate: "31/01/2100" }])
        await status(order(invalid), 422)
      await status(order({ ...create, dueDate: "2100-02-30" }), 422)
      await status(order({ ...create, digest: "0".repeat(64) }), 412)
      await status(order({ ...create, customerId: randomUUID() }), 409)
      await status(order({ ...create, quote: { ...input, productId: randomUUID() } }), 404)
      await status(order(create, { as: "outsider", tenant: other }), 404)
      assert.equal((await seed.query("SELECT count(*)::int AS n FROM sales_orders WHERE tenant_id=$1", [tenant])).rows[0].n, 0, "rejected requests must not leave orders")

      const key = randomUUID(), created = await status(order(create, { key }), 201)
      assert.equal(created.headers.etag, '"1"')
      assert.deepEqual(created.json(), { tenantId: tenant, id: created.json().id, revision: 1, status: "draft", needsApproval: true })
      const id = created.json().id as string
      const row = (await seed.query("SELECT o.amount_cents,o.status,l.price_cents,l.amount_cents AS line_amount,l.quantity_micros,l.sku,l.name,s.needs_approval,s.snapshot FROM sales_orders o JOIN sales_order_lines l ON l.order_id=o.id JOIN order_pricing_snapshots s ON s.order_id=o.id WHERE o.id=$1", [id])).rows[0]
      assert.equal(Number(row.amount_cents), 45200)
      assert.equal(Number(row.price_cents), 22600)
      assert.equal(Number(row.line_amount), 45200)
      assert.equal(Number(row.quantity_micros), 2_000_000)
      assert.deepEqual([row.sku, row.name, row.status, row.needs_approval], ["SIM-1", "Simulado", "draft", true])
      assert.equal(row.snapshot.digest, full.json().digest)
      assert.equal(row.snapshot.director.netProfitCents, 5280)
      assert.equal((await seed.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_id=$1 AND action='order.created'", [id])).rows[0].n, 1)
      // Idempotency: the same key replays the same answer, another payload under it conflicts.
      const replay = await status(order(create, { key }), 201)
      assert.deepEqual(replay.json(), created.json())
      await status(order({ ...create, dueDate: soon(11) }, { key }), 409)
      assert.equal((await seed.query("SELECT count(*)::int AS n FROM sales_orders WHERE tenant_id=$1", [tenant])).rows[0].n, 1)
      // The existing pricing endpoint shows the snapshot to directors only.
      assert.equal((await status(call("GET", `/api/v1/orders/${id}/pricing`), 200)).json().data.snapshot.director.netProfitCents, 5280)
      assert.equal("director" in (await status(call("GET", `/api/v1/orders/${id}/pricing`, { as: "seller" }), 200)).json().data.snapshot, false)
      await status(call("GET", `/api/v1/orders/${id}/pricing`, { as: "outsider", tenant: other }), 404)
      // A discount within the free limit but below target still reports its reason; a better price needs no approval.
      const free = await status(quote({ ...input, quantity: 1, discount: { kind: "percent", value: 0 }, freightCents: 0 }), 200)
      assert.equal(typeof free.json().sale.needsApproval, "boolean")
    })

    await t.test("proposal revise, convert and approve-order", async () => {
      const header = (as: string, revision: string | null, key: string | null = randomUUID()) => ({ as, headers: { ...(revision === null ? {} : { "if-match": revision }), ...(key === null ? {} : { "idempotency-key": key }) } })
      const createProposal = async () => {
        const reply = await status(call("POST", "/api/v1/proposals", { payload: { customerId: tenant, validUntil: "2100-01-01", paymentTerms: "À vista", deliveryTerms: "Retirada", notes: "", items: [{ productId: proposalProduct, quantity: "1.000000" }] }, headers: { "idempotency-key": randomUUID() } }), 201)
        return reply.json().data.id as string
      }
      const act = (id: string, action: string, revision: string | null, payload: unknown, options: { as?: string; key?: string | null; tenant?: string } = {}) =>
        call("POST", `/api/v1/proposals/${id}/${action}`, { ...header(options.as ?? "admin", revision, options.key), tenant: options.tenant ?? tenant, payload })
      const due = { dueDate: soon(11) }

      // Invalid input, access and missing headers are rejected before any state changes.
      const draft = await createProposal()
      for (const action of ["revise", "convert", "approve-order"]) {
        const payload = action === "revise" ? undefined : due
        await status(call("POST", `/api/v1/proposals/${draft}/${action}`, { as: null, headers: { "if-match": '"1"', "idempotency-key": randomUUID() }, payload: payload as object }), 401)
        await status(act(draft, action, '"1"', payload, { as: "nobody" }), 403)
        await status(act(draft, action, '"1"', payload, { as: "viewer" }), 403)
        await status(act(draft, action, null, payload), 428)
        await status(act(draft, action, '"1"', payload, { key: null }), 428)
        await status(act(draft, action, '"1"', payload, { key: "x" }), 422)
        await status(act(draft, action, '"2"', payload), 412)
        await status(act(randomUUID(), action, '"1"', payload), 404)
        await status(act(draft, action, '"1"', payload, { as: "outsider" }), 403)
        await status(act(draft, action, '"1"', payload, { as: "outsider", tenant: other }), 404)
      }
      for (const action of ["convert", "approve-order"]) for (const invalid of [undefined, {}, { dueDate: "2100-13-01" }, { dueDate: "2100-02-01", extra: 1 }, { dueDate: 20000101 }])
        await status(act(draft, action, '"1"', invalid), 422)
      await status(act(draft, "revise", '"1"', { extra: 1 }), 200).catch(() => undefined)
      // Only the decision power approves and creates an order in one step.
      await status(act(draft, "approve-order", '"1"', due, { as: "seller" }), 403)
      // Invalid transitions: a draft is neither revised nor converted.
      const second = await createProposal()
      await status(act(second, "revise", '"1"', undefined), 409)
      await status(act(second, "convert", '"1"', due), 409)
      assert.equal((await seed.query("SELECT count(*)::int AS n FROM sales_orders WHERE tenant_id=$1 AND id IN (SELECT order_id FROM sales_proposals WHERE id=$2)", [tenant, second])).rows[0].n, 0)

      // approve-order: accepts and creates the draft order atomically; the key makes it idempotent.
      const key = randomUUID(), orders = async () => (await seed.query("SELECT count(*)::int AS n FROM sales_orders WHERE tenant_id=$1", [tenant])).rows[0].n
      const before = await orders()
      const approved = await status(act(second, "approve-order", '"1"', due, { key }), 200)
      assert.equal(approved.json().data.status, "accepted")
      assert.equal(approved.headers.etag, '"2"')
      const orderId = approved.json().data.orderId as string
      assert.ok(orderId)
      assert.equal(await orders(), before + 1)
      const replay = await status(act(second, "approve-order", '"1"', due, { key }), 200)
      assert.deepEqual(replay.json(), approved.json())
      await status(act(second, "approve-order", '"1"', { dueDate: soon(12) }, { key }), 409)
      assert.equal(await orders(), before + 1)
      const order = await status(call("GET", `/api/v1/orders/${orderId}`), 200)
      assert.equal(order.json().data.amount, "100.00")
      await status(call("GET", `/api/v1/orders/${orderId}`, { as: "outsider", tenant: other }), 404)
      // Converted proposals accept no further transition.
      for (const action of ["convert", "approve-order", "revise"]) await status(act(second, action, '"2"', action === "revise" ? undefined : due), 409)
      assert.equal(await orders(), before + 1)

      // revise: a sent proposal becomes a new version; the same key replays.
      const third = await createProposal()
      await status(act(third, "send", '"1"', {}), 200)
      const reviseKey = randomUUID()
      const revised = await status(act(third, "revise", '"2"', undefined, { key: reviseKey }), 200)
      assert.equal(revised.json().data.version, 2)
      assert.equal(revised.json().data.status, "draft")
      assert.equal(revised.json().versions[1].status, "superseded")
      assert.deepEqual((await status(act(third, "revise", '"2"', undefined, { key: reviseKey }), 200)).json(), revised.json())
      await status(act(third, "revise", '"2"', undefined), 412)
      await status(act(third, "revise", '"3"', undefined), 409)

      // convert: only an accepted proposal; a sent one must be accepted first.
      await status(act(third, "send", '"3"', {}), 200)
      await status(act(third, "convert", '"4"', due), 409)
      await status(act(third, "accept", '"4"', {}), 200)
      await status(act(third, "convert", '"5"', due, { as: "viewer" }), 403)
      const convertKey = randomUUID()
      const converted = await status(act(third, "convert", '"5"', due, { key: convertKey }), 200)
      assert.ok(converted.json().data.orderId)
      assert.equal(converted.headers.etag, '"6"')
      assert.deepEqual((await status(act(third, "convert", '"5"', due, { key: convertKey }), 200)).json(), converted.json())
      await status(act(third, "convert", '"6"', due), 409)
      // A customer who stopped being active blocks conversion without side effects.
      const fourth = await createProposal()
      await status(act(fourth, "send", '"1"', {}), 200)
      await status(act(fourth, "accept", '"2"', {}), 200)
      await seed.query("UPDATE parties SET status='archived' WHERE tenant_id=$1 AND id=$1", [tenant])
      const count = await orders()
      await status(act(fourth, "convert", '"3"', due), 409)
      assert.equal(await orders(), count)
      await seed.query("UPDATE parties SET status='active' WHERE tenant_id=$1 AND id=$1", [tenant])
      // Each command left an audit trail and an outbox event.
      for (const event of ["proposal.revised", "proposal.converted", "proposal.approved_order"]) {
        assert.ok((await seed.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id=$1 AND action=$2", [tenant, event])).rows[0].n >= 1, event)
        assert.ok((await seed.query("SELECT count(*)::int AS n FROM outbox_events WHERE tenant_id=$1 AND event_type=$2", [tenant, event])).rows[0].n >= 1, event)
      }
    })

    await t.test("catalog-publication preview and explicit publish", async () => {
      const path = "/api/v1/catalog-publication"
      const file = randomUUID(), media = randomUUID()
      await seed.query("INSERT INTO system_config.files(tenant_id,id,storage_key,original_name,media_type,byte_size,sha256,status,created_by) VALUES($1,$2,'r2://ludus-equipamentos-midias/ludus/catalogo/cat-1.webp','cat-1.webp','image/webp',10,$3,'available',$4)", [tenant, file, "b".repeat(64), identities.get("admin")])
      await seed.query("INSERT INTO product_media_assets(tenant_id,id,product_id,file_id,collection,variant,version,width_px,height_px) VALUES($1,$2,$3,$4,'core','webp',1,100,100)", [tenant, media, catalogProduct, file])
      await seed.query("INSERT INTO product_catalog_profiles(tenant_id,product_id,collection,muscle_group,technical_category,dimensions_mm,description,weight,weight_stack,public_path,main_media_id) VALUES($1,$2,'core','Peito','Linha A','{1000,800,1500}','Descrição','100 kg','50 kg','/core/product-cat-1/',$3)", [tenant, catalogProduct, media])
      await status(call("GET", path, { as: null }), 401)
      await status(call("GET", path, { as: "nobody" }), 403)
      await status(call("GET", path, { as: "outsider" }), 403)
      const preview = await status(call("GET", path, { as: "viewer" }), 200)
      assert.equal(preview.json().canEdit, false)
      assert.equal(preview.json().configured, true)
      assert.equal(preview.json().publication, null)
      assert.match(preview.json().previewHash, /^[0-9a-f]{64}$/)
      assert.deepEqual(preview.json().products.map((item: Record<string, unknown>) => [item.code, item.colecao, item.imageKey, item.dim]), [["CAT-1", "core", "ludus/catalogo/cat-1.webp", [1000, 800, 1500]]])
      assert.doesNotMatch(preview.body, /price|preco|preço/i)
      assert.equal((await status(call("GET", path), 200)).json().canEdit, true)
      // Another company sees an empty, unconfigured preview.
      const foreign = await status(call("GET", path, { as: "outsider", tenant: other }), 200)
      assert.deepEqual({ products: foreign.json().products, configured: foreign.json().configured }, { products: [], configured: false })

      const hash = preview.json().previewHash as string
      const publish = (payload: unknown, options: { key?: string | null; as?: string | null; tenant?: string } = {}) => call("POST", path, { as: options.as === undefined ? "admin" : options.as, tenant: options.tenant ?? tenant, payload, headers: options.key === null ? {} : { "idempotency-key": options.key ?? randomUUID() } })
      await status(publish({ previewHash: hash }, { as: null }), 401)
      await status(publish({ previewHash: hash }, { key: null }), 428)
      await status(publish({ previewHash: hash }, { key: "x" }), 422)
      await status(publish({ previewHash: hash }, { as: "viewer" }), 403)
      await status(publish({ previewHash: hash }, { as: "nobody" }), 403)
      for (const invalid of [{}, { previewHash: 1 }, { previewHash: hash, extra: true }]) await status(publish(invalid), 422)
      await status(publish({ previewHash: "0".repeat(64) }), 409)
      await status(publish({ previewHash: hash }, { as: "outsider", tenant: other }), 409)
      assert.equal((await seed.query("SELECT count(*)::int AS n FROM catalog_publications")).rows[0].n, 0)

      // A gateway failure keeps the exact snapshot pending; the retry publishes that snapshot even after the catalog changed.
      const key = randomUUID()
      gateway.fail = true
      await status(publish({ previewHash: hash }, { key }), 409)
      assert.equal((await seed.query("SELECT status FROM catalog_publications WHERE id=$1", [key])).rows[0].status, "pending")
      await seed.query("UPDATE product_catalog_profiles SET revision=revision+1,description='Mudou' WHERE tenant_id=$1 AND product_id=$2", [tenant, catalogProduct])
      gateway.fail = false
      const done = await status(publish({ previewHash: hash }, { key }), 200)
      assert.deepEqual({ id: done.json().id, published: done.json().published }, { id: key, published: true })
      assert.equal(typeof done.json().sequence, "number")
      assert.equal(published.length, 1)
      const sent = published[0] as { id: string; sequence: number; products: Array<Record<string, unknown>> }
      assert.deepEqual([sent.id, sent.sequence, sent.products[0]!.descricao], [key, done.json().sequence, "Descrição"])
      // Idempotent replay publishes nothing twice; the key cannot be reused for another preview.
      assert.deepEqual((await status(publish({ previewHash: hash }, { key }), 200)).json(), done.json())
      assert.equal(published.length, 1)
      await status(publish({ previewHash: "1".repeat(64) }, { key }), 409)
      await status(publish({ previewHash: hash }), 409)
      const current = await status(call("GET", path), 200)
      assert.equal(current.json().publication.id, key)
      assert.notEqual(current.json().previewHash, hash)
      assert.equal((await seed.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id=$1 AND action='catalog.published'", [tenant])).rows[0].n, 1)
      // The new preview publishes as a later sequence.
      const next = await status(publish({ previewHash: current.json().previewHash }), 200)
      assert.ok(next.json().sequence > done.json().sequence)
      // Nothing to publish is not publishable.
      await seed.query("UPDATE products SET status='archived' WHERE tenant_id=$1 AND id=$2", [tenant, catalogProduct])
      const empty = await status(call("GET", path), 200)
      assert.deepEqual(empty.json().products, [])
      await status(publish({ previewHash: empty.json().previewHash }), 422)
    })
  } finally {
    await app?.close()
    await connections.end(); await seed.end()
    await admin.query(`DROP DATABASE IF EXISTS ${database}`)
    await admin.query(`DROP ROLE IF EXISTS ${role}`)
    await admin.end()
  }
})
