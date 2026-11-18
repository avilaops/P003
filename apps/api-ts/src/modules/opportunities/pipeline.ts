import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue } from "../../platform/revision.js"

export const builtins = [
  ["new","Novo"], ["contacted","Contato feito"], ["proposed","Proposta enviada"],
  ["negotiation","Negociação"], ["won","Ganho"], ["lost","Perdido"],
].map(([code,label])=>({code:code!,label:label!,active:true}))
export type Stage = typeof builtins[number]
export const stageSchema = z.strictObject({
  code:z.string().regex(/^(?:new|contacted|proposed|negotiation|won|lost|custom-[a-z0-9][a-z0-9-]{0,30})$/),
  label:z.string().trim().min(1).max(60), active:z.boolean(),
})
export async function pipeline(c:AuthorizedContext) {
  const row=(await c.client.query<{stages:Stage[];revision:string}>(
    "SELECT stages,revision FROM sales_pipeline_settings WHERE tenant_id=$1",[c.tenantId])).rows[0]
  return {stages:row?.stages ?? builtins,revision:revisionValue(row?.revision ?? 1)}
}

export async function members(c:AuthorizedContext) {
  return (await c.client.query("SELECT i.id,i.display_name AS name FROM tenant_memberships m JOIN identities i ON i.id=m.identity_id WHERE m.tenant_id=$1 AND m.status='active' ORDER BY i.display_name,i.id",[c.tenantId])).rows
}
export async function validateOwner(c:AuthorizedContext,id:string) {
  const member=(await c.client.query("SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND identity_id=$2 AND status='active'",[c.tenantId,id])).rows[0]
  if(!member) throw new Problem(422,"invalid_input","Selecione um responsável ativo desta empresa")
}
export async function activities(c:AuthorizedContext,id:string) {
  return (await c.client.query(`SELECT a.id,a.kind,a.subject,a.due_date::text AS "dueDate",a.owner_id AS "ownerId",i.display_name AS "ownerName",a.completed_at AS "completedAt"
    FROM sales_pipeline_activities a JOIN identities i ON i.id=a.owner_id WHERE a.tenant_id=$1 AND a.opportunity_id=$2
    ORDER BY a.completed_at IS NOT NULL,a.due_date,a.created_at,a.id`,[c.tenantId,id])).rows
}

export async function stageHistory(c:AuthorizedContext,id:string) {
  return (await c.client.query(`WITH events AS (
    SELECT occurred_at,details->>'stage' AS stage,details->>'stageLabel' AS label,details->>'lossReason' AS reason,
      lag(details->>'stage') OVER(ORDER BY occurred_at,(details->>'revision')::numeric NULLS FIRST,a.id) AS previous
    FROM audit_log a WHERE tenant_id=$1 AND entity_type='sales_opportunity' AND entity_id=$2 AND details ? 'stage'
  ) SELECT occurred_at AS "at",stage,label,reason FROM events WHERE stage IS DISTINCT FROM previous ORDER BY occurred_at DESC LIMIT 100`,[c.tenantId,id])).rows
}

// A stage can be visited more than once. Count each opportunity once for that stage,
// and count a win only if it happened on or after its first recorded visit.
export async function conversion(c:AuthorizedContext,start:string|null,end:string|null) {
  return (await c.client.query(`WITH cohort AS (
      SELECT id,data,created_at,updated_at FROM sales_opportunities WHERE tenant_id=$1
        AND ($2::date IS NULL OR created_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo'))
        AND ($3::date IS NULL OR created_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
    ), visits AS (
      SELECT o.id,a.details->>'stage' AS stage,a.occurred_at AS at FROM cohort o JOIN audit_log a
        ON a.tenant_id=$1 AND a.entity_type='sales_opportunity' AND a.entity_id=o.id::text AND a.details ? 'stage'
      UNION ALL SELECT id,data->>'stage',updated_at FROM cohort
    ), first_visit AS (
      SELECT id,stage,min(at) AS at FROM visits GROUP BY id,stage
    ), wins AS (SELECT id,max(at) AS at FROM visits WHERE stage='won' GROUP BY id)
    SELECT v.stage,count(*)::int AS reached,count(w.id)::int AS won FROM first_visit v
      LEFT JOIN wins w ON w.id=v.id AND w.at>=v.at GROUP BY v.stage ORDER BY v.stage`,[c.tenantId,start,end])).rows
}
