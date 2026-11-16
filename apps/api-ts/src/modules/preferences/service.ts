import { createHash } from "node:crypto"

import type { AuthorizedContext } from "../../platform/access.js"
import { Problem } from "../../platform/problem.js"
import type { DashboardLayout, PreferencesInput } from "./schema.js"

const defaultLayout: DashboardLayout = {
  favoritePaths: [
    "/vendas/pedidos",
    "/compras/pedidos",
    "/cadastros/clientes-fornecedores",
    "/cadastros/produtos",
    "/financeiro/contas-receber",
  ],
  charts: ["Ticket médio", "Valor faturado"],
  period: "6M",
}

type StoredPreferences = {
  revision: number
  product_page_size: number
  dashboard_layout: DashboardLayout
}

export type PreferencesSnapshot = {
  ownerKey: string
  tenantId: string
  revision: number
  data: { productPageSize: number; dashboardLayout: DashboardLayout }
}

export function preferenceOwnerKey(tenantId: string, authSubject: string) {
  return createHash("sha256").update(`${tenantId}:${authSubject}`).digest("hex")
}

async function load(context: AuthorizedContext): Promise<StoredPreferences> {
  const result = await context.client.query<StoredPreferences>(
    "SELECT revision,product_page_size,dashboard_layout FROM personal_preferences WHERE tenant_id=$1 AND auth_subject=$2",
    [context.tenantId, context.authSubject],
  )
  return result.rows[0] ?? { revision: 1, product_page_size: 25, dashboard_layout: defaultLayout }
}

function snapshot(context: AuthorizedContext, stored: StoredPreferences): PreferencesSnapshot {
  return {
    ownerKey: preferenceOwnerKey(context.tenantId, context.authSubject),
    tenantId: context.tenantId,
    revision: stored.revision,
    data: { productPageSize: stored.product_page_size, dashboardLayout: stored.dashboard_layout },
  }
}

export async function getPreferences(context: AuthorizedContext) {
  return snapshot(context, await load(context))
}

export async function putPreferences(context: AuthorizedContext, expected: number, input: PreferencesInput) {
  await context.client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [context.tenantId])
  const current = await load(context)
  if (current.revision !== expected) {
    throw new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada")
  }
  const ownerKey = preferenceOwnerKey(context.tenantId, context.authSubject)
  if ((input.dashboardLayout !== undefined || input.ownerKey !== undefined) && input.ownerKey !== ownerKey) {
    throw new Problem(409, "domain_conflict", "A conta ou empresa mudou. Recarregue suas preferências")
  }
  const next = current.revision + 1
  const layout = input.dashboardLayout ?? current.dashboard_layout
  await context.client.query(
    "INSERT INTO personal_preferences(tenant_id,auth_subject,product_page_size,revision,dashboard_layout) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,auth_subject) DO UPDATE SET product_page_size=$3,revision=$4,dashboard_layout=$5,updated_at=now()",
    [context.tenantId, context.authSubject, input.productPageSize, next, layout],
  )
  await context.client.query(
    "INSERT INTO audit_log(tenant_id,identity_id,action,entity_type,details) SELECT $1,id,'preferences.updated','personal_preferences',$3 FROM identities WHERE auth_subject=$2",
    [context.tenantId, context.authSubject, { previousRevision: current.revision, revision: next, productPageSize: input.productPageSize }],
  )
  return snapshot(context, { revision: next, product_page_size: input.productPageSize, dashboard_layout: layout })
}
