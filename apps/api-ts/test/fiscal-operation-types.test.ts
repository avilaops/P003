import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { localCommercePostgres } from "./local-commerce-postgres.js"
import { cfopFor, missingRules, operationTypeInput } from "../src/modules/fiscal/operation-types/model.js"

const repair = { code: "REM-CONSERTO", name: "Remessa para conserto", direction: "outgoing", purpose: "repair_shipment", nfePurpose: 1, cfopInternal: "5915", cfopInterstate: "6915",
  icmsCst: "41", pisCst: "08", cofinsCst: "08", movesStock: true, generatesFinance: false, generatesCommission: false, requiresOrigin: false, isDefault: true }

test("Tipo de operação • regras puras: CFOP por destino, sentido e campos faltantes", () => {
  const input = operationTypeInput.parse(repair)
  assert.equal(cfopFor(input, "SP", "SP"), "5915")
  assert.equal(cfopFor(input, "SP", "MG"), "6915")
  assert.equal(cfopFor(input, "SP", "EX"), null)
  assert.deepEqual(missingRules(input, { crt: 3 }), ["CST e classificação do IBS/CBS"])
  assert.deepEqual(missingRules(input, { crt: 1 }), ["CSOSN do ICMS"])
  assert.ok(missingRules(input, undefined).includes("perfil fiscal da empresa (CRT)"))
  assert.equal(operationTypeInput.safeParse({ ...repair, cfopInternal: "1915" }).success, false, "CFOP de entrada em tipo de saída")
  assert.equal(operationTypeInput.safeParse({ ...repair, generatesCommission: true }).success, false, "comissão sem financeiro")
  assert.equal(operationTypeInput.safeParse({ ...repair, purpose: "return" }).success, false, "devolução exige origem e finalidade 4")
  assert.equal(operationTypeInput.safeParse({ ...repair, extra: 1 }).success, false, "campo desconhecido")
})

test("PostgreSQL • tipos de operação: rotas, permissões e remessa para conserto sem título", { skip: !process.env.API_TS_TEST_ADMIN_URL }, async () => {
  await localCommercePostgres(async ({ seed, app, tenant, other, clerk }) => {
    const headers = { authorization: "Bearer cashier", "x-tenant-id": tenant }
    const url = "/api/v1/fiscal/operation-types"
    const post = (payload: object, key = randomUUID(), extra = {}) => app.inject({ method: "POST", url, headers: { ...headers, ...extra, "idempotency-key": key }, payload })
    assert.equal((await app.inject({ url, headers: { "x-tenant-id": tenant } })).statusCode, 401)
    assert.equal((await app.inject({ url, headers })).statusCode, 403, "sem permissão de leitura")
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'fiscal.operation_types.read')", [clerk])
    assert.equal((await post(repair)).statusCode, 403, "leitura não cadastra")
    for (const code of ["fiscal.operation_types.manage", "fiscal.operation_types.override", "sales.orders.read", "sales.orders.manage"])
      await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2) ON CONFLICT DO NOTHING", [clerk, code])
    await seed.query("INSERT INTO fiscal_profiles(tenant_id,revision,environment,details) VALUES($1,1,'homologation',$2)", [tenant, { environment: "homologation", state: "SP", stateRegistration: "123", crt: 1, series: 1, nextNumber: 1 }])

    // 422: CFOP de sentido errado; 201 + replay idempotente; 409 de código duplicado; 412 de revisão.
    assert.equal((await post({ ...repair, cfopInternal: "1915" })).statusCode, 422)
    const key = randomUUID(), created = await post(repair, key)
    assert.equal(created.statusCode, 201, created.body)
    assert.equal(created.json().data.complete, false)
    assert.deepEqual(created.json().data.missing, ["CSOSN do ICMS"], "regime Simples exige CSOSN: tipo incompleto")
    assert.equal((await post(repair, key)).json().data.id, created.json().data.id)
    assert.equal((await post({ ...repair, name: "Outro" }, key)).statusCode, 409, "chave reutilizada com outros dados")
    assert.equal((await post({ ...repair, isDefault: false })).statusCode, 409, "código duplicado na empresa")
    const id = created.json().data.id as string
    const put = (revision: number, payload: object) => app.inject({ method: "PUT", url: `${url}/${id}`, headers: { ...headers, "if-match": `"${revision}"` }, payload })
    assert.equal((await put(9, { ...repair, icmsCsosn: "400" })).statusCode, 412)
    assert.equal((await put(1, { ...repair, direction: "incoming", cfopInternal: "1915", cfopInterstate: "2915" })).statusCode, 409, "sentido imutável")
    const updated = await put(1, { ...repair, icmsCsosn: "400" })
    assert.equal(updated.statusCode, 200, updated.body)
    assert.equal(updated.json().data.complete, true)
    const suggestion = await app.inject({ url: `${url}/suggestion?direction=outgoing&purpose=repair_shipment`, headers })
    assert.equal(suggestion.json().data.id, id)
    assert.equal((await app.inject({ url: `${url}/suggestion?direction=outgoing`, headers })).statusCode, 422)
    // Isolamento por empresa.
    assert.equal((await app.inject({ url: `${url}/${id}`, headers: { ...headers, "x-tenant-id": other } })).statusCode, 403)

    // Aceite F1: remessa para conserto sai com o CFOP correto, movimenta estoque e não gera título.
    await seed.query("INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,email,is_customer,is_supplier,status) VALUES($1,$1,'fisica','Cliente','52998224725','cliente@example.test',true,false,'active')", [tenant])
    const product = randomUUID()
    await seed.query("INSERT INTO products(id,tenant_id,sku,name,unit,price_cents,status) VALUES($1,$2,'CONSERTO','Equipamento','UN',10000,'active')", [product, tenant])
    await seed.query("INSERT INTO stock_balances(tenant_id,product_id,quantity_micros) VALUES($1,$2,2000000)", [tenant, product])
    const orderResponse = await app.inject({ method: "POST", url: "/api/v1/orders", headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { customerId: tenant, dueDate: "2027-01-01", items: [{ productId: product, quantity: "1.000000" }] } })
    assert.equal(orderResponse.statusCode, 201, orderResponse.body)
    const order = orderResponse.json().data.id as string
    const setType = (type: string | null, revision: number) => app.inject({ method: "PUT", url: `/api/v1/orders/${order}/operation-type`, headers: { ...headers, "if-match": `"${revision}"` }, payload: { operationTypeId: type } })
    assert.equal((await setType(randomUUID(), 1)).statusCode, 404)
    const chosen = await setType(id, 1)
    assert.equal(chosen.statusCode, 200, chosen.body)
    const move = (action: string, revision: number) => app.inject({ method: "POST", url: `/api/v1/orders/${order}/${action}`, headers: { ...headers, "if-match": `"${revision}"`, "idempotency-key": randomUUID() } })
    assert.equal((await move("confirm", 2)).statusCode, 200)
    assert.equal((await setType(null, 3)).statusCode, 409, "tipo só muda em rascunho")
    const done = await move("complete", 3)
    assert.equal(done.statusCode, 200, done.body)
    const effects = await seed.query("SELECT (SELECT count(*)::int FROM receivables WHERE order_id=$1) AS receivables,(SELECT count(*)::int FROM order_commission_lines WHERE order_id=$1) AS commission", [order])
    assert.deepEqual(effects.rows[0], { receivables: 0, commission: 0 }, "remessa não gera título nem comissão")
    assert.equal((await app.inject({ url: `${url}/${id}`, headers })).json().data.cfopInternal, "5915")
  })
})

test("NF-e • tipo incompleto bloqueia a transmissão com mensagem clara; salvar aplica CFOP e CSTs", async () => {
  const { applyOperationType } = await import("../src/modules/fiscal/operation-types/model.js")
  const row = (over: object = {}) => ({ id: randomUUID(), revision: 1, code: "REM-CONSERTO", name: "Remessa para conserto", direction: "outgoing", purpose: "repair_shipment", nfe_purpose: 1,
    cfop_internal: "5915", cfop_interstate: "6915", cfop_foreign: null, icms_cst: null, icms_csosn: "400", ipi_cst: null, pis_cst: "08", cofins_cst: "08", ibs_cbs_cst: null, ibs_cbs_class: null,
    moves_stock: true, generates_finance: false, generates_commission: false, requires_origin: false, financial_category_id: null, is_default: true, active: true, ...over })
  const context = (data: object) => ({ tenantId: "t", client: { query: async (sql: string) => ({ rows: sql.includes("fiscal_profiles") ? [{ details: { crt: 1 } }] : [data] }) } }) as never
  const draft = () => ({ operationTypeId: randomUUID(), operationNature: "VENDA", model: 55, purpose: 1, recipient: { state: "MG" }, items: [{ cfop: "5102", pisCst: "49", cofinsCst: "49", csosn: "102" }] })
  const saved = draft()
  await applyOperationType(context(row()), saved, "SP", false)
  assert.deepEqual(saved.items[0], { cfop: "6915", pisCst: "08", cofinsCst: "08", csosn: "400", icmsCst: null })
  assert.equal(saved.operationNature, "Remessa para conserto")
  await applyOperationType(context(row()), saved, "SP", true)
  await assert.rejects(applyOperationType(context(row({ cofins_cst: null })), draft(), "SP", true), (e: { status: number; message: string }) =>
    e.status === 409 && e.message.includes("incompleto") && e.message.includes("CST da COFINS"))
  await assert.rejects(applyOperationType(context(row()), draft(), "SP", true), /não seguem o tipo de operação/)
  await assert.rejects(applyOperationType(context(row({ active: false })), draft(), "SP", true), /inativo/)
  await assert.rejects(applyOperationType(context(row({ direction: "incoming", cfop_internal: "1915", cfop_interstate: "2915" })), draft(), "SP", false), /sentido da nota/)
})
