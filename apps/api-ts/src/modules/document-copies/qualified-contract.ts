import type { AuthorizedContext } from "../../platform/access.js"
import { documentMailLimit } from "../../platform/document-mail.js"
import { Problem } from "../../platform/problem.js"
import { digest, type File } from "./source.js"

type Head = { id: string; sequence: number; position: number; sha256: string; size: number; revisionId: string }

export async function qualifiedContract(context: AuthorizedContext, contractId: string) {
  const { rows } = await context.client.query<{ envelope: string; signers: number; documents: number; heads: Head[] }>(`
    SELECT e.id AS envelope,e.participant_count AS signers,s.document_count AS documents,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'sequence',h.sequence,'position',d.position,
        'sha256',r.sha256,'size',octet_length(r.content),'revisionId',r.id) ORDER BY d.position),'[]'::jsonb)
        FROM contract_signature_documents d JOIN contract_signature_heads h USING(tenant_id,envelope_id)
        JOIN contract_signature_revisions r ON (r.tenant_id,r.envelope_id,r.document_id,r.id)=(h.tenant_id,h.envelope_id,h.document_id,h.revision_id)
        WHERE d.tenant_id=e.tenant_id AND d.envelope_id=e.id AND h.document_id=d.id
        AND h.base_sha256=d.sha256 AND h.sequence=e.participant_count AND h.preflight_evidence_id IS NOT NULL
        AND r.sha256=h.sha256) AS heads
    FROM commercial_contracts c JOIN contract_signature_envelopes e ON e.tenant_id=c.tenant_id AND e.contract_id=c.id
    JOIN contract_signature_states s ON s.tenant_id=e.tenant_id AND s.envelope_id=e.id
    WHERE c.tenant_id=$1 AND c.id=$2 AND c.status='completed' AND c.signature_policy='icp_each_participant'
      AND e.trust_profile='icp_brasil' AND s.phase='completed'
      AND s.document_count=(SELECT count(*) FROM contract_signature_documents d WHERE d.tenant_id=e.tenant_id AND d.envelope_id=e.id)
      AND e.participant_count=jsonb_array_length(c.recipients)
      AND e.participant_count=(SELECT count(*) FROM contract_signature_participants p
        WHERE p.tenant_id=e.tenant_id AND p.envelope_id=e.id
          AND (c.recipients->(p.position-1)->>'email')=p.email
          AND (c.recipients->(p.position-1)->>'role')=p.role
          AND (c.recipients->(p.position-1)->>'name')=p.name)
      AND ARRAY(SELECT d.sha256 FROM contract_signature_documents d WHERE d.tenant_id=e.tenant_id AND d.envelope_id=e.id ORDER BY d.sha256)
        = ARRAY(SELECT f.sha256 FROM commercial_contract_files f WHERE f.tenant_id=c.tenant_id AND f.contract_id=c.id AND f.kind='signed' ORDER BY f.sha256)`,
    [context.tenantId,contractId])
  const result = rows[0]
  if (!result || !result.documents || result.heads.length !== result.documents) return null
  return { ...result, files: async (): Promise<File[]> => {
    if (result.heads.reduce((sum, h) => sum + h.size, 0) > documentMailLimit) throw new Problem(413, "attachment_limit", "Os contratos assinados excedem o limite de envio")
    const revisions = await context.client.query<{ id: string; content: Buffer }>(`
      SELECT id,content FROM contract_signature_revisions WHERE tenant_id=$1 AND envelope_id=$2 AND id=ANY($3::uuid[])`,
      [context.tenantId, result.envelope, result.heads.map(h => h.revisionId)])
    return result.heads.map(h => {
      const content = revisions.rows.find(r => r.id === h.revisionId)?.content
      if (!content || content.subarray(0,5).toString("ascii") !== "%PDF-" || digest(content) !== h.sha256) {
        throw new Problem(409, "signature_file_changed", "Não foi possível conferir o PDF validado")
      }
      return { filename: `contrato-assinado-icp-${contractId}-${h.position}.pdf`, contentType:"application/pdf", content, sourceId:h.revisionId }
    })
  } }
}
