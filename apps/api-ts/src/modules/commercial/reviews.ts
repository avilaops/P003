import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { nextRevision, revisionValue, type Revision } from "../../platform/revision.js"
import type { CommandHeaders } from "../orders/receivables.js"
import { formalizeProposal } from "../proposals/formalize.js"

export const decisionSchema = z.strictObject({approved:z.boolean(),reason:z.string().trim().min(1).max(1000).regex(/^[^\p{Cc}]+$/u)})
export type ReviewKind = "order" | "proposal" | "credit"
const pending = `WITH requests AS (
 SELECT 'order' AS kind,o.id AS id,o.id AS document_id,o.number::text AS number,o.customer_name AS customer,o.amount_cents,
 o.revision,CASE WHEN q.requires_director THEN 'director' ELSE 'manager' END AS level,
 i.auth_subject AS requester,q.created_at,q.public_snapshot->'sale'->'approvalReasons' AS reasons
 FROM commercial_order_quotes q JOIN sales_orders o ON (o.tenant_id,o.id)=(q.tenant_id,q.order_id)
 JOIN identities i ON i.id=q.created_by WHERE q.tenant_id=$1 AND o.status='draft' AND q.approval_status='pending'
 UNION ALL
 SELECT 'proposal',p.id,p.id,p.number::text,v.customer_name,v.amount_cents,p.revision,
 CASE WHEN (v.commercial_private->'director'->>'requiresDirector')::boolean THEN 'director' ELSE 'manager' END,
 COALESCE(v.requested_by,v.created_by),v.created_at,v.commercial_public->'sale'->'approvalReasons'
 FROM sales_proposals p JOIN sales_proposal_versions v ON (v.tenant_id,v.proposal_id,v.version)=(p.tenant_id,p.id,p.current_version)
 WHERE p.tenant_id=$1 AND v.status='draft' AND v.commercial_approval IS NULL AND jsonb_array_length(v.commercial_public->'sale'->'approvalReasons')>0
 UNION ALL
 SELECT 'credit',c.id,o.id,o.number::text,o.customer_name,o.amount_cents,o.revision,'credit',c.requested_by,c.created_at,to_jsonb(c.reasons)
 FROM sales_credit_reviews c JOIN sales_orders o ON (o.tenant_id,o.id)=(c.tenant_id,c.order_id)
 JOIN sales_customer_policies cp ON (cp.tenant_id,cp.customer_id)=(o.tenant_id,o.customer_id)
 WHERE c.tenant_id=$1 AND c.status='pending' AND o.revision=c.order_revision AND cp.revision=c.policy_revision AND o.status IN ('draft','accepted')
)
SELECT requests.*,requests.created_at+make_interval(hours=>COALESCE(r.due_hours,48)) AS due_at,
 COALESCE(r.substitute_until>=(CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date AND sub.auth_subject=$2,false) AS substitute
 FROM requests LEFT JOIN sales_approval_routing r ON r.tenant_id=$1 AND r.level=requests.level
 LEFT JOIN identities sub ON sub.id=r.substitute_id`

export function canReview(context: AuthorizedContext, row: Record<string,unknown>) {
 if (row.requester === context.authSubject) return false
 if (row.kind === "proposal" && !context.permissions.includes("sales.proposals.read")) return false
 if (row.kind !== "proposal" && !context.permissions.includes("sales.orders.read")) return false
 if (row.level === "credit") return context.permissions.includes("finance.receivables.manage") || row.substitute === true
 return row.substitute === true || context.permissions.includes("sales.approvals.director") || row.level === "manager" && context.permissions.includes("sales.approvals.manage")
}
export async function reviewAuthority(context:AuthorizedContext, kind:ReviewKind, level:string) {
 const route=(await context.client.query("SELECT i.auth_subject FROM sales_approval_routing r JOIN identities i ON i.id=r.substitute_id WHERE r.tenant_id=$1 AND r.level=$2 AND r.substitute_until >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date",[context.tenantId,level])).rows[0]
 return canReview(context,{kind,level,substitute:route?.auth_subject===context.authSubject})
}
export async function reviewNotifications(context:AuthorizedContext) {
 const events = await context.client.query(`SELECT entity_type AS kind,entity_id AS id,action,details->>'decision' AS decision,details->>'reason' AS reason,occurred_at AS at
  FROM audit_log WHERE tenant_id=$1 AND action IN ('negotiation.decided','proposal.decided','credit.decided') AND details->>'requestedBy'=$2 ORDER BY occurred_at DESC LIMIT 50`,[context.tenantId,context.authSubject])
 return events.rows.filter(row=>context.permissions.includes(row.kind==="sales_proposal"?"sales.proposals.read":"sales.orders.read"))
}
export async function listReviews(context: AuthorizedContext) {
 const rows = (await context.client.query(pending + " ORDER BY due_at,kind,id",[context.tenantId,context.authSubject])).rows
 return rows.filter(row=>canReview(context,row)).map(row=>({kind:row.kind,id:row.id,documentId:row.document_id,number:row.number,customer:row.customer,amountCents:revisionValue(row.amount_cents),revision:revisionValue(row.revision),level:row.level,reasons:row.reasons??[],dueAt:row.due_at,createdAt:row.created_at}))
}

export async function decideReview(context: AuthorizedContext, headers: CommandHeaders, kind: ReviewKind, id: string, expected: Revision, decision: z.infer<typeof decisionSchema>) {
 const {client,tenantId,authSubject} = context
 const row = (await client.query(pending+" WHERE requests.kind=$3 AND requests.id=$4",[tenantId,authSubject,kind,id])).rows[0]
 if (!row) throw new Problem(409,"domain_conflict","A solicitação foi decidida, alterada ou cancelada")
 if (!canReview(context,row)) throw new Problem(403,"forbidden","A decisão exige outro responsável com a alçada indicada")
 if (BigInt(String(row.revision)) !== BigInt(expected)) throw new Problem(412,"revision_conflict","A solicitação mudou. Atualize a fila")
 const status = decision.approved ? "approved" : "rejected"
 const next = kind === "credit" ? expected : nextRevision(expected)
 if (kind === "credit") {
   await client.query("UPDATE sales_credit_reviews SET status=$3,decided_by=$4,decided_at=now(),decision_reason=$5 WHERE tenant_id=$1 AND id=$2",[tenantId,id,status,authSubject,decision.reason])
 } else if (kind === "proposal") {
   const version = (await client.query("SELECT current_version FROM sales_proposals WHERE tenant_id=$1 AND id=$2",[tenantId,id])).rows[0]!.current_version as number
   if (decision.approved) await formalizeProposal(context,id,version,true,true)
   else await client.query("UPDATE sales_proposal_versions SET commercial_approval=jsonb_build_object('rejected',true,'by',$4::text,'reason',$5::text) WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3",[tenantId,id,version,authSubject,decision.reason])
   await client.query("UPDATE sales_proposals SET revision=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,id,next])
 } else {
   await client.query("UPDATE commercial_order_quotes SET approval_status=$3 WHERE tenant_id=$1 AND order_id=$2",[tenantId,id,status])
   await client.query("UPDATE sales_orders SET revision=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2",[tenantId,id,next])
   await client.query("INSERT INTO commercial_approval_decisions(id,tenant_id,order_id,order_revision,decision,reason,decided_by) SELECT $1,$2,$3,$4,$5,$6,id FROM identities WHERE auth_subject=$7",[randomUUID(),tenantId,id,next,status,decision.reason,authSubject])
 }
 await record(context,headers,kind==="proposal"?"sales_proposal":"sales_order",String(row.document_id),kind==="order"?"negotiation.decided":kind+".decided",{revision:next,decision:status,reason:decision.reason,requestedBy:row.requester,decidedBy:authSubject})
 return {tenantId,id,revision:next,approvalStatus:status,kind,level:String(row.level)}
}
