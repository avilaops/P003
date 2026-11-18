import { randomUUID } from "node:crypto"
import { Problem } from "../../platform/problem.js"
import { identityKeyring, openCpf, type FrozenIdentity } from "./identities.js"
import { ContractSignatureValidationError, contractSignatureValidatorFromEnv } from "./validator.js"
import { MIB, sha256 } from "./validator-wire.js"
import { claim, envelope, finishJob, insertEvidence, limit, missing, pin, quota, stale, status,
  type Envelope, type SigningDocument, type WorkflowContext, type WorkflowTransaction } from "./workflow-state.js"

export { preparePersonalSignatures } from "./workflow-preflight.js"
export type { SigningDocument, WorkflowContext, WorkflowStatus, WorkflowTransaction } from "./workflow-state.js"
export type SigningUpload = SigningDocument & { parentSha256: string; stageRevision: string; headRevision: string; content: Buffer }

async function head(ctx: WorkflowContext, env: Envelope, input: SigningDocument) {
  const row = (await ctx.client.query<{ base: Buffer; parent: Buffer; baseSha256: string; sha256: string; headRevision: string;
    sequence: number; filename: string }>(`SELECT d.content AS base,coalesce(r.content,d.content) AS parent,
    d.sha256 AS "baseSha256",h.sha256,h.revision::text AS "headRevision",h.sequence,d.filename
    FROM contract_signature_documents d JOIN contract_signature_heads h ON (h.tenant_id,h.envelope_id,h.document_id)=(d.tenant_id,d.envelope_id,d.id)
    JOIN contract_signature_participants p ON (p.tenant_id,p.envelope_id,p.id)=(d.tenant_id,d.envelope_id,$4::uuid)
    LEFT JOIN contract_signature_revisions r ON (r.tenant_id,r.envelope_id,r.document_id,r.id)=(h.tenant_id,h.envelope_id,h.document_id,h.revision_id)
    WHERE d.tenant_id=$1 AND d.envelope_id=$2 AND d.id=$3 AND h.preflight_evidence_id IS NOT NULL
      AND p.position=$5 AND h.sequence=p.position-1`, [ctx.tenantId,env.envelopeId,input.documentId,input.participantId,env.currentParticipant])).rows[0]
  if (!row || env.phase !== "personal_signing") throw stale()
  if (sha256(row.base) !== row.baseSha256 || sha256(row.parent) !== row.sha256) throw stale()
  return row
}

export async function readSigningDocument(ctx: WorkflowContext, input: SigningDocument) {
  const env = await envelope(ctx,input.envelopeId,"envelope",false)
  const row = await head(ctx,env,input)
  return { content: row.parent, filename: row.filename, sha256: row.sha256, headRevision: row.headRevision, stageRevision: env.revision }
}

// Discard the temporary job and the duplicate upload only after durable evidence and revision have been written,
// or after a rejected upload has served its seven-day quarantine. Immutable evidence is never deleted.
async function removeUpload(ctx: WorkflowContext, env: Envelope, id: string) {
  const args = [ctx.tenantId,env.envelopeId,id]
  await ctx.client.query(`DELETE FROM contract_signature_jobs WHERE tenant_id=$1 AND envelope_id=$2 AND upload_id=$3
    AND kind='increment' AND status IN ('completed','rejected')`, args)
  await ctx.client.query(`DELETE FROM contract_signature_uploads WHERE tenant_id=$1 AND envelope_id=$2 AND id=$3
    AND (status='accepted' OR (status IN ('rejected','expired') AND quarantine_until<=clock_timestamp()))`, args)
}

export async function cleanSignatureUploads(ctx: WorkflowContext, envelopeId: string) {
  const env = await envelope(ctx,envelopeId)
  const args = [ctx.tenantId,envelopeId]
  // A crashed request can reclaim its exact pending upload or lease. Obsolete work
  // is quarantined and releases its participant slot on subsequent access.
  const expired = await ctx.client.query<{ size: number }>(`WITH abandoned AS (
    UPDATE contract_signature_jobs j SET status='rejected',lease_token=NULL,lease_until=NULL
    FROM contract_signature_uploads u,contract_signature_heads h
    WHERE j.tenant_id=$1 AND j.envelope_id=$2 AND j.kind='increment'
      AND (u.tenant_id,u.envelope_id,u.id)=(j.tenant_id,j.envelope_id,j.upload_id)
      AND (h.tenant_id,h.envelope_id,h.document_id)=(u.tenant_id,u.envelope_id,u.document_id)
      AND (j.status='pending' OR j.status='leased' AND j.lease_until<=clock_timestamp())
      AND (u.expected_head_revision<>h.revision OR u.expected_stage_revision<>$3 OR u.created_at<clock_timestamp()-interval '1 hour')
    RETURNING u.id)
    UPDATE contract_signature_uploads u SET status='expired',problem_code='signature_upload_expired',
      quarantine_until=clock_timestamp()+interval '7 days' FROM abandoned a WHERE u.tenant_id=$1 AND u.envelope_id=$2
      AND u.id=a.id AND u.status IN ('pending','validating') RETURNING octet_length(u.content) AS size`, [...args,env.revision])
  const expiredBytes = expired.rows.reduce((sum,row) => sum + row.size,0)
  const old = await ctx.client.query<{ id: string; size: number }>(`SELECT id,octet_length(content) AS size FROM contract_signature_uploads
    WHERE tenant_id=$1 AND envelope_id=$2 AND status IN ('rejected','expired') AND quarantine_until<=clock_timestamp()`, args)
  for (const row of old.rows) await removeUpload(ctx,env,row.id)
  const cleanedBytes = old.rows.reduce((sum,row) => sum + row.size,0)
  if (expiredBytes || cleanedBytes) await ctx.client.query(`UPDATE contract_signature_states SET reserved_bytes=reserved_bytes-$3,
    stored_bytes=stored_bytes+$3-$4 WHERE tenant_id=$1 AND envelope_id=$2`, [...args,expiredBytes,cleanedBytes])
}

async function reserve(ctx: WorkflowContext, env: Envelope, input: SigningUpload, digest: string) {
  const args = [ctx.tenantId,env.envelopeId,input.participantId,input.documentId]
  const duplicate = await ctx.client.query(`SELECT id FROM contract_signature_revisions WHERE tenant_id=$1 AND envelope_id=$2
    AND participant_id=$3 AND document_id=$4 AND parent_sha256=$5 AND sha256=$6`, [...args,input.parentSha256,digest])
  if (duplicate.rows.length) return { done: status(env) }
  const row = await head(ctx,env,input)
  if (input.parentSha256 !== row.sha256 || input.headRevision !== row.headRevision || input.stageRevision !== env.revision) throw stale()
  if (input.content.length <= row.parent.length || !input.content.subarray(0,row.parent.length).equals(row.parent)) {
    throw new Problem(422,"invalid_signature_input","O PDF assinado precisa preservar a revisão baixada no portal")
  }
  const existing = (await ctx.client.query<{ upload: string; job: string }>(`SELECT u.id AS upload,j.id AS job
    FROM contract_signature_uploads u JOIN contract_signature_jobs j ON (j.tenant_id,j.envelope_id,j.upload_id)=(u.tenant_id,u.envelope_id,u.id)
    WHERE u.tenant_id=$1 AND u.envelope_id=$2 AND u.participant_id=$3 AND u.document_id=$4 AND u.sha256=$5
      AND u.parent_sha256=$6 AND u.expected_head_revision=$7 AND u.expected_stage_revision=$8 AND u.status IN ('pending','validating')`,
  [...args,digest,row.sha256,row.headRevision,env.revision])).rows[0]
  let upload = existing?.upload, job = existing?.job
  if (!upload || !job) {
    const count = (await ctx.client.query<{ count: number }>(`SELECT count(*)::int AS count FROM contract_signature_uploads
      WHERE tenant_id=$1 AND envelope_id=$2 AND participant_id=$3 AND status IN ('pending','validating')`, args.slice(0,3))).rows[0]!.count
    if (count >= 2) throw new Problem(429,"signature_pending_limit","O participante já tem dois arquivos em validação")
    const charged = await ctx.client.query(`UPDATE contract_signature_states SET reserved_bytes=reserved_bytes+$3
      WHERE tenant_id=$1 AND envelope_id=$2 AND stored_bytes+reserved_bytes+$3<=$4 RETURNING envelope_id`,
    [ctx.tenantId,env.envelopeId,input.content.length,limit])
    if (!charged.rows.length) throw quota()
    upload = randomUUID()
    job = randomUUID()
    await ctx.client.query(`INSERT INTO contract_signature_uploads(tenant_id,envelope_id,participant_id,document_id,id,
      parent_sha256,expected_head_revision,expected_stage_revision,sha256,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [...args,upload,row.sha256,row.headRevision,env.revision,digest,input.content])
    await ctx.client.query(`INSERT INTO contract_signature_jobs(tenant_id,envelope_id,document_id,upload_id,id,kind)
      VALUES($1,$2,$3,$4,$5,'increment')`, [ctx.tenantId,env.envelopeId,input.documentId,upload,job])
  }
  const token = await claim(ctx,env,job)
  await ctx.client.query("UPDATE contract_signature_uploads SET status='validating' WHERE tenant_id=$1 AND envelope_id=$2 AND id=$3",
    [ctx.tenantId,env.envelopeId,upload])
  const encrypted = await ctx.client.query<FrozenIdentity & { id: string; position: number }>(`SELECT id,position,
    identity_key_id,identity_nonce,identity_ciphertext FROM contract_signature_participants WHERE tenant_id=$1 AND envelope_id=$2
    AND position<=$3 ORDER BY position`, [ctx.tenantId,env.envelopeId,env.currentParticipant])
  if (encrypted.rows.length !== env.currentParticipant || encrypted.rows.at(-1)?.id !== input.participantId
    || encrypted.rows.some((p,i) => p.position !== i+1)) throw missing()
  return { row,job,upload,token,encrypted: encrypted.rows,tenantId: ctx.tenantId }
}

export async function uploadSigningDocument(tx: WorkflowTransaction, input: SigningUpload, validator = contractSignatureValidatorFromEnv(),
  ring = identityKeyring()) {
  if (!Buffer.isBuffer(input.content) || input.content.length < 5 || input.content.length > 32*MIB
    || !input.content.subarray(0,5).equals(Buffer.from("%PDF-"))) throw new Problem(422,"invalid_signature_pdf","Envie o PDF assinado de até 32 MiB")
  const digest = sha256(input.content)
  const { envelopeId,documentId,participantId } = input
  const work = await tx(async ctx => {
    const env = await envelope(ctx,envelopeId)
    pin(env,validator)
    await cleanSignatureUploads(ctx,envelopeId)
    return reserve(ctx,env,input,digest)
  }, true)
  if (work.done) return work.done
  const { row,job,upload,token,tenantId } = work
  async function settleFailure(rejected: boolean, code: string | null) {
    await tx(async ctx => {
      await envelope(ctx,envelopeId)
      const owned = await ctx.client.query(`UPDATE contract_signature_jobs SET status=$5,lease_until=NULL,lease_token=NULL
        WHERE tenant_id=$1 AND envelope_id=$2 AND id=$3 AND lease_token=$4 AND status='leased'
          AND lease_until>clock_timestamp() RETURNING id`, [tenantId,envelopeId,job,token,rejected ? "rejected" : "pending"])
      if (!owned.rows.length) return
      await ctx.client.query(`UPDATE contract_signature_uploads SET status=$4,problem_code=$5,
        quarantine_until=CASE WHEN $4='rejected' THEN clock_timestamp()+interval '7 days' END
        WHERE tenant_id=$1 AND envelope_id=$2 AND id=$3`, [tenantId,envelopeId,upload,rejected ? "rejected" : "pending",code])
      if (rejected) await ctx.client.query(`UPDATE contract_signature_states SET reserved_bytes=reserved_bytes-$3,
        stored_bytes=stored_bytes+$3 WHERE tenant_id=$1 AND envelope_id=$2`, [tenantId,envelopeId,input.content.length])
    }, true)
  }
  let receipt
  try {
    const people = work.encrypted.map(p => ({ participantId:p.id,expectedCpf:openCpf(ring,tenantId,envelopeId,p.id,p) }))
    receipt = await validator.increment({ tenantId,envelopeId,documentId },row.base,row.parent,input.content,people.at(-1)!,people.slice(0,-1))
  } catch (error) {
    const rejected = error instanceof ContractSignatureValidationError && error.statusCode === 422
    await settleFailure(rejected,rejected ? error.code : null)
    throw error
  }
  const proof = receipt
  return tx(async ctx => {
    const env = await envelope(ctx,envelopeId)
    if (env.phase !== "personal_signing" || env.revision !== input.stageRevision) throw stale()
    await finishJob(ctx,env,job,token,"completed")
    const expectedHead = await ctx.client.query(`SELECT 1 FROM contract_signature_heads WHERE tenant_id=$1 AND envelope_id=$2
      AND document_id=$3 AND sequence=$4 AND sha256=$5 AND revision=$6`,
    [tenantId,envelopeId,documentId,row.sequence,row.sha256,input.headRevision])
    if (!expectedHead.rows.length) throw stale()
    const evidenceId = await insertEvidence(ctx,env,documentId,participantId,row.baseSha256,row.sha256,digest,proof)
    const revisionId = randomUUID()
    const next = row.sequence+1
    if (env.currentParticipant !== next) throw stale()
    await ctx.client.query(`INSERT INTO contract_signature_revisions(tenant_id,envelope_id,document_id,id,sequence,participant_id,
      base_sha256,parent_sequence,parent_sha256,sha256,content,evidence_id)
      SELECT tenant_id,envelope_id,document_id,$4,$5,participant_id,$6,$7,parent_sha256,sha256,content,$8
      FROM contract_signature_uploads WHERE tenant_id=$1 AND envelope_id=$2 AND id=$3 AND status='validating'`,
    [tenantId,envelopeId,upload,revisionId,next,row.baseSha256,row.sequence || null,evidenceId])
    const changed = await ctx.client.query(`UPDATE contract_signature_heads SET revision_id=$4,sequence=$5,sha256=$6,revision=revision+1
      WHERE tenant_id=$1 AND envelope_id=$2 AND document_id=$3 AND sequence=$7 AND sha256=$8 AND revision=$9 RETURNING document_id`,
    [tenantId,envelopeId,documentId,revisionId,next,digest,row.sequence,row.sha256,input.headRevision])
    if (!changed.rows.length) throw stale()
    const accepted = (await ctx.client.query<{ count: number }>(`SELECT count(*)::int AS count FROM contract_signature_heads
      WHERE tenant_id=$1 AND envelope_id=$2 AND sequence=$3 AND preflight_evidence_id IS NOT NULL`, [tenantId,envelopeId,next])).rows[0]!.count
    const advance = accepted === env.documentCount
    const completed = advance && next === env.people
    const charged = await ctx.client.query(`UPDATE contract_signature_states SET reserved_bytes=reserved_bytes-$3,
      stored_bytes=stored_bytes+$3+$4,updated_at=clock_timestamp(),revision=revision+CASE WHEN $5 THEN 1 ELSE 0 END,
      current_participant=CASE WHEN $5 AND NOT $6 THEN current_participant+1 ELSE current_participant END,
      phase=CASE WHEN $6 THEN 'completed' ELSE phase END,completed_at=CASE WHEN $6 THEN clock_timestamp() END
      WHERE tenant_id=$1 AND envelope_id=$2 AND stored_bytes+reserved_bytes+$4<=$7 RETURNING envelope_id`,
    [tenantId,envelopeId,input.content.length,proof.bundle.length,advance,completed,limit])
    if (!charged.rows.length) throw quota()
    await ctx.client.query("UPDATE contract_signature_uploads SET status='accepted' WHERE tenant_id=$1 AND envelope_id=$2 AND id=$3",
      [tenantId,envelopeId,upload])
    await removeUpload(ctx,env,upload)
    return status(await envelope(ctx,envelopeId,"envelope",false))
  }, true).catch(async (error: unknown) => {
    if (error instanceof Problem && ["signature_stage_changed","signature_storage_limit","signature_configuration_changed"].includes(error.code)) {
      await settleFailure(true,error.code)
    }
    throw error
  })
}
