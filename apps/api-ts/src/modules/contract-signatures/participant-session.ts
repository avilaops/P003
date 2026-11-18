import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { DatabaseClient, DatabasePool } from "../../platform/database.js"
import { Problem } from "../../platform/problem.js"
import { reissuePortal } from "./reissue-portal.js"

type Boundary = { tenantId: string; contractId: string }
type Participant = { envelope: string; participant: string; position: number; email: string; role: string; external: string; template: string }
const denied = () => new Problem(403, "participant_access_denied", "Abra o convite original, confirme seu e-mail no portal e aguarde sua vez de assinar.")
const unavailable = () => new Problem(503,"portal_unavailable","Não foi possível conferir a sessão no portal de contratos.")
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

async function scoped<T>(pool: DatabasePool, tenantId: string, fn: (client: DatabaseClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId])
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (error) { await client.query("ROLLBACK"); throw error }
  finally { client.release() }
}

async function activeParticipant(client: DatabaseClient, { tenantId,contractId }: Boundary) {
  const { rows } = await client.query<Participant>(`SELECT e.id AS envelope,p.id AS participant,p.position,p.email,p.role,
    c.external_id::text AS external,c.template_id::text AS template FROM commercial_contracts c
    JOIN contract_signature_envelopes e ON e.tenant_id=c.tenant_id AND e.contract_id=c.id
    JOIN contract_signature_states s ON s.tenant_id=e.tenant_id AND s.envelope_id=e.id
    JOIN contract_signature_participants p ON p.tenant_id=e.tenant_id AND p.envelope_id=e.id AND p.position=s.current_participant
    WHERE c.tenant_id=$1 AND c.id=$2 AND c.status='completed' AND s.phase='personal_signing' AND e.trust_profile='icp_brasil'`, [tenantId,contractId])
  if (!rows[0]) throw denied()
  return rows[0]
}

export async function openParticipantSession(pool: DatabasePool, boundary: Boundary, portalCookie: string | undefined, request = fetch) {
  if (!portalCookie || !/^email_2fa_slug=[^;\s\x00-\x1f]{1,4096}$/.test(portalCookie)) throw denied()
  const current = await scoped(pool, boundary.tenantId, client => activeParticipant(client,boundary))
  const origin = "https://contrato.avilaops.com"
  const submission = await reissuePortal(process.env,request).submission(current.external)
  const options = { redirect: "manual" as const, signal: AbortSignal.timeout(8000) }
  const correlation = `erp:${boundary.tenantId}:${boundary.contractId}:${current.position-1}`
  if (String(submission.id) !== current.external || String(submission.template.id) !== current.template || !submission.completed_at || submission.archived_at) throw denied()
  const person = submission.submitters.find(p => p.external_id === correlation)
  if (!person || person.email?.toLowerCase() !== current.email.toLowerCase() || person.role !== current.role || !person.completed_at ||
      person.preferences?.require_email_2fa !== true || !/^[a-z0-9_-]{6,100}$/i.test(person.slug)) throw denied()
  const path = "/s/" + person.slug
  const endpoint = origin + path + "/completed"
  const authenticated = { ...options,headers:{cookie:portalCookie} }
  const [anonymous, entry, completed] = await Promise.all([request(endpoint,options), request(origin+path,authenticated), request(endpoint,authenticated)]).catch(() => {throw unavailable()})
  await Promise.all([anonymous.body?.cancel(),entry.body?.cancel(),completed.body?.cancel()])
  function redirected(response: Response, to: string) {
    const location = response.headers.get("location")
    return [302,303].includes(response.status) && !!location && new URL(location,origin).href === to
  }
  if (!redirected(anonymous,origin+path) || !redirected(entry,endpoint) || completed.status !== 200) throw denied()
  const token = randomBytes(32).toString("base64url")
  const grant = randomUUID()
  await scoped(pool,boundary.tenantId,async client => {
    const now = await activeParticipant(client,boundary)
    if (now.participant !== current.participant || now.envelope !== current.envelope) throw denied()
    const args = [boundary.tenantId,current.envelope,grant,current.participant]
    await client.query(`INSERT INTO contract_signature_grants(tenant_id,envelope_id,id,participant_id,token_sha256,portal_assertion_sha256,created_at,expires_at,consumed_at)
      VALUES($1,$2,$3,$4,$5,$6,statement_timestamp(),statement_timestamp()+interval '1 minute',statement_timestamp())`,[...args,digest(randomBytes(32).toString("hex")),digest(JSON.stringify([correlation,person.id,person.completed_at,grant]))])
    await client.query(`INSERT INTO contract_signature_sessions(tenant_id,envelope_id,id,participant_id,grant_id,token_sha256,expires_at)
      VALUES($1,$2,$5,$4,$3,$6,now()+interval '15 minutes')`,[...args,randomUUID(),digest(token)])
  })
  return token
}

export function participantOperation(pool: DatabasePool, boundary: Boundary, authorization: string | undefined) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "")?.[1]
  if (!token) throw denied()
  return async <T>(action: (ctx: {tenantId:string;client:DatabaseClient}, identity:{envelopeId:string;participantId:string}) => Promise<T>, write = false) =>
    scoped(pool,boundary.tenantId,async client => {
      if (write) await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE",[boundary.tenantId])
      const session = (await client.query<{envelope: string; participant: string}>(`SELECT e.id AS envelope,ss.participant_id AS participant
        FROM contract_signature_sessions ss JOIN contract_signature_envelopes e ON e.tenant_id=ss.tenant_id AND e.id=ss.envelope_id
        JOIN contract_signature_grants g ON (g.tenant_id,g.envelope_id,g.id)=(ss.tenant_id,ss.envelope_id,ss.grant_id)
        JOIN contract_signature_states s ON s.tenant_id=e.tenant_id AND s.envelope_id=e.id
        JOIN contract_signature_participants p ON (p.tenant_id,p.envelope_id,p.id)=(ss.tenant_id,ss.envelope_id,ss.participant_id)
        WHERE ss.tenant_id=$1 AND e.contract_id=$2 AND ss.token_sha256=$3 AND ss.expires_at>clock_timestamp()
          AND ss.revoked_at IS NULL AND g.revoked_at IS NULL AND g.consumed_at IS NOT NULL
          AND s.phase='personal_signing' AND s.current_participant=p.position`,[boundary.tenantId,boundary.contractId,digest(token)])).rows[0]
      if (!session) throw denied()
      return action({tenantId:boundary.tenantId,client},{envelopeId:session.envelope,participantId:session.participant})
    })
}
