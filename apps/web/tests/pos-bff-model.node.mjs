import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import ts from "typescript"

const tenant = "11111111-1111-4111-8111-111111111111"
const id = "22222222-2222-4222-8222-222222222222"
process.env.ERP_TYPESCRIPT_API_URL = "http://127.0.0.1:19980"
const uri = source => "data:text/javascript;base64," + Buffer.from(source).toString("base64")
const session = uri(`export const currentSession=async()=>({tenantId:"${tenant}",accessToken:"fixture"});export const currentIdentitySession=currentSession;export const erpConfiguration=()=>({origin:"http://fixture.local",api:"http://backend.local"});`)
const source = readFileSync(new URL("../src/server/bff/erp-proxy.ts", import.meta.url), "utf8").replace('import "server-only"', "").replace('"@/server/bff/erp-backend"', JSON.stringify(new URL("./helpers/erp-backend-module.mjs", import.meta.url).href)).replace('"@/server/auth/erp-session"', JSON.stringify(session)).replace('"@/lib/api/local-fiscal-origin"', JSON.stringify(new URL("../src/lib/api/local-fiscal-origin.ts", import.meta.url).href))
const { forwardErp } = await import(uri(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText))

test("POS BFF preserves account-session identity, revision, idempotency and history filters", async () => {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return Response.json({ tenantId: tenant }, { headers: { etag: '"3"' } }) }
  try {
    const history = await forwardErp(new Request("http://fixture.local/pos?status=closed&startDate=2026-11-01&offset=0&limit=20"), "/pos/sessions")
    assert.equal(history.status, 200)
    assert.equal(new URL(calls[0].url).origin, process.env.ERP_TYPESCRIPT_API_URL)
    assert.match(calls[0].url, /startDate=2026-11-01/)
    const body = { expectedTotal: "100.00", payments: [] }
    const sale = await forwardErp(new Request("http://fixture.local/pos", { method: "POST", headers: { origin: "http://fixture.local", "x-tenant-id": tenant, "content-type": "application/json", "if-match": '"2"', "idempotency-key": id }, body: JSON.stringify(body) }), `/pos/sessions/${id}/sales`)
    assert.equal(sale.headers.get("etag"), '"3"')
    assert.equal(calls[1].options.headers.get("x-tenant-id"), tenant)
    assert.equal(calls[1].options.headers.get("if-match"), '"2"')
    assert.equal(calls[1].options.headers.get("idempotency-key"), id)
    assert.deepEqual(JSON.parse(calls[1].options.body), body)
  } finally { globalThis.fetch = previous }
})
test("POS BFF rejects cross-company/origin writes, duplicated filters and unsupported operations", async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => { throw Error("Unexpected upstream") }
  const request = (headers = {}) => new Request("http://fixture.local/pos", { method: "POST", headers: { origin: "http://fixture.local", "x-tenant-id": tenant, "content-type": "application/json", ...headers }, body: "{}" })
  try {
    assert.equal((await forwardErp(request({ origin: "http://foreign.local" }), "/pos/sessions")).status, 403)
    assert.equal((await forwardErp(request({ "x-tenant-id": id }), "/pos/sessions")).status, 409)
    assert.equal((await forwardErp(new Request("http://fixture.local/pos?limit=1&limit=20"), "/pos/products")).status, 400)
    assert.equal((await forwardErp(new Request("http://fixture.local/pos?tenantId=" + id), "/pos/sessions")).status, 400)
    assert.equal((await forwardErp(new Request("http://fixture.local/pos", { method: "DELETE" }), `/pos/sessions/${id}`)).status, 405)
    assert.equal((await forwardErp(new Request("http://fixture.local/pos"), "/pos/unknown")).status, 405)
  } finally { globalThis.fetch = previous }
})
test("imports reach TypeScript and propagate only the external reference and confirmation revision", async () => {
  const previous=globalThis.fetch
  const calls=[]
  globalThis.fetch=async (url,opts)=>{calls.push([new URL(url),opts]);return Response.json({tenantId:tenant})}
  try {
    const list=await forwardErp(new Request("http://fixture.local/list"),"/sales-imports")
    assert.equal(list.status,200)
    const found=await forwardErp(new Request("http://fixture.local/search?external=A%2FB"),"/sales-channels/loja/orders")
    assert.equal(found.status,200)
    assert.equal(calls[1][0].searchParams.get("external"),"A/B")
    const confirm=await forwardErp(new Request("http://fixture.local/confirm",{method:"POST",headers:{origin:"http://fixture.local","content-type":"application/json","x-tenant-id":tenant,"if-match":'"1"',"idempotency-key":id},body:"{}"}),"/sales-imports/"+id+"/confirm")
    assert.equal(confirm.status,200)
    assert.equal(calls[2][1].headers.get("if-match"),'"1"')
    assert.equal(calls[2][1].headers.get("idempotency-key"),id)
    assert.ok(calls.every(([url])=>url.origin===process.env.ERP_TYPESCRIPT_API_URL))
    assert.equal((await forwardErp(new Request("http://fixture.local/bad?tenantId="+id),"/sales-channels/loja/orders")).status,400)
    assert.equal(calls.length,3)
  } finally {globalThis.fetch=previous}
})
