import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { Pool } from "pg"
import { buildApp } from "../src/app.js"
import type { DatabasePool } from "../src/platform/database.js"
import type { DocumentMail } from "../src/platform/document-mail.js"

export async function verifySalesMail(seed: Pool, pool: DatabasePool, tenant: string, role: string, order: string, proposal: string) {
  const mails: DocumentMail[] = []
  const app = buildApp({ pool, userinfoUrl: "http://auth.test/userinfo", fetchAuth: async () => Response.json({ sub: "reader", email: "reader@example.test" }),
    documentCopies: { configured: () => true, send: async mail => { mails.push(mail); return "sent" } } })
  const headers = { authorization: "Bearer reader", "x-tenant-id": tenant }
  try {
    for (const [kind,id] of [["order",order],["proposal",proposal]] as const) {
      const url = `/api/v1/${kind}s/${id}/email`
      const get = () => app.inject({ method: "GET", url, headers })
      const getInitial = await get()
      assert.equal(getInitial.statusCode, 200, getInitial.body)
      const count = mails.length
      const key = randomUUID()
      const permission = `sales.${kind}s.manage`
      await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2) ON CONFLICT DO NOTHING", [role,permission])
      assert.equal((await get()).json().canSend, true)
      const post = (revision = '"1"', subject = "Documento") => app.inject({ method: "POST", url, headers: { ...headers, "if-match": revision, "idempotency-key": key },
        payload: { recipient: "vendas@example.test", message: "Segue o documento.", subject } })
      assert.equal((await post('"99"')).statusCode, 412)
      const result = await post()
      assert.equal(result.statusCode, 200, result.body)
      assert.equal(result.json().delivery.status, "sent")
      assert.equal(result.json().revision, kind === "proposal" ? 2 : 1)
      assert.equal((await post()).json().delivery.id, result.json().delivery.id)
      assert.equal((await post('"1"', "Outro")).statusCode, 409)
      assert.equal((await get()).json().deliveries[0].id, result.json().delivery.id)
      assert.equal(mails.length, count + 1)
      const file = mails[count]!.attachments[0]!
      if (kind === "order") assert.equal(file.content.subarray(0,5).toString(), "%PDF-")
      else assert.match(file.content.toString(), /Cliente/)
    }
  } finally { await app.close() }
}
