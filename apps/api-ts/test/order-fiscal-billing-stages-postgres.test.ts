import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { localCommercePostgres } from "./local-commerce-postgres.js"

test("V4 • pedido de 14 itens só aparece como faturado após a segunda nota autorizada", {skip: !process.env.API_TS_TEST_ADMIN_URL}, async () => {
  await localCommercePostgres(async ({app, seed, tenant, clerk}) => {
    const order = randomUUID()
    const taxId = "19131243000197"
    const headers = {authorization: "Bearer cashier", "x-tenant-id": tenant}
    const url = "/api/v1/fiscal/order-lots/" + order
    const lines = Array.from({length: 14}, (_, index) => index + 1)
    await seed.query("INSERT INTO role_permissions SELECT $1, unnest($2::text[])", [clerk, [
      "sales.orders.read", "sales.orders.manage", "fiscal.nfe.read", "fiscal.nfe.manage",
    ]])
    await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status) VALUES($1,$1,'juridica','Cliente',$2,true,false,'active')", [tenant, taxId])
    await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente',$3,CURRENT_DATE,1400,'draft')", [order, tenant, taxId])
    await seed.query(`WITH products_created AS (
      INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status)
      SELECT gen_random_uuid(),$1,'IT-'||n,'Equipamento '||n,'UN',100,'active' FROM generate_series(1,14) n
      RETURNING id,sku,name)
      INSERT INTO sales_order_lines(tenant_id,order_id,line_number,product_id,sku,name,unit,quantity_micros,price_cents,amount_cents)
      SELECT $1,$2,split_part(sku,'-',2)::int,id,sku,name,'UN',1000000,100,100 FROM products_created`, [tenant, order])
    await seed.query("UPDATE sales_orders SET status='confirmed' WHERE tenant_id=$1 AND id=$2", [tenant, order])
    await seed.query("INSERT INTO receivables(id,tenant_id,order_id,customer_name,due_date,amount_cents,status) VALUES($1,$2,$3,'Cliente',CURRENT_DATE,1400,'open')", [randomUUID(), tenant, order])

    async function state() {
      const response = await app.inject({url: url + "?environment=production", headers})
      assert.equal(response.statusCode, 200, response.body)
      return response.json<{revision: number, lines: {lineNumber: number, billed: string, available: string}[]}>()
    }
    async function stage() {
      const response = await app.inject({url: "/api/v1/orders?view=workspace", headers})
      assert.equal(response.statusCode, 200, response.body)
      const row = response.json<{data: {id: string, stage: string | null}[]}>().data.find(row => row.id === order)
      assert.ok(row)
      return row.stage
    }
    async function prepare(group: number[]) {
      const response = await app.inject({method: "POST", url,
        headers: {...headers, "if-match": '"' + (await state()).revision + '"', "idempotency-key": randomUUID()},
        payload: {action: "prepare", environment: "production", items: group.map(lineNumber => ({lineNumber, quantityMicros: "1000000"}))}})
      assert.equal(response.statusCode, 200, response.body)
      return response.json<{id: string}>().id
    }
    async function recordAuthorization(lot: string, group: number[], number: number) {
      const draft = randomUUID()
      const details = {recipient: {taxId}, items: group.map(line => ({code: "IT-" + line, unit: "UN", quantity: "1", unitPrice: "1.00"}))}
      await seed.query("INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents) VALUES($1,$2,'production',55,1,1,'{}',$3,$4)", [tenant, draft, details, group.length * 100])
      await seed.query("INSERT INTO domain_commands(tenant_id,auth_subject,command_key,scope,request,result) VALUES($1,'cashier',$2,'fiscal.nfe.draft.create',$3,$4)", [tenant, lot, details, {data: {id: draft}}])
      await seed.query(`INSERT INTO fiscal_nfe_documents(tenant_id,id,model,environment,status,series,number,issued_at,random_code,access_key,signed_xml,authorized_xml,protocol)
        VALUES($1,$2,55,'production','authorized',1,$3,now(),'10000001',$4,'<xml/>','<xml/>','135260000000000')`, [tenant, draft, number, String(number).padStart(44, "1")])
    }

    const first = lines.slice(0, 6)
    const second = lines.slice(6)
    const firstLot = await prepare(first)
    assert.equal(await stage(), null)
    await recordAuthorization(firstLot, first, 1)
    assert.equal(await stage(), "partial")
    const intermediate = (await state()).lines
    assert.deepEqual(intermediate.filter(line => line.billed === "1000000").map(line => line.lineNumber), first)
    assert.deepEqual(intermediate.filter(line => line.available === "1000000").map(line => line.lineNumber), second)
    const secondLot = await prepare(second)
    assert.equal(await stage(), "partial")
    await recordAuthorization(secondLot, second, 2)
    assert.equal(await stage(), "billed")
    const final = (await state()).lines
    assert.deepEqual(final.map(line => line.lineNumber), lines)
    assert.ok(final.every(line => line.billed === "1000000" && line.available === "0"))
    assert.deepEqual((await seed.query("SELECT amount_cents FROM receivables WHERE tenant_id=$1 AND order_id=$2", [tenant, order])).rows, [{amount_cents: "1400"}])
  })
})
