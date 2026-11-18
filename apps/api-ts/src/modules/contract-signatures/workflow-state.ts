import { randomUUID } from "node:crypto"
import type { DatabaseClient } from "../../platform/database.js"
import { Problem } from "../../platform/problem.js"
import type { ContractSignatureValidator, ValidatorReceipt } from "./validator.js"
import { sha256 } from "./validator-wire.js"

export type WorkflowContext = { client: DatabaseClient; tenantId: string }
export type WorkflowTransaction = <T>(action: (ctx: WorkflowContext) => Promise<T>, write?: boolean) => Promise<T>
export type SigningDocument = { envelopeId: string; participantId: string; documentId: string }
export type WorkflowStatus = { phase: string; currentParticipant: number; documentCount: number; revision: string }
export type Envelope = WorkflowStatus & { envelopeId: string; contractId: string; policy: string; trust: string; people: number }
export const stale = () => new Problem(409, "signature_stage_changed", "A etapa ou a versão do documento mudou. Atualize o portal")
export const quota = () => new Problem(413, "signature_storage_limit", "O envelope atingiu o limite de armazenamento")
export const busy = () => new Problem(409, "signature_validation_pending", "A validação deste documento está em andamento")
export const missing = () => new Problem(404, "signature_not_found", "Fluxo de assinatura não encontrado")
export const mismatch = () => new Problem(503, "signature_configuration_changed", "A política ou as raízes do validador diferem das fixadas no envelope")
export const limit = 1024 ** 3

export async function envelope(ctx: WorkflowContext, id: string, by: "contract" | "envelope" = "envelope", lock = true) {
  const row = (await ctx.client.query<Envelope>(`SELECT e.id AS "envelopeId",e.contract_id AS "contractId",
    e.policy_sha256 AS policy,e.trust_bundle_sha256 AS trust,e.participant_count AS people,
    s.phase,s.current_participant AS "currentParticipant",s.document_count AS "documentCount",s.revision::text
    FROM contract_signature_envelopes e JOIN contract_signature_states s ON (s.tenant_id,s.envelope_id)=(e.tenant_id,e.id)
    WHERE e.tenant_id=$1 AND ${by === "contract" ? "e.contract_id" : "e.id"}=$2 AND e.trust_profile='icp_brasil'
    ${lock ? "FOR UPDATE OF s" : ""}`, [ctx.tenantId,id])).rows[0]
  if (!row) throw missing()
  return row
}

export function status({ phase, currentParticipant, documentCount, revision }: Envelope): WorkflowStatus {
  return { phase, currentParticipant, documentCount, revision }
}
export function pin(env: Envelope, validator: Pick<ContractSignatureValidator,"policySha256" | "trustBundleSha256">) {
  if (env.policy !== validator.policySha256 || env.trust !== validator.trustBundleSha256) throw mismatch()
}

export async function insertEvidence(ctx: WorkflowContext, env: Envelope, documentId: string, participantId: string | null,
  base: string, parent: string, candidate: string, proof: ValidatorReceipt) {
  pin(env, proof)
  const b = proof.binding
  if (proof.verdict !== "accepted" || b.tenantId !== ctx.tenantId || b.envelopeId !== env.envelopeId
    || b.documentId !== documentId || b.participantId !== participantId || b.baseSha256 !== base
    || b.parentSha256 !== parent || b.candidateSha256 !== candidate || sha256(proof.bundle) !== proof.bundleSha256) throw mismatch()
  const id = randomUUID()
  await ctx.client.query(`INSERT INTO contract_signature_evidence(tenant_id,envelope_id,id,document_id,participant_id,mode,
    verdict,parent_sha256,candidate_sha256,policy_sha256,trust_bundle_sha256,evidence_set_sha256,report_sha256,bundle_sha256,
    response_headers,bundle,observed_at) VALUES($1,$2,$3,$4,$5,$6,'accepted',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
  [ctx.tenantId,env.envelopeId,id,documentId,participantId,participantId ? "increment" : "preflight",parent,candidate,
    proof.policySha256,proof.trustBundleSha256,proof.evidenceSetSha256,proof.reportSha256,proof.bundleSha256,
    proof.responseHeaders,proof.bundle,proof.checkedAt])
  return id
}

export async function claim(ctx: WorkflowContext, env: Envelope, jobId: string) {
  const token = randomUUID()
  const result = await ctx.client.query(`UPDATE contract_signature_jobs SET status='leased',lease_token=$4,
    lease_until=clock_timestamp()+interval '90 seconds',attempts=least(100,attempts+1)
    WHERE tenant_id=$1 AND envelope_id=$2 AND id=$3 AND (status='pending' OR
      (status='leased' AND lease_until<=clock_timestamp())) RETURNING id`, [ctx.tenantId,env.envelopeId,jobId,token])
  if (!result.rows.length) throw busy()
  return token
}
export async function finishJob(ctx: WorkflowContext, env: Envelope, id: string, token: string, state: "pending" | "completed" | "rejected") {
  const result = await ctx.client.query(`UPDATE contract_signature_jobs SET status=$5,lease_until=NULL,lease_token=NULL
    WHERE tenant_id=$1 AND envelope_id=$2 AND id=$3 AND lease_token=$4 AND status='leased'
    AND lease_until>clock_timestamp() RETURNING id`, [ctx.tenantId,env.envelopeId,id,token,state])
  if (!result.rows.length) throw stale()
}
