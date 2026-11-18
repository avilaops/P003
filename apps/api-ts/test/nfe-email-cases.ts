import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Pool } from "pg"
import { buildApp } from "../src/app.js"
import type { Envelope } from "../src/modules/nfe-email/smtp.js"
import type { DatabasePool } from "../src/platform/database.js"

export async function verifyNfeEmail(seed: Pool, pool: DatabasePool, tenant: string, other: string, role: string) {
  const id = randomUUID(), key = randomUUID()
  const email = "fiscal@example.test", accessKey = "35261004252011000110550010000000011000000017"
  const source = await readFile(new URL("../../api/tests/fixtures/nfe-protocol-synthetic.xml", import.meta.url), "utf8")
  const xml = source.replaceAll("19131243000197", "04252011000110")
  const pdf = Buffer.from("%PDF-mocked DANFE")
  await seed.query("INSERT INTO company_profiles(tenant_id,revision,details) VALUES($1,1,$2)", [tenant, { email }])
  await seed.query(`INSERT INTO fiscal_nfe_drafts(tenant_id,id,environment,model,profile_revision,company_revision,issuer_snapshot,details,products_total_cents)
    VALUES($1,$2,'homologation',55,1,1,'{}','{}',1)`, [tenant, id])
  await seed.query(`INSERT INTO fiscal_nfe_documents(tenant_id,id,status,series,number,issued_at,random_code,access_key,signed_xml,authorized_xml,protocol)
    VALUES($1,$2,'authorized',1,4,'2026-10-27T12:00:00-03:00','00000001',$3,'signed-only',$4,'135260000000000')`, [tenant, id, accessKey, xml])
  const intercepted: Envelope[] = []
  const app = buildApp({ pool, userinfoUrl: "http://auth.test/userinfo",
    fetchAuth: async () => Response.json({ sub: "reader", email: "reader@example.test" }),
    nfeEmail: {
      render: async ({ xml: actual, tenantId, authorization }) => {
        assert.equal(actual, xml); assert.equal(tenantId, tenant); assert.equal(authorization, "Bearer reader")
        return pdf
      },
      sender: async () => async envelope => { intercepted.push(envelope); return "sent" },
    },
  })
  try {
    const url = `/api/v1/fiscal/nfe/${id}/email`, headers = { authorization: "Bearer reader", "x-tenant-id": tenant }
    const get = () => app.inject({ method: "GET", url, headers })
    assert.equal((await get()).statusCode, 403)
    await seed.query("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'fiscal.nfe.issue')", [role])
    assert.equal((await app.inject({ method: "GET", url, headers: { ...headers, "x-tenant-id": other } })).statusCode, 403)
    let preview = await get()
    assert.equal(preview.statusCode, 200, preview.body)
    assert.equal(preview.json().recipientEmail, email)
    // A third-party document must never fall back to the issuer or another tenant's address.
    await seed.query("UPDATE fiscal_nfe_documents SET authorized_xml=$2 WHERE id=$1", [id, source])
    assert.equal((await get()).json().recipientEmail, null)
    await seed.query(`INSERT INTO parties(id,tenant_id,person_type,legal_name,tax_id,is_customer,is_supplier,status,email)
      VALUES($1,$2,'juridica','Destinatário','19131243000197',true,false,'active','local@example.test'),
      ($3,$4,'juridica','Outra empresa','19131243000197',true,false,'active','foreign@example.test')`, [randomUUID(), tenant, randomUUID(), other])
    assert.equal((await get()).json().recipientEmail, "local@example.test")
    await seed.query("UPDATE fiscal_nfe_documents SET authorized_xml=$2 WHERE id=$1", [id, xml])
    await seed.query("INSERT INTO platform_mail_settings(data,revision) VALUES($1,1)", [{ enabled: false }])
    const post = (tag: string, recipient = email, command = key) => app.inject({ method: "POST", url,
      headers: { ...headers, "if-match": tag, "idempotency-key": command }, payload: { recipientEmail: recipient } })
    preview = await get()
    assert.equal(preview.json().smtpConfigured, false)
    assert.equal((await post(String(preview.headers.etag))).statusCode, 503)
    await seed.query("UPDATE platform_mail_settings SET data=$1", [{ enabled: true }])
    preview = await get()
    const tag = String(preview.headers.etag)
    assert.equal((await post(tag, "another@example.test")).statusCode, 412)
    const [a,b] = await Promise.all([post(tag), post(tag)])
    for (const response of [a,b]) assert.ok([200,202].includes(response.statusCode), response.body)
    assert.equal((await post(tag)).json().status, "sent")
    assert.equal(intercepted.length, 1)
    const envelope = intercepted[0]!
    assert.equal(envelope.recipient, email); assert.equal(envelope.environment, "homologation")
    assert.deepEqual(envelope.pdf, pdf); assert.deepEqual(envelope.xml, Buffer.from(xml))
    assert.equal((await get()).json().status, "sent")
    assert.equal((await post(tag, email, randomUUID())).statusCode, 412)
    assert.equal((await post(tag, "another@example.test")).statusCode, 409)
    await seed.query("UPDATE fiscal_nfe_documents SET status='cancelled' WHERE tenant_id=$1 AND id=$2", [tenant, id])
    assert.equal((await get()).statusCode, 409)
  } finally {
    await app.close()
    await seed.query("DELETE FROM platform_mail_settings")
  }
}
