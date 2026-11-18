import { z } from "zod"
import type { AuthorizedContext } from "../../platform/access.js"
import { commandKey, record, remember, replay } from "../../platform/commands.js"
import { normalizedDatabaseId } from "../../platform/database-id.js"
import { Problem } from "../../platform/problem.js"

type Headers = Record<string, string | string[] | undefined>

export async function locationSettings({ client, tenantId, permissions }: AuthorizedContext) {
  const { rows } = await client.query(`
    SELECT opening_id,sales_id,purchase_id,production_id,enabled,revision
    FROM stock_location_settings WHERE tenant_id=$1`, [tenantId])
  const row = rows[0]
  const warehouses = await client.query(`
    SELECT w.id,w.name,w.code,count(p.product_id) FILTER (WHERE p.quantity_micros>0)::int AS "itemsInStock"
    FROM warehouses w LEFT JOIN stock_positions p ON p.tenant_id=w.tenant_id AND p.warehouse_id=w.id
    WHERE w.tenant_id=$1 AND w.status='active' GROUP BY w.id ORDER BY w.name,w.code,w.id`, [tenantId])
  return { tenantId, canEdit: permissions.includes("inventory.stock.manage"), enabled: row?.enabled === true, revision: Number(row?.revision ?? 1),
    openingId: row?.opening_id ?? null, salesId: row?.sales_id ?? null, purchaseId: row?.purchase_id ?? null,
    productionId: row?.production_id ?? null, warehouses: warehouses.rows }
}

export async function activeStockLocations({ client,tenantId }: AuthorizedContext) {
  return (await client.query<{id: string; name: string; code: string}>(`
    SELECT w.id,w.name,w.code FROM warehouses w JOIN stock_location_settings c ON c.tenant_id=w.tenant_id
    WHERE w.tenant_id=$1 AND c.enabled AND w.status='active' ORDER BY w.name,w.code,w.id`, [tenantId])).rows
}

const settingsInput = z.strictObject({
  enabled: z.boolean(), revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  salesId: normalizedDatabaseId.nullable(), purchaseId: normalizedDatabaseId.nullable(), productionId: normalizedDatabaseId.nullable(),
})

export async function setLocations(context: AuthorizedContext, headers: Headers, body: unknown) {
  const key = commandKey(headers["idempotency-key"]), parsed = settingsInput.safeParse(body)
  if (!parsed.success) throw new Problem(422, "invalid_input", "Informe a revisão e os depósitos das operações")
  const input = parsed.data, scope = "stock.locations.configure"
  const previous = await replay(context, key, scope, input)
  if (previous) return previous
  const { client, tenantId } = context
  const init = await client.query<{ id: string }>("SELECT ensure_stock_location($1) AS id", [tenantId])
  const openingId = init.rows[0]!.id
  const ids = [input.salesId, input.purchaseId, input.productionId].map(id => input.enabled && id ? id : openingId)
  const matched = await client.query("SELECT id FROM warehouses WHERE tenant_id=$1 AND status='active' AND id=ANY($2::uuid[])", [tenantId, ids])
  if (matched.rows.length !== new Set(ids).size) throw new Problem(422, "invalid_input", "Selecione depósitos ativos desta empresa")
  if (!input.enabled) {
    const inUse = await client.query(`
      SELECT EXISTS(SELECT 1 FROM stock_location_balances WHERE tenant_id=$1 AND quantity_micros>0)
        OR EXISTS(SELECT 1 FROM stock_location_reservations WHERE tenant_id=$1 AND warehouse_id<>$2) AS used`, [tenantId, openingId])
    if (inUse.rows[0]?.used) throw new Problem(409, "domain_conflict", "Transfira os saldos e libere as reservas dos outros depósitos antes de desativar")
  }
  const updated = await client.query(`UPDATE stock_location_settings
    SET enabled=$3,sales_id=$4,purchase_id=$5,production_id=$6,revision=revision+1 WHERE tenant_id=$1 AND revision=$2 RETURNING revision`,
  [tenantId, input.revision, input.enabled, ...ids])
  if (!updated.rows.length) throw new Problem(409, "revision_conflict", "Os parâmetros de depósito foram alterados. Recarregue a página")
  const result = await locationSettings(context)
  await record(context, headers, "stock_location_settings", tenantId, scope, { ...input, revision: result.revision })
  await remember(context, key, scope, input, result)
  return result
}
