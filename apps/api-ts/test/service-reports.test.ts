import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { serviceReportSources } from "../src/modules/services/report-sources.js"
import { runtimePool } from "./services-support.js"
import { databaseTestOptions, withTestContext } from "./support/test-context.js"

test("relatórios de serviços: contratos a vencer, receita recorrente, OS por técnico e por SLA", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["service.contracts.read", "service.contracts.manage", "service.orders.read", "service.orders.manage"] }, async ctx => {
    const customer = randomUUID(), technician = randomUUID(), user = ctx.as("user")
    await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Cliente','52998224725',true,false,'active')", [customer, ctx.tenant])
    await ctx.seed.query("INSERT INTO staff(id,tenant_id,code,name,is_employee,is_seller,status) VALUES($1,$2,'T1','Técnica Ana',true,false,'active')", [technician, ctx.tenant])
    const items = [{ description: "Suporte", serviceCode: "14.01", quantity: "1", unitCents: 120000 }]
    for (const [periodicity, endOn] of [["monthly", "2099-01-31"], ["quarterly", "2099-06-30"]] as const) {
      const created = (await user.post("/api/v1/service-contracts", { body: { customerId: customer, title: "Contrato " + periodicity, periodicity, billingDay: 5, startOn: "2098-01-01", endOn, adjustmentIndex: "none", items } })).json().data
      await user.post(`/api/v1/service-contracts/${created.id}/transition`, { body: { status: "active" }, revision: created.revision })
    }
    const open = (await user.post("/api/v1/service-orders", { body: { customerId: customer, title: "Chamado em campo", technicianId: technician, slaHours: 1 } })).json().data
    await ctx.seed.query("UPDATE service_orders SET sla_due_at=now()-interval '1 hour' WHERE id=$1", [open.id])
    await user.post(`/api/v1/service-orders/${open.id}/hours`, { body: { minutes: 30, rateCents: 10000 }, revision: open.revision })

    const pool = runtimePool(ctx), client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [ctx.tenant])
      const context = { client, tenantId: ctx.tenant, authSubject: "user", permissions: [], identity: { subject: "user", email: "u@example.test", name: "U" } }
      const [expiring, revenue, byTechnician, bySla] = await Promise.all(serviceReportSources.map(source => source.load(context as never, {}, 100)))
      assert.deepEqual(expiring!.map(r => r.endOn), ["2099-01-31", "2099-06-30"])
      assert.equal(revenue!.reduce((total, row) => total + Number(row.monthlyCents), 0), 120000 + 40000, "mensal 1.200,00 + trimestral 400,00/mês")
      assert.deepEqual(byTechnician!.map(r => [r.technician, r.minutes, r.laborCents]), [["Técnica Ana", 30, 5000]])
      assert.deepEqual(bySla!.map(r => r.sla), ["overdue"])
      const filtered = await serviceReportSources[0]!.load(context as never, { endOn: { from: "2099-06-01", to: "2099-12-31" } }, 100)
      assert.equal(filtered.length, 1)
      await client.query("ROLLBACK")
    } finally { client.release() }
    // Isolamento por empresa: a outra empresa não enxerga nada.
    const other = await pool.connect()
    try {
      await other.query("BEGIN"); await other.query("SELECT set_config('app.tenant_id',$1,true)", [ctx.otherTenant])
      for (const source of serviceReportSources) assert.deepEqual(await source.load({ client: other, tenantId: ctx.otherTenant } as never, {}, 100), [])
      await other.query("ROLLBACK")
    } finally { other.release() }
  })
})
test("relatórios de serviços: cada fonte exige a permissão do módulo e declara colunas padrão existentes", () => {
  for (const source of serviceReportSources) {
    assert.ok(source.permissions.every(code => /^service\.(contracts|orders)\.read$/.test(code)))
    for (const column of source.defaultColumns) assert.ok(column in source.columns, `${source.id}.${column}`)
  }
})
