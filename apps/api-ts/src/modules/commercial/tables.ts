import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest } from "../../platform/access.js"
import { requireCommercialRead } from "./access.js"
import { reloadTenantPermissions } from "../../platform/database.js"
import { Problem } from "../../platform/problem.js"
import { revisionValue } from "../../platform/revision.js"
import { approvalRulesSchema } from "./approvals.js"
import { parametersSchema, STATES } from "./parameters.js"
import { sourceAvailable, sourceColumns, sourceItem, sourceJoins } from "./prepare.js"
import { authorityKind, tableProjection } from "./table-model.js"

export function registerCommercialTables(app: FastifyInstance, dependencies: AppDependencies) {
  app.get<{ Params: { line: string } }>("/api/v1/commercial/tables/:line", async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requireCommercialRead(context)
      const { line } = request.params
      if (!["imported", "national"].includes(line)) throw new Problem(422, "invalid_input", "Linha comercial inválida")
      const query = z.strictObject({ destinationState: z.string().optional(), taxpayer: z.enum(["true", "false"]).transform(value => value === "true").optional() }).safeParse(request.query)
      if (!query.success) throw new Problem(422, "invalid_input", "Filtros de destino inválidos")
      if (query.data.destinationState !== undefined && !STATES.some(state => state === query.data.destinationState)) throw new Problem(422, "invalid_input", "UF de destino inválida")
      await context.client.query("SELECT id FROM tenants WHERE id=$1 FOR SHARE", [context.tenantId])
      await reloadTenantPermissions(context)
      requireCommercialRead(context)
      const { client, tenantId } = context, allowed = (permission: string) => context.permissions.includes(permission)
      const authority = { manager: allowed("sales.approvals.manage"), director: allowed("sales.approvals.director") }
      const savedRules = (await client.query("SELECT rules FROM commercial_approval_settings WHERE tenant_id=$1", [tenantId])).rows[0]
      const parsedRules = savedRules ? approvalRulesSchema.safeParse(savedRules.rules) : null
      if (parsedRules && !parsedRules.success) throw new Problem(500, "internal_error", "Erro interno")
      const rules = parsedRules?.success ? parsedRules.data : null
      const methods = await client.query("SELECT jsonb_build_object('id',id,'name',name,'kind',modality) AS data FROM payment_methods WHERE tenant_id=$1 AND status='active' ORDER BY name,id", [tenantId])
      const published = (await client.query("SELECT v.id,v.settings_revision,s.revision,v.policy_snapshot,jsonb_build_object('id',v.id,'version',v.version,'publishedAt',v.published_at,'originState',v.policy_snapshot->>'originState','freeDiscountBps',v.policy_snapshot->'freeDiscountBps','minimumDownPaymentBps',v.policy_snapshot->'minimumDownPaymentBps') AS data FROM commercial_settings s JOIN price_table_versions v ON v.tenant_id=s.tenant_id AND v.id=s.active_price_version_id AND v.product_line=s.product_line WHERE s.tenant_id=$1 AND s.product_line=$2", [tenantId, line])).rows[0]
      let data = null
      if (published) {
        const parsed = parametersSchema.safeParse(published.policy_snapshot)
        if (!parsed.success) throw new Problem(500, "internal_error", "Erro interno")
        const parameters = parsed.data, destination = query.data.destinationState ?? parameters.originState, taxpayer = query.data.taxpayer ?? false
        const selected = await client.query(`SELECT ${sourceColumns},i.ipi_bps,i.price_with_ipi_cents,COALESCE(${sourceAvailable.replaceAll("$4", "$3")},false) AS available ${sourceJoins} WHERE i.tenant_id=$1 AND i.version_id=$2 AND v.product_line=$3 ORDER BY i.product_snapshot->>'sku',i.product_id`, [tenantId, published.id, line])
        const rows = selected.rows.map(row => ({ source: sourceItem(row), ipiBps: Number(row.ipi_bps), priceWithIpiCents: revisionValue(row.price_with_ipi_cents), available: Boolean(row.available) }))
        const sameRevision = revisionValue(published.settings_revision) === revisionValue(published.revision), globallyAvailable = sameRevision && rules !== null
        const availability = !sameRevision ? { status: "settingsStale", message: "Parâmetros alterados após a publicação. Publique a tabela atualizada antes de simular" } : rules === null ? { status: "rulesMissing", message: "Salve as regras de aprovação da empresa antes de simular" } : rows.some(row => !row.available) ? { status: "itemsUnavailable", message: "Há produtos ou custos alterados após a publicação. Confira os itens disponíveis" } : { status: "ready", message: null }
        const projection = tableProjection({ parameters, rules, version: String(published.id), line, destination, taxpayer, globallyAvailable, authority }, rows)
        data = { ...(published.data as Record<string, unknown>), context: { destinationState: destination, taxpayer, quantity: 1, freightCents: 0, downPayment: "policy" }, availability, ...projection }
      }
      return { tenantId, line, data, canManage: allowed("platform.company.manage"), canCreateOrder: allowed("sales.orders.manage"), authority: authorityKind(authority, rules), paymentMethods: methods.rows.map(row => row.data) }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
}
