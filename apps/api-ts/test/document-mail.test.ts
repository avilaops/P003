import assert from "node:assert/strict"
import test from "node:test"
import { sendDocumentMail } from "../src/platform/document-mail.js"

test("document transport requires an explicit receipt with the same ID", async () => {
  const env = { ERP_DOCUMENT_MAIL_N8N_URL: "https://n8n.example.test/webhook/docs", ERP_DOCUMENT_MAIL_N8N_TOKEN: "x".repeat(40) }
  const mail = { id: "f".repeat(64), to: "one@example.test", subject: "Relatório", text: "Segue o arquivo.",
    attachments: [{ filename: "relatorio.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-test") }] }
  const accepted = await sendDocumentMail(mail, async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + env.ERP_DOCUMENT_MAIL_N8N_TOKEN)
    const wire = JSON.parse(String(init?.body))
    assert.equal(wire.attachments[0].content, mail.attachments[0]!.content.toString("base64"))
    return Response.json({ id: mail.id, status: "sent" })
  }, env)
  assert.equal(accepted, "sent")
  assert.equal(await sendDocumentMail(mail, async () => Response.json({ id: "other", status: "sent" }), env), "unknown")
  assert.equal(await sendDocumentMail(mail, async () => { throw new Error("disconnected") }, env), "unknown")
  assert.equal(await sendDocumentMail(mail, async () => Response.json({ id: mail.id, status: "failed" }, { status: 422 }), env), "failed")
})
