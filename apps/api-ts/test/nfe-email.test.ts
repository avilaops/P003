import assert from "node:assert/strict"
import { createCipheriv, randomBytes, randomUUID } from "node:crypto"
import test from "node:test"
import nodemailer from "nodemailer"
import { renderDanfe, sha256 } from "../src/modules/nfe-email/danfe.js"
import { nfeMessage, resolveSender, smtpFailure } from "../src/modules/nfe-email/smtp.js"
import type { DatabaseClient } from "../src/platform/database.js"

const accessKey = "35261004252011000110550010000000011000000017"
const xml = Buffer.from("<nfeProc>ç</nfeProc>")
const pdf = Buffer.from("%PDF-1.7\nfixture")
const envelope = { id: randomUUID(), company: "Ótica & Cia.", recipient: "fiscal@example.test", number: "4", series: 1,
  environment: "homologation", accessKey, xml, pdf }

test("the MIME envelope contains both message formats and two intact attachments", async () => {
  const message = nfeMessage(envelope)
  assert.match(message.subject, /NF-e nº 4 • Série 1 • Homologação • sem valor fiscal • Ótica & Cia\./)
  assert.match(message.text, /Homologação • sem valor fiscal/)
  assert.match(message.html, /<strong>Homologação • sem valor fiscal<\/strong>/)
  assert.match(message.html, /Ótica &amp; Cia\./)
  assert.match(message.text, /DANFE em PDF/)
  assert.doesNotMatch(nfeMessage({ ...envelope, environment: "production" }).subject, /Homologação/)
  const bytes = (await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({ ...message, from: "erp@example.test" })).message.toString()
  assert.match(bytes, /To: fiscal@example\.test/i)
  assert.match(bytes, /Content-Type: multipart\/alternative/i)
  assert.match(bytes, /Content-Type: text\/plain/i)
  assert.match(bytes, /Content-Type: text\/html/i)
  for (const attachment of message.attachments) {
    assert.ok(bytes.includes(attachment.filename))
    assert.ok(bytes.includes(attachment.content.toString("base64")))
  }
  assert.equal(smtpFailure({ command: "CONN", code: "ECONNECTION" }), "unknown")
  assert.equal(smtpFailure({ command: "DATA", responseCode: 554 }), "failed")
})

test("XML-only fiscal messages identify the parties, reference, key and real files", () => {
  for (const [kind, title, description] of [
    ["nfce", "NFC-e nº 4 • Série 1", "XML autorizado da nota fiscal de consumidor"],
    ["outgoing-nfses", "NFS-e emitida nº 4", "serviço que prestamos"],
    ["received-nfses", "NFS-e recebida nº 4", "tomadora do serviço"],
  ] as const) {
    const key = kind === "nfce" ? accessKey.replace("55001", "65001") : "7".repeat(50)
    const message = nfeMessage({ ...envelope, kind, environment: "production", pdf: null, accessKey: key,
      recipientName: "Maria & Filhos", providerName: "Prestador <Sul>" })
    assert.deepEqual(message.to, { name: "Maria & Filhos", address: envelope.recipient })
    assert.ok(message.text.includes("Olá, Maria & Filhos."))
    assert.ok(message.html.includes("Olá, Maria &amp; Filhos."))
    assert.equal(message.attachments.length, 1)
    for (const body of [message.text, message.html]) {
      for (const fragment of [title, description, key, message.attachments[0]!.filename]) assert.ok(body.includes(fragment))
      assert.doesNotMatch(body, /DANFE|Homologação/i)
    }
    if (kind === "received-nfses") {
      assert.match(message.html, /Prestador &lt;Sul&gt;/)
      assert.match(message.text, /XML original importado/)
    } else assert.doesNotMatch(message.text, /Prestador/)
  }
  const unnamed = nfeMessage({ ...envelope, recipientName: "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL" })
  assert.equal(unnamed.to.name, "")
  assert.doesNotMatch(unnamed.text, /Olá, NF-E/)
})

test("n8n receives the same fiscal HTML, text and attachments as Node SMTP", async () => {
  const client: DatabaseClient = { async query() { throw new Error("Unexpected database call") }, release() {} }
  const env = { ERP_DOCUMENT_MAIL_N8N_TOKEN: "x".repeat(32), ERP_DOCUMENT_MAIL_N8N_URL: "https://mock.example.test/mail" }
  let calls = 0
  const sender = await resolveSender(client, env, async (_, options) => {
    calls++
    const payload = JSON.parse(String(options?.body))
    const message = nfeMessage(envelope)
    assert.equal(payload.html, message.html)
    assert.equal(payload.text, message.text)
    assert.equal(payload.subject, message.subject)
    assert.equal(payload.to, envelope.recipient)
    assert.deepEqual(payload.attachments, message.attachments.map(a => ({ ...a, content: a.content.toString("base64") })))
    return Response.json({ id: envelope.id, status: "sent" })
  })
  assert.equal(await sender(envelope), "sent")
  assert.equal(calls, 1)
})

test("the renderer only accepts the matching XML, access key, environment and PDF digest", async () => {
  const request = { xml: xml.toString(), issuerTaxId: "04252011000110", environment: "homologation", accessKey }
  const token = "private-engine-test-credential"
  const headers = { "content-type": "application/pdf", "content-disposition": `attachment; filename="DANFE-${accessKey}.pdf"`,
    "x-nfe-environment": "2", "x-xml-sha256": sha256(xml), "x-pdf-sha256": sha256(pdf) }
  const response = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(url), "http://127.0.0.1:8091/v1/danfe")
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + token)
    assert.deepEqual(JSON.parse(String(init?.body)),request)
    return new Response(pdf, { headers })
  }
  assert.deepEqual(await renderDanfe(request, response, "http://127.0.0.1:8091", token), pdf)
  headers["x-pdf-sha256"] = sha256("other")
  await assert.rejects(renderDanfe(request, response, "http://127.0.0.1:8091", token), /gerar o DANFE/)
})

test("SMTP opens the platform AES-GCM secret with bound settings and honors explicit disable", async () => {
  const data = { enabled: true, host: "smtp.example.test", port: 587, username: "erp", security: "starttls", fromName: "ERP", fromAddress: "erp@example.test" }
  const aad = JSON.stringify(["platform.smtp.v1", data.host, data.port, data.security, data.username])
  const key = randomBytes(32), nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from(aad))
  const secret = Buffer.concat([cipher.update("test-password"), cipher.final(), cipher.getAuthTag()])
  const row = { data, secret_context: aad, secret_key_id: "test", secret_nonce: nonce, secret_ciphertext: secret }
  const client: DatabaseClient = { async query<T extends Record<string, unknown>>() { return { rows: [row] as unknown as T[] } }, release() {} }
  const env = { FISCAL_A1_KEYRING: JSON.stringify({ active: "test", keys: { test: key.toString("base64") } }) }
  assert.equal(typeof await resolveSender(client, env), "function")
  data.username = "changed"
  await assert.rejects(resolveSender(client, env), /Configure o SMTP/)
  data.enabled = false
  await assert.rejects(resolveSender(client, { ...env, SMTP_HOST: "unused", SMTP_PASSWORD: "unused", SMTP_USERNAME: "unused", SMTP_FROM: "unused@example.test" }), /Configure o SMTP/)
})
