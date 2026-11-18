import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import Fastify from "fastify"
import type { Pool } from "pg"
import { openCpf } from "../src/modules/contract-signatures/identities.js"
import { registerQualifiedReissue } from "../src/modules/contract-signatures/reissue.js"
import { reissuePortal } from "../src/modules/contract-signatures/reissue-portal.js"
import type { DatabasePool } from "../src/platform/database.js"
import { Problem } from "../src/platform/problem.js"

export async function verifyQualifiedReissue(seed: Pool, pool: DatabasePool, tenant: string, roleId: string) {
  const source = randomUUID(), draft = randomUUID(), ver = randomUUID(), order = randomUUID(), digest = "a".repeat(64)
  const roles = [{ name: "Cliente", uuid: randomUUID() }, { name: "Testemunha", uuid: randomUUID() }]
  const recipients = roles.map((r, i) => ({ role: r.name, name: "Pessoa " + i, email: `person${i}@example.test` }))
  const template = { external_id: `avila:${ver}:${digest}`, submitters: roles, fields: [{ name: "termos", submitter_uuid: roles[0]!.uuid }] }
  const ring = { active: "a", keys: new Map([["a", randomBytes(32)]]) }
  await seed.query("INSERT INTO sales_orders(id,tenant_id,customer_id,customer_name,customer_tax_id,due_date,amount_cents,status) VALUES($1,$2,$2,'Cliente','52998224725','2027-01-01',10000,'draft')", [order, tenant])
  await seed.query("INSERT INTO commercial_template_drafts(tenant_id,id,definition,pdf) VALUES($1,$2,'{}',$3)", [tenant, draft, Buffer.from("%PDF-frozen")])
  await seed.query("INSERT INTO commercial_template_versions(tenant_id,id,draft_id,draft_revision,definition_json,pdf,request_hash,external_id,published_at) VALUES($1,$2,$3,1,'{}',$4,$5,8651,now())", [tenant, ver, draft, Buffer.from("%PDF-frozen"), digest])
  await seed.query(`INSERT INTO commercial_contracts(id,tenant_id,customer_id,order_id,template_id,template_name,template_snapshot,snapshot,recipients,fields,fingerprint,status)
    VALUES($1,$2,$2,$3,8651,'Versão',$4,'{}',$5,'{"termos":"originais"}',$6,'completed')`,
    [source, tenant, order, template, JSON.stringify(recipients), source])
  await seed.query("INSERT INTO role_permissions(role_id,permission_code) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING",
    [roleId, ["sales.orders.read", "sales.orders.manage", "sales.contracts.send"]])
  const headers = { authorization: "Bearer test", "x-tenant-id": tenant, "idempotency-key": randomUUID(), "if-match": '"1"' }
  const body = { participants: [{ role: "Cliente", cpf: "529.982.247-25" }, { role: "Testemunha", cpf: "11144477735" }] }
  let posts = 0
  const url = `/api/v1/commercial-contracts/${source}/qualified-reissue`
  const app = Fastify({ logger: false })
  app.setErrorHandler((e, _req, reply) => { const error = e as Problem; reply.code(error.status || 500).send({ code: error.code }) })
  const portal = reissuePortal({ DOCUSEAL_API_TOKEN: "synthetic-private-test-token" }, async (path, options) => {
    if (options?.method === "GET") { assert.equal(String(path), "https://contrato.avilaops.com/api/avila/templates/" + ver); return Response.json({ found: true, archived: false, id: 8651, requestHash: digest }) }
    posts++
    const request = JSON.parse(String(options?.body))
    assert.equal(request.send_email, false)
    assert(!String(options?.body).includes("52998224725"))
    const qualifiedId = request.submitters[0].external_id.split(":")[2]
    // A second connection sees all committed identities before a provider could dispatch anything.
    const saved = await seed.query(`SELECT p.* FROM contract_signature_participants p JOIN contract_signature_envelopes e
      ON (e.tenant_id,e.id)=(p.tenant_id,p.envelope_id) WHERE e.contract_id=$1 ORDER BY p.position`, [qualifiedId])
    assert.equal(saved.rowCount, 2)
    assert.equal(openCpf(ring, tenant, saved.rows[0].envelope_id, saved.rows[0].id, saved.rows[0]), "52998224725")
    assert.throws(() => openCpf(ring, tenant, saved.rows[0].envelope_id, saved.rows[1].id, saved.rows[0]))
    assert.deepEqual(request.submitters[0].fields, [{ name: "termos", default_value: "originais", readonly: true }])
    assert(request.submitters.every((s: Record<string, unknown>) => s.require_email_2fa === true && s.send_email === false &&
      s.completed_redirect_url === `https://contrato.avilaops.com/icp/${tenant}/${qualifiedId}`))
    return Response.json(request.submitters.map((s: Record<string, unknown>) => ({ ...s, submission_id: 244,
      preferences: { require_email_2fa: true, completed_redirect_url: s.completed_redirect_url } })))
  })
  registerQualifiedReissue(app, { pool, userinfoUrl: "https://auth.example.test", fetchAuth: async () => Response.json({ sub: "reader", email: "reader@example.test" }) },
    () => ({ portal, ring, trustSha256: "b".repeat(64) }))
  try {
    const send = (data = body, requestHeaders = headers) => app.inject({ method: "POST", url, headers: requestHeaders, payload: data })
    const unversioned = randomUUID()
    await seed.query(`INSERT INTO commercial_contracts(id,tenant_id,customer_id,order_id,template_id,template_name,template_snapshot,snapshot,recipients,fields,fingerprint,status)
      SELECT $2,tenant_id,customer_id,order_id,8652,'Modelo avulso',template_snapshot-'external_id',snapshot,recipients,fields,$3,status
      FROM commercial_contracts WHERE id=$1`, [source, unversioned, unversioned])
    const blocked = await app.inject({ method: "POST", url: url.replace(source, unversioned), headers, payload: body })
    assert.equal(blocked.statusCode, 409, blocked.body)
    assert.equal((await send({ participants: body.participants.slice(1) })).statusCode, 422)
    assert.equal((await send(body, { ...headers, "if-match": '"2"' })).statusCode, 412)
    assert.equal(posts, 0)
    const created = await Promise.all([send(), send()])
    for (const res of created) assert.equal(res.statusCode, 200, res.body)
    assert.equal(created[0].json().qualifiedId, created[1].json().qualifiedId)
    assert.equal(created.filter(res => res.json().portalConfirmed).length, 1)
    assert.equal(posts, 1)
    const changed = { participants: [...body.participants.slice(0, 1), { role: "Testemunha", cpf: "52998224725" }] }
    assert.equal((await send(changed)).statusCode, 409)
    const data = await seed.query("SELECT request::text,result::text FROM domain_commands WHERE command_key=$1", [headers["idempotency-key"]])
    assert(!JSON.stringify(data.rows).includes("52998224725"))
    assert.equal((await seed.query("SELECT signature_policy FROM commercial_contracts WHERE id=$1", [source])).rows[0].signature_policy, "legacy_docuseal")
    assert.equal((await app.inject({ method: "GET", url, headers })).json().qualifiedId, created[0].json().qualifiedId)
    assert.equal((await send(body, { ...headers, "x-tenant-id": randomUUID() })).statusCode, 403)
  } finally { await app.close() }
}
