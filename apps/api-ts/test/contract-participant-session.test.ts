import { randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import test from "node:test"
import { openParticipantSession } from "../src/modules/contract-signatures/participant-session.js"
import type { DatabaseClient, DatabasePool } from "../src/platform/database.js"

test("o titular só recebe sessão quando o próprio portal confirma seu segundo fator e o contrato correto", async () => {
  const tenantId = randomUUID(), contractId = randomUUID(), participant = randomUUID(), envelope = randomUUID()
  let grantCount = 0, sessionCount = 0
  const client: DatabaseClient = {
    async query<T>(sql: string) {
      if (sql.includes("INSERT INTO contract_signature_grants")) grantCount++
      if (sql.includes("INSERT INTO contract_signature_sessions")) sessionCount++
      return {rows:sql.includes("e.id AS envelope") ? [{envelope,participant,position:1,email:"cliente@example.test",role:"Cliente",external:"42",template:"7"} as T] : []}
    }, release() {}
  }
  const pool: DatabasePool = {connect:async () => client}
  const boundary = {tenantId,contractId}
  const saved = process.env.DOCUSEAL_API_TOKEN
  process.env.DOCUSEAL_API_TOKEN = "synthetic-local-account-token"
  const origin = "https://contrato.avilaops.com", slug = "test-participant"
  const person = { id:7,slug,role:"Cliente",email:"cliente@example.test",completed_at:"2026-11-18",external_id:`erp:${tenantId}:${contractId}:0`,preferences:{require_email_2fa:true} }
  let publicCompletion = false, locked = false
  const http: typeof fetch = async (url,init) => {
    const path = new URL(String(url)).pathname, headers = new Headers(init?.headers)
    assert.equal(init?.redirect === "error" || init?.redirect === "manual",true)
    if (path === "/api/submissions/42") {
      assert.equal(headers.get("cookie"),null)
      return Response.json({id:42,template:{id:7},completed_at:"2026-11-18",submitters:[person]})
    }
    assert.equal(headers.get("X-Auth-Token"),null)
    const authenticated = headers.get("cookie") === "email_2fa_slug=valid-test-cookie"
    if (path === "/s/" + slug) return authenticated && !locked ? Response.redirect(origin + path + "/completed",302) : new Response()
    assert.equal(path,"/s/" + slug + "/completed")
    return publicCompletion || authenticated ? new Response() : Response.redirect(origin + "/s/" + slug,302)
  }
  const open = (cookie = "email_2fa_slug=valid-test-cookie") => openParticipantSession(pool,boundary,cookie,http)
  try {
    await assert.rejects(open("email_2fa_slug=wrong-cookie"))
    publicCompletion = true; await assert.rejects(open()); publicCompletion = false
    locked = true; await assert.rejects(open()); locked = false
    person.preferences.require_email_2fa = false; await assert.rejects(open()); person.preferences.require_email_2fa = true
    person.external_id += "x"; await assert.rejects(open()); person.external_id = person.external_id.slice(0,-1)
    assert.deepEqual([grantCount,sessionCount],[0,0])
    assert.match(await open(),/^[A-Za-z0-9_-]{43}$/)
    assert.deepEqual([grantCount,sessionCount],[1,1])
  } finally {
    if (saved === undefined) delete process.env.DOCUSEAL_API_TOKEN
    else process.env.DOCUSEAL_API_TOKEN = saved
  }
})
