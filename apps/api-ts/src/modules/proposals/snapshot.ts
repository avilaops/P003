import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import { proposalSummary } from "../sales/shared.js"

export function projectProposalReplay(context: AuthorizedContext, body: Record<string, unknown>): Record<string, unknown> & { canEdit: boolean } {
  return { ...body, canEdit: context.permissions.includes("sales.proposals.manage"), ...(Object.hasOwn(body, "director") ? { director: context.permissions.includes("platform.company.manage") && context.permissions.includes("sales.approvals.director") ? body.director : null } : {}) }
}

export const summary = "SELECT p.id,p.number::text AS number,v.version,p.revision,v.customer_id,v.customer_name,v.customer_tax_id,v.valid_until::text AS valid_until,v.payment_terms,v.delivery_terms,v.notes,(v.amount_cents::numeric/100)::numeric(16,2)::text AS amount,v.status,(v.status='sent' AND v.valid_until < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date) AS expired,p.order_id,(v.version=p.current_version) AS is_current,v.created_at::text AS created_at,to_json(p.updated_at)#>>'{}' AS updated_at,v.sent_at::text AS sent_at,v.decided_at::text AS decided_at,v.decided_by,v.decision_reason FROM sales_proposals p JOIN sales_proposal_versions v ON v.tenant_id=p.tenant_id AND v.proposal_id=p.id"
export async function loadProposal(context: AuthorizedContext, id: string, version?: number) {
  const detailSummary = summary.replace("SELECT p.id", "SELECT v.commercial_public,v.commercial_private,v.customer_snapshot,v.checkout_snapshot,p.id")
  const row = await context.client.query(`${detailSummary} WHERE p.tenant_id=$1 AND p.id=$2 AND v.version=COALESCE($3,p.current_version)`, [context.tenantId, id, version ?? null])
  if (!row.rows[0]) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
  const data = proposalSummary(row.rows[0])
  const lines = await context.client.query("SELECT product_id,sku,name,unit,(quantity_micros::numeric/1000000)::numeric(19,6)::text AS quantity,(price_cents::numeric/100)::numeric(16,2)::text AS unit_price,(catalog_price_cents::numeric/100)::numeric(16,2)::text AS catalog_price,(amount_cents::numeric/100)::numeric(16,2)::text AS amount,technical_snapshot,structure_color,upholstery_color,plate_holder_color,plate_holder_type,swing_arm_color FROM sales_proposal_lines WHERE tenant_id=$1 AND proposal_id=$2 AND version=$3 ORDER BY line_number", [context.tenantId, id, data.version])
  const versions = await context.client.query(`${summary} WHERE p.tenant_id=$1 AND p.id=$2 ORDER BY v.version DESC`, [context.tenantId, id])
  const items = lines.rows.map(item => ({
    productId: item.product_id, sku: item.sku, name: item.name, unit: item.unit, quantity: item.quantity, unitPrice: item.unit_price, catalogPrice: item.catalog_price, amount: item.amount,
    structureColor: item.structure_color, upholsteryColor: item.upholstery_color,
    ...(item.technical_snapshot == null ? {} : { technical: item.technical_snapshot }),
    ...(item.swing_arm_color == null ? {} : { swingArmColor: item.swing_arm_color }),
    ...(item.plate_holder_color == null ? {} : { plateHolderColor: item.plate_holder_color }),
    ...(item.plate_holder_type == null ? {} : { plateHolderType: item.plate_holder_type }),
  }))
  const agreement = row.rows[0]
  return { tenantId: context.tenantId, canEdit: context.permissions.includes("sales.proposals.manage"), data, items, versions: versions.rows.map(proposalSummary), ...(agreement?.commercial_public ? { commercial: agreement.commercial_public, customer: agreement.customer_snapshot, checkout: agreement.checkout_snapshot, director: context.permissions.includes("platform.company.manage") && context.permissions.includes("sales.approvals.director") ? (agreement.commercial_private as Record<string, unknown>).director : null } : {}) }
}
