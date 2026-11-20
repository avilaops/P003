import type { AuthorizedContext } from "../../platform/access.js"
import type { ContractPortal } from "../company-account/contract-webhook.js"

/** Modelos que a empresa pode usar: os atribuídos no portal e os publicados pelo próprio ERP. */
export async function templateIds(context: AuthorizedContext, portal: ContractPortal) {
  const published = (await context.client.query<{ external_id: string }>(
    "SELECT external_id::text FROM commercial_template_versions WHERE tenant_id=$1 AND external_id IS NOT NULL ORDER BY published_at DESC LIMIT 100",
    [context.tenantId])).rows.map(row => Number(row.external_id))
  return [...new Set([...portal.templateIds(context.tenantId), ...published])].sort((a, b) => a - b)
}
