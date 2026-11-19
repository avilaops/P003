import type { AuthorizedContext } from "../../../platform/access.js"
import { requirePermission } from "../../../platform/access.js"
import { Problem } from "../../../platform/problem.js"
import { validateLayout, type Total } from "./definition.js"
import { engineSource } from "./registry.js"

type DefinitionRow = { id: string; name: string; dataset: string; columns: string[]; filters: Record<string, unknown>; group_by: string[]; totals: Total[] }

/** Lê uma definição salva (RLS: dono/visibilidade e permissões da fonte) e revalida contra a fonte atual. */
export async function loadEngineDefinition(ctx: AuthorizedContext, id: string) {
  requirePermission(ctx, "system.reports.read")
  const { rows: [definition] } = await ctx.client.query<DefinitionRow>(
    "SELECT id,name,dataset,columns,filters,group_by,totals FROM system_config.report_definitions WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, id])
  if (!definition) throw new Problem(404, "not_found", "Relatório não encontrado nesta empresa")
  const source = engineSource(definition.dataset)
  if (!source) throw new Problem(422, "unsupported_source", "Esta fonte ainda não é executada pelo motor de relatórios")
  const layout = { name: definition.name, ...validateLayout(source, { columns: definition.columns, groupBy: definition.group_by, totals: definition.totals, filters: definition.filters }) }
  return { definition, source, layout }
}
