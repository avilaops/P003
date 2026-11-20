import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { databaseTestOptions, withTestContext } from "./support/test-context.js"

const base = { kind: "customer", revision: 0, creditLimitCents: 500000, validUntil: null, blocked: false, overdueDays: null, termId: null, listId: null }
async function seed(ctx: { seed: import("pg").Pool; tenant: string; otherTenant: string }) {
  const customer = randomUUID(), seller = randomUUID(), archived = randomUUID(), outsider = randomUUID()
  await ctx.seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$2,'fisica','Academia Aurora','52998224725',true,false,'active')", [customer, ctx.tenant])
  const staff = (id: string, tenant: string, code: string, name: string, status: string) => ctx.seed.query("INSERT INTO staff(id,tenant_id,code,name,job_title,email,phone,is_employee,is_seller,status) VALUES($1,$2,$3,$4,'Vendedor',$5,'11999990000',false,true,$6)", [id, tenant, code, name, code + "@example.test", status])
  await staff(seller, ctx.tenant, "ANA", "Ana Vendas", "active"); await staff(archived, ctx.tenant, "BIA", "Bia Arquivada", "archived"); await staff(outsider, ctx.otherTenant, "OUT", "Outra Empresa", "active")
  return { customer, seller, archived, outsider }
}

test("Escolher o cliente no Novo pedido preenche vendedor e região do cadastro comercial, com a origem", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["platform.company.manage", "sales.orders.read"] }, async ctx => {
    const ids = await seed(ctx), url = "/api/v1/commercial/policies/settings"
    const saved = await ctx.as("user").post(url, { body: { ...base, id: ids.customer, sellerId: ids.seller, region: "Sudeste" } })
    assert.equal(saved.statusCode, 200, saved.body)
    const catalog = await ctx.as("user").get("/api/v1/commercial/policies/catalog/" + ids.customer)
    assert.equal(catalog.statusCode, 200, catalog.body)
    assert.deepEqual(catalog.json().defaultSeller, { id: ids.seller, name: "Ana Vendas" })
    assert.equal(catalog.json().region, "Sudeste")
    assert.equal(catalog.json().policy.sellerName, "Ana Vendas")
    assert.deepEqual(catalog.json().sellers.map((row: { name: string }) => row.name), ["Ana Vendas"], "só vendedores ativos")
    const without = await ctx.as("user").get("/api/v1/commercial/policies/catalog")
    assert.equal(without.json().defaultSeller, null)
  })
})

test("POST /api/v1/commercial/policies/settings [customer]: vendedor inválido 422, revisão 412, 401/403", databaseTestOptions, async () => {
  await withTestContext({ permissions: ["platform.company.manage", "sales.orders.read"] }, async ctx => {
    const ids = await seed(ctx), url = "/api/v1/commercial/policies/settings", body = { ...base, id: ids.customer, sellerId: ids.seller, region: null }
    assert.equal((await ctx.as("anonymous").post(url, { body })).statusCode, 401)
    assert.equal((await ctx.as("denied").post(url, { body })).statusCode, 403)
    for (const sellerId of [ids.archived, ids.outsider, randomUUID()]) assert.equal((await ctx.as("user").post(url, { body: { ...body, sellerId } })).statusCode, 422, sellerId)
    assert.equal((await ctx.as("user").post(url, { body: { ...body, region: "" } })).statusCode, 422)
    assert.equal((await ctx.as("user").post(url, { body })).statusCode, 200)
    assert.equal((await ctx.as("user").post(url, { body })).statusCode, 412, "revisão 0 repetida")
    assert.equal((await ctx.as("user").post(url, { body: { ...body, revision: 1, sellerId: null } })).statusCode, 200)
    assert.equal((await ctx.as("user").get("/api/v1/commercial/policies/catalog/" + ids.customer)).json().defaultSeller, null)
  })
})
