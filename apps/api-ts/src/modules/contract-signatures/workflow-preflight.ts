import { Problem } from "../../platform/problem.js"
import { ContractSignatureValidationError, contractSignatureValidatorFromEnv } from "./validator.js"
import { busy, claim, envelope, finishJob, insertEvidence, limit, pin, quota, stale, status,
  type Envelope, type WorkflowContext, type WorkflowTransaction } from "./workflow-state.js"

const sourceUnavailable = () => new Problem(409, "signature_source_pending", "A conclusão do DocuSeal, os participantes e os PDFs precisam estar confirmados")

async function freeze(ctx: WorkflowContext, env: Envelope) {
  const args = [ctx.tenantId,env.envelopeId,env.contractId]
  // Synchronisation commits provider completion and all ordered files together.
  const source = (await ctx.client.query<{ count: number; total: string; valid: boolean }>(`
    SELECT count(f.id)::int AS count,coalesce(sum(octet_length(f.content)),0)::text AS total,
      count(f.id)>0 AND min(f.position)=0 AND max(f.position)=count(f.id)-1
      AND bool_and(f.sha256=encode(sha256(f.content),'hex') AND substring(f.content from 1 for 5)='\\x255044462d'::bytea) AS valid
    FROM commercial_contracts c JOIN commercial_contract_files f ON (f.tenant_id,f.contract_id)=(c.tenant_id,c.id) AND f.kind='signed'
    WHERE c.tenant_id=$1 AND c.id=$3 AND c.signature_policy='icp_each_participant' AND c.status='completed'
      AND c.completed_at IS NOT NULL AND c.external_id IS NOT NULL
      AND jsonb_array_length(c.recipients)=$4 AND jsonb_array_length(c.progress)=$4
      AND $4=(SELECT count(*) FROM contract_signature_participants p WHERE p.tenant_id=$1 AND p.envelope_id=$2
        AND p.name=c.recipients->(p.position-1)->>'name' AND p.role=c.recipients->(p.position-1)->>'role'
        AND p.email=c.recipients->(p.position-1)->>'email'
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.progress) x WHERE x->>'role'=p.role
          AND lower(x->>'email')=lower(p.email) AND x->>'completedAt' IS NOT NULL))`, [...args,env.people])).rows[0]
  if (!source?.valid || source.count < 1 || source.count > 10) throw sourceUnavailable()
  if (env.phase !== "portal_pending") {
    const different = await ctx.client.query(`SELECT f.id FROM commercial_contract_files f
      LEFT JOIN contract_signature_documents d ON (d.tenant_id,d.envelope_id,d.provider_document_id,d.sha256,d.position)=
        (f.tenant_id,$2::uuid,f.id::text,f.sha256,f.position+1)
      WHERE f.tenant_id=$1 AND f.contract_id=$3 AND f.kind='signed' AND d.id IS NULL LIMIT 1`, args)
    if (env.documentCount !== source.count || different.rows.length) throw sourceUnavailable()
    return
  }
  // The provider file UUID is the immutable local reference for this exact DocuSeal rendition.
  await ctx.client.query(`INSERT INTO contract_signature_documents(tenant_id,envelope_id,id,position,provider_document_id,filename,sha256,content)
    SELECT tenant_id,$2,id,position+1,id::text,'contrato-'||(position+1)||'.pdf',sha256,content FROM commercial_contract_files
    WHERE tenant_id=$1 AND contract_id=$3 AND kind='signed'`, args)
  await ctx.client.query(`INSERT INTO contract_signature_heads(tenant_id,envelope_id,document_id,base_sha256,sha256)
    SELECT tenant_id,envelope_id,id,sha256,sha256 FROM contract_signature_documents WHERE tenant_id=$1 AND envelope_id=$2`, args.slice(0,2))
  await ctx.client.query(`INSERT INTO contract_signature_jobs(tenant_id,envelope_id,id,document_id,kind)
    SELECT tenant_id,envelope_id,gen_random_uuid(),id,'preflight' FROM contract_signature_documents WHERE tenant_id=$1 AND envelope_id=$2`, args.slice(0,2))
  await ctx.client.query(`UPDATE contract_signature_states SET phase='preflight_pending',documents_frozen_at=clock_timestamp(),
    document_count=$3,stored_bytes=$4,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND envelope_id=$2`,
  [ctx.tenantId,env.envelopeId,source.count,source.total])
}

export async function preparePersonalSignatures(tx: WorkflowTransaction, contractId: string, validator = contractSignatureValidatorFromEnv()) {
  const envelopeId = await tx(async ctx => {
    const env = await envelope(ctx,contractId,"contract")
    pin(env,validator)
    if (env.phase === "blocked") throw sourceUnavailable()
    await freeze(ctx,env)
    return env.envelopeId
  }, true)
  for (let i = 0; i < 10; i++) {
    const work = await tx(async ctx => {
      const env = await envelope(ctx,envelopeId)
      if (env.phase !== "preflight_pending") return { done: status(env) }
      const result = (await ctx.client.query<{ id: string; documentId: string; base: Buffer; sha256: string }>(`
        SELECT j.id,d.id AS "documentId",d.content AS base,d.sha256 FROM contract_signature_jobs j
        JOIN contract_signature_documents d ON (d.tenant_id,d.envelope_id,d.id)=(j.tenant_id,j.envelope_id,j.document_id)
        WHERE j.tenant_id=$1 AND j.envelope_id=$2 AND j.kind='preflight'
          AND (j.status='pending' OR j.status='leased' AND j.lease_until<=clock_timestamp()) ORDER BY d.position LIMIT 1`,
      [ctx.tenantId,envelopeId])).rows[0]
      if (!result) throw busy()
      return { result, token: await claim(ctx,env,result.id), tenantId: ctx.tenantId }
    }, true)
    if (work.done) return work.done
    const { result,token,tenantId } = work
    let proof
    try { proof = await validator.preflight({ tenantId,envelopeId,documentId: result.documentId },result.base) }
    catch (error) {
      await tx(async ctx => {
        const env = await envelope(ctx,envelopeId)
        const rejected = error instanceof ContractSignatureValidationError && error.statusCode === 422
        await finishJob(ctx,env,result.id,token,rejected ? "rejected" : "pending")
        if (rejected) await ctx.client.query(`UPDATE contract_signature_states SET phase='blocked',revision=revision+1,
          problem_code='preflight_rejected',updated_at=clock_timestamp() WHERE tenant_id=$1 AND envelope_id=$2 AND phase='preflight_pending'`, [tenantId,envelopeId])
      }, true)
      throw error
    }
    const receipt = proof
    const updated = await tx(async ctx => {
      const env = await envelope(ctx,envelopeId)
      if (env.phase !== "preflight_pending") throw stale()
      await finishJob(ctx,env,result.id,token,"completed")
      const evidenceId = await insertEvidence(ctx,env,result.documentId,null,result.sha256,result.sha256,result.sha256,receipt)
      const head = await ctx.client.query(`UPDATE contract_signature_heads SET preflight_evidence_id=$4,revision=revision+1
        WHERE tenant_id=$1 AND envelope_id=$2 AND document_id=$3 AND preflight_evidence_id IS NULL AND sequence=0 RETURNING document_id`,
      [tenantId,envelopeId,result.documentId,evidenceId])
      if (!head.rows.length) throw stale()
      const completed = (await ctx.client.query(`SELECT 1 FROM contract_signature_heads
        WHERE tenant_id=$1 AND envelope_id=$2 AND preflight_evidence_id IS NULL LIMIT 1`, [tenantId,envelopeId])).rows.length === 0
      const changed = await ctx.client.query(`UPDATE contract_signature_states SET stored_bytes=stored_bytes+$3,updated_at=clock_timestamp(),
        phase=CASE WHEN $4 THEN 'personal_signing' ELSE phase END,revision=revision+1
        WHERE tenant_id=$1 AND envelope_id=$2 AND stored_bytes+reserved_bytes+$3<=$5 RETURNING envelope_id`,
      [tenantId,envelopeId,receipt.bundle.length,completed,limit])
      if (!changed.rows.length) throw quota()
      return status(await envelope(ctx,envelopeId,"envelope",false))
    }, true)
    if (updated.phase !== "preflight_pending") return updated
  }
  throw busy()
}
