import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../platform/access.js"
import { record } from "../../platform/commands.js"
import { Problem } from "../../platform/problem.js"
import { parseRevision, revisionValue } from "../../platform/revision.js"
import { stringifyJson } from "../../platform/json.js"
import { reportInput } from "./schema.js"
import { stockSource, visibleStockCatalog } from "./stock-catalog.js"
import { runStockReport } from "./stock-run.js"

const select = "SELECT id,name,dataset,columns,filters,visibility,revision,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at FROM system_config.report_definitions"
function report(row: Record<string, unknown>) {
  return { id: row.id, name: row.name, dataset: row.dataset, columns: row.columns, filters: row.filters, visibility: row.visibility, revision: revisionValue(row.revision), createdAt: row.created_at }
}
async function load(context: AuthorizedContext, id: string) {
  const row = (await context.client.query(`${select} WHERE tenant_id=$1 AND id=$2`, [context.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Registro não encontrado nesta empresa")
  return report(row)
}
export function registerReportRoutes(app: FastifyInstance, dependencies: AppDependencies) {
  app.get("/api/v1/stock/reports", async (request, reply) => {
    const body = await authorizeRequest(request,dependencies,context=>runStockReport(context,request.query),false,true)
    return reply.header("cache-control","no-store").send(body)
  })
  const url = "/api/v1/system/custom-reports"
  app.get(url, async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "system.reports.read")
      const rows = await context.client.query(`${select} WHERE tenant_id=$1 ORDER BY name,id`, [context.tenantId])
      return { tenantId: context.tenantId, data: rows.rows.map(report), stockSources:visibleStockCatalog(context.permissions), canEdit: context.permissions.includes("system.reports.manage") }
    })
    return reply.header("cache-control", "no-store").send(body)
  })
  app.post(url, async (request, reply) => {
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "system.reports.read"); requirePermission(context, "system.reports.manage")
      const { input, permission } = reportInput(request.body)
      requirePermission(context, permission)
      if(stockSource(input.dataset)) requirePermission(context,"inventory.stock.read")
      const id = randomUUID()
      const inserted = await context.client.query("INSERT INTO system_config.report_definitions(tenant_id,id,name,dataset,columns,filters,owner_identity_id,visibility) SELECT $1,$2,$3,$4,$5,$6,i.id,$7 FROM identities i JOIN tenant_memberships m ON m.identity_id=i.id AND m.tenant_id=$1 AND m.status='active' WHERE i.auth_subject=$8 RETURNING id", [context.tenantId, id, input.name, input.dataset, stringifyJson(input.columns), input.filters, input.visibility, context.authSubject])
      if (!inserted.rows.length) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
      await record(context, request.headers, "custom_report", id, "custom_report.created", { dataset: input.dataset, visibility: input.visibility })
      return { tenantId: context.tenantId, data: await load(context, id) }
    })
    return reply.code(201).header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })
  app.put<{ Params: { id: string } }>(`${url}/:id`, async (request, reply) => {
    const expected = parseRevision(request.headers["if-match"]), id = z.guid().safeParse(request.params.id)
    if (!id.success) throw new Problem(422, "invalid_input", "Identificador inválido")
    const body = await authorizeRequest(request, dependencies, async context => {
      requirePermission(context, "system.reports.read"); requirePermission(context, "system.reports.manage")
      const { input, permission } = reportInput(request.body)
      requirePermission(context, permission)
      if(stockSource(input.dataset)) requirePermission(context,"inventory.stock.read")
      const changed = await context.client.query("UPDATE system_config.report_definitions SET name=$3,dataset=$4,columns=$5,filters=$6,visibility=$7,revision=revision+1 WHERE tenant_id=$1 AND id=$2 AND revision=$8 RETURNING id", [context.tenantId, id.data, input.name, input.dataset, stringifyJson(input.columns), input.filters, input.visibility, expected])
      if (!changed.rows.length) {
        const exists = (await context.client.query("SELECT EXISTS(SELECT 1 FROM system_config.report_definitions WHERE tenant_id=$1 AND id=$2) AS present", [context.tenantId, id.data])).rows[0]?.present
        throw exists ? new Problem(412, "revision_conflict", "Outra pessoa alterou o cadastro. Sua edição foi preservada") : new Problem(404, "not_found", "Registro não encontrado nesta empresa")
      }
      const data = await load(context, id.data)
      await record(context, request.headers, "custom_report", id.data, "custom_report.updated", { revision: data.revision, dataset: input.dataset, visibility: input.visibility })
      return { tenantId: context.tenantId, data }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })
}
