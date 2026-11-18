import assert from "node:assert/strict"
import { createCipheriv, randomBytes } from "node:crypto"
import test from "node:test"
import nodemailer from "nodemailer"
import { renderDanfe, sha256 } from "../src/modules/nfe-email/danfe.js"
import { nfeMessage, resolveSender, smtpFailure } from "../src/modules/nfe-email/smtp.js"
import type { DatabaseClient } from "../src/platform/database.js"

const accessKey = "35261004252011000110550010000000011000000017"
const xml = Buffer.from("<nfeProc>ç</nfeProc>")
const pdf = Buffer.from("%PDF-1.7\nfixture")

test("the MIME envelope contains two intact attachments and labels homologation", async () => {
  const envelope = { id: "mock", recipient: "fiscal@example.test", number: "4", series: 1, environment: "homologation", accessKey, xml, pdf }
  const message = nfeMessage(envelope)
  assert.match(message.subject, /Homologação • sem valor fiscal/)
  assert.match(message.text, /Homologação • sem valor fiscal/)
  assert.doesNotMatch(nfeMessage({ ...envelope, environment: "production" }).subject, /Homologação/)
  const bytes = (await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({ ...message, from: "erp@example.test" })).message.toString()
  assert.match(bytes, /To: fiscal@example\.test/i)
  for (const attachment of message.attachments) {
    assert.ok(bytes.includes(attachment.filename))
    assert.ok(bytes.includes(attachment.content.toString("base64")))
  }
  assert.equal(smtpFailure({ command: "CONN", code: "ECONNECTION" }), "unknown")
  assert.equal(smtpFailure({ command: "DATA", responseCode: 554 }), "failed")
})

test("the renderer only accepts the matching XML, access key, environment and PDF digest", async () => {
  const request = { xml: xml.toString(), tenantId: "tenant", authorization: "Bearer test", environment: "homologation", accessKey }
  const headers = { "content-type": "application/pdf", "content-disposition": `attachment; filename="DANFE-${accessKey}.pdf"`,
    "x-nfe-environment": "2", "x-xml-sha256": sha256(xml), "x-pdf-sha256": sha256(pdf) }
  const response = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(url), "http://127.0.0.1:8080/api/v1/fiscal/danfe")
    assert.equal(new Headers(init?.headers).get("authorization"), request.authorization)
    return new Response(pdf, { headers })
  }
  assert.deepEqual(await renderDanfe(request, response, "http://127.0.0.1:8080"), pdf)
  headers["x-pdf-sha256"] = sha256("other")
  await assert.rejects(renderDanfe(request, response, "http://127.0.0.1:8080"), /gerar o DANFE/)
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
