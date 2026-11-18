import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { createRequire, registerHooks } from "node:module"
import { readFileSync } from "node:fs"
import "./helpers/register-typescript.mjs"

registerHooks({ resolve(specifier, context, next) {
  return specifier === "server-only" ? {url:"data:text/javascript,export {}",shortCircuit:true} : next(specifier,context)
} })
const { participantPortal } = await import("../src/server/contracts/participant-portal.ts")
const tenant = "a0000000-0000-4000-8000-000000000001"
const id = "a0000000-0000-4000-8000-000000000002"
const doc = "a0000000-0000-4000-8000-000000000003"
const base = `/icp/${tenant}/${id}`, origin = "https://contrato.avilaops.com"
const hash = "b".repeat(64), token = "c".repeat(43), portalCookie = "fixture%3D%3D"
const protectedCookie = `other=private; email_2fa_slug=${portalCookie}; __Secure-avila_icp=${token}`
const pdf = "%PDF-1.7\nsynthetic"
const backend = () => "https://private.fixture.invalid"
const req = (names = [], options = {}) => new Request(origin + base + (names.length ? "/" + names.join("/") : ""), {
  ...options, headers: { host: "contrato.avilaops.com", cookie: protectedCookie, ...options.headers }
})
const call = (actions, request, http = () => { throw Error("unexpected network") }) =>
  participantPortal(request, { tenant, id, action: actions }, backend, http)

test("login público valida host e origem e encaminha somente o cookie de verificação", async () => {
  const actions = ["entrar"]
  const input = { method: "POST", headers: { origin } }
  const publicEntry = await call([], req([], { headers: { cookie: "" } }))
  assert.match(await publicEntry.text(), /convite original/)
  assert.equal((await call([], req([], { headers: { host: "erp.avilaops.com" } }))).status, 404)
  assert.equal((await call(actions, req(actions, { method: "POST", headers: { origin: "https://example.test" } }))).status, 403)
  assert.equal((await call(actions, req(actions, { ...input, headers: { origin, cookie: "other=value" } }))).status, 403)
  const response = await call(actions, req(actions, input), async (url, init) => {
    assert.equal(String(url), `https://private.fixture.invalid/api/v1/contract-signers/${tenant}/${id}/session`)
    assert.deepEqual(init.headers, { "x-contract-portal-verification": "email_2fa_slug=" + portalCookie })
    return Response.json({ token })
  })
  assert.equal(response.status, 303)
  assert.equal(response.headers.get("location"), base)
  assert.equal(response.headers.get("set-cookie"), `__Secure-avila_icp=${token}; Path=${base}; Max-Age=900; HttpOnly; Secure; SameSite=Strict`)
  assert.equal(await response.text(), "")
})

test("página escapa nome, baixa o PDF e exige envio da versão indicada", async () => {
  const list = await call([], req(), async (_url, { headers }) => {
    assert.deepEqual(headers, { authorization: "Bearer " + token })
    return Response.json({ documents: [{ id: doc, filename: '<img src="x">.pdf', position: 1, done: false, stageRevision: "2", headRevision: "1", parentSha256: hash }] })
  })
  assert.equal(list.status, 200)
  const html = await list.text()
  assert.match(html, /&lt;img src=&quot;x&quot;&gt;/)
  assert.ok(!html.includes(token) && !html.includes(portalCookie))
  const download = ["baixar", doc], upload = ["enviar", doc]
  const file = await call(download, req(download), async (_url, { headers }) => {
    assert.equal(headers.authorization, "Bearer " + token)
    return new Response(pdf, { headers: { "content-type": "application/pdf", etag: `"2:1:${createHash("sha256").update(pdf).digest("hex")}"` } })
  })
  assert.equal(await file.text(), pdf)
  assert.match(file.headers.get("content-disposition"), /attachment/)
  const wrongFile = await call(download, req(download), async () => new Response(pdf, { headers: { "content-type": "application/pdf", etag: `"2:1:${hash}"` } }))
  assert.equal(wrongFile.status, 503)
  function body(bytes = pdf) {
    const form = new FormData()
    form.append("revision", "2:1:" + hash)
    form.append("file", new Blob([bytes], { type: "application/pdf" }), "contrato.pdf")
    return req(upload, { method: "POST", headers: { origin }, body: form })
  }
  let submitted = 0
  const accepted = await call(upload, body(), async (_url, init) => {
    submitted++
    assert.equal(init.headers["if-match"], `"2:1:${hash}"`)
    assert.equal(init.headers.authorization, "Bearer " + token)
    assert.equal(init.headers["content-type"], "application/pdf")
    assert.equal(await init.body.text(), pdf)
    return Response.json({ phase: "completed", revision: 3 })
  })
  assert.equal(submitted, 1)
  assert.match(await accepted.text(), /Todos os participantes concluíram/)
  const stale = await call(upload, body(), async () => new Response("", { status: 412 }))
  assert.equal(stale.status, 412)
  assert.match(await stale.text(), /baixe a versão atual/)
  assert.equal((await call(upload, body("other"))).status, 422)
  const oversized = req(upload, { method: "POST", headers: { origin, "content-type": "multipart/form-data; boundary=fixture", "content-length": String(34 * 1024 * 1024) }, body: "x" })
  assert.equal((await call(upload, oversized)).status, 413)
})

test("matcher do Next deixa o upload de até 32 MiB no handler que valida o host", async () => {
  const require = createRequire(import.meta.url)
  const { unstable_doesMiddlewareMatch: matches } = require("next/experimental/testing/server")
  const file = readFileSync(new URL("../src/proxy.ts", import.meta.url), "utf8")
  const matcher = JSON.parse(file.match(/matcher: (\[[^\n]+\]),/)[1])
  assert.equal(matches({ config: { matcher }, url: origin + base + "/enviar/" + doc }), false)
  assert.equal(matches({ config: { matcher }, url: origin + base }), true)
  assert.equal(matches({ config: { matcher }, url: origin + "/vendas" }), true)
  const response = await call(["enviar", doc], req(["enviar", doc], { method: "POST", headers: { host: "erp.avilaops.com", origin } }))
  assert.equal(response.status, 404)
})

test("navegador móvel conclui o envio pelo formulário HTML nativo", async () => {
  const { chromium } = createRequire(import.meta.url)("@playwright/test")
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true })
    await context.addCookies([{ name: "__Secure-avila_icp", value: token, url: origin + base, secure: true, httpOnly: true }])
    const page = await context.newPage()
    let uploads = 0
    let posted
    await page.route(origin + "/**", async intercepted => {
      const native = intercepted.request()
      const address = new URL(native.url())
      const actions = address.pathname.slice(base.length).split("/").filter(Boolean)
      const headers = await native.allHeaders()
      headers.host = address.host
      const request = new Request(native.url(), { method: native.method(), headers, ...(native.method() === "POST" ? { body: native.postDataBuffer() } : {}) })
      const response = await call(actions, request, async (_upstream, init) => {
        if (native.method() === "GET") return Response.json({ documents: [{ id: doc, filename: "Contrato de teste.pdf", position: 1, done: false,
          stageRevision: "4", headRevision: "1", parentSha256: hash }] })
        uploads++
        assert.equal(init.headers["if-match"], `"4:1:${hash}"`)
        assert.equal(await init.body.text(), pdf)
        return Response.json({ phase: "personal_signing", revision: 5 })
      })
      if (native.method() === "POST") posted = { status: response.status, origin: headers.origin, receivedBytes: native.postDataBuffer()?.length, declaredLength: headers["content-length"] }
      await intercepted.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
    })
    await page.goto(origin + base)
    await page.getByRole("heading", { name: "Documentos para assinar" }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.getByLabel("PDF assinado • até 32 MiB").setInputFiles({ name: "assinado.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf) })
    await Promise.all([page.waitForURL(origin + base + "/enviar/" + doc), page.getByRole("button", { name: "Enviar PDF para validação" }).click()])
    assert.equal(posted?.status, 200, JSON.stringify(posted))
    await page.getByRole("heading", { name: "Assinatura validada" }).waitFor({ timeout: 3000 })
    assert.equal(uploads, 1)
  } finally { await browser.close() }
})
