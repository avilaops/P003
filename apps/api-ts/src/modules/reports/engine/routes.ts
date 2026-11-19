import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { AppDependencies } from "../../../app.js"
import { authorizeRequest, requirePermission, type AuthorizedContext } from "../../../platform/access.js"
import { commandKey, record, remember, replay } from "../../../platform/commands.js"
import { documentMailCompany } from "../../../platform/document-mail-template.js"
import { Problem } from "../../../platform/problem.js"
import { parseRevision, revisionValue } from "../../../platform/revision.js"
import { totalSchema, validateLayout } from "./definition.js"
import { exportFormats, renderReport, type ExportFormat } from "./export.js"
import { canUseSource, engineSource, visibleEngineCatalog } from "./registry.js"
import { executeReport } from "./run.js"
import { nextRunAt } from "./schedule.js"
import { loadEngineDefinition } from "./store.js"

/** Linhas devolvidas na tela; exportação e agenda levam todas (até o limite do motor). */
export const previewRows = 500
const guid = (value: unknown, title = "Relatório não encontrado nesta empresa") => {
  const parsed = z.guid().safeParse(value)
  if (!parsed.success) throw new Problem(404, "not_found", title)
  return parsed.data.toLowerCase()
}
function invalid(title: string): never { throw new Problem(422, "invalid_input", title) }
const previewInput = z.strictObject({ name: z.string().max(120).optional(), dataset: z.string().max(63), columns: z.array(z.string()).max(60),
  groupBy: z.array(z.string()).max(2).default([]), totals: z.array(totalSchema).max(20).default([]), filters: z.record(z.string(), z.unknown()).default({}) })
const formatQuery = z.strictObject({ format: z.enum(["json", "csv", "xlsx", "pdf"]).default("json") })
const scheduleInput = z.strictObject({
  frequency: z.enum(["daily", "weekly", "monthly"]), weekday: z.number().int().min(0).max(6).nullable().optional(),
  monthDay: z.number().int().min(1).max(28).nullable().optional(), hour: z.number().int().min(0).max(23),
  format: z.enum(["csv", "xlsx", "pdf"]), recipients: z.array(z.string().trim().pipe(z.email().max(254))).min(1).max(20), active: z.boolean().default(true),
})
function parseSchedule(body: unknown) {
  const parsed = scheduleInput.safeParse(body)
  if (!parsed.success) invalid("Agenda inválida: confira periodicidade, horário, formato e e-mails")
  const input = parsed.data
  const weekday = input.frequency === "weekly" ? input.weekday ?? invalid("Informe o dia da semana") : null
  const monthDay = input.frequency === "monthly" ? input.monthDay ?? invalid("Informe o dia do mês (1 a 28)") : null
  return { ...input, weekday, monthDay, recipients: [...new Set(input.recipients.map(email => email.toLowerCase()))] }
}
const scheduleFields = `id,definition_id,frequency,weekday,month_day,hour,format,recipients,active,revision,
  to_char(next_run_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS next_run_at`
function schedule(row: Record<string, unknown>) {
  return { id: row.id, definitionId: row.definition_id, frequency: row.frequency, weekday: row.weekday, monthDay: row.month_day, hour: row.hour, format: row.format,
    recipients: row.recipients, active: row.active, nextRunAt: row.next_run_at, revision: revisionValue(row.revision) }
}
const runFields = `id,schedule_id,status,format,recipients,row_count,file_name,error,
  to_char(scheduled_for AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS scheduled_for,
  to_char(finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS finished_at`
function run(row: Record<string, unknown>) {
  return { id: row.id, scheduleId: row.schedule_id, status: row.status, format: row.format, recipients: row.recipients, rowCount: row.row_count,
    fileName: row.file_name, error: row.error, scheduledFor: row.scheduled_for, finishedAt: row.finished_at }
}
async function loadSchedule(context: AuthorizedContext, id: string) {
  const row = (await context.client.query(`SELECT ${scheduleFields} FROM report_schedules WHERE tenant_id=$1 AND id=$2`, [context.tenantId, id])).rows[0]
  if (!row) throw new Problem(404, "not_found", "Agenda não encontrada nesta empresa")
  return schedule(row)
}
function sendFile(reply: import("fastify").FastifyReply, file: { content: Buffer; contentType: string; fileName: string }) {
  const ascii = file.fileName.replace(/[^A-Za-z0-9._-]/g, "_")
  return reply.header("cache-control", "no-store").header("content-type", file.contentType)
    .header("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`).send(file.content)
}

export function registerEngineRoutes(app: FastifyInstance, deps: AppDependencies) {
  app.get("/api/v1/reports/sources", async (request, reply) => {
    const body = await authorizeRequest(request, deps, async context => {
      requirePermission(context, "system.reports.read")
      return { tenantId: context.tenantId, data: visibleEngineCatalog(context.permissions), canEdit: context.permissions.includes("system.reports.manage") }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.post("/api/v1/reports/preview", async (request, reply) => {
    const body = await authorizeRequest(request, deps, async context => {
      requirePermission(context, "system.reports.read")
      const parsed = previewInput.safeParse(request.body)
      if (!parsed.success) invalid("Relatório inválido ou contém campos desconhecidos")
      const source = engineSource(parsed.data.dataset) ?? invalid("Fonte de dados inválida")
      if (!canUseSource(source, context.permissions)) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
      const layout = { name: parsed.data.name?.trim() || source.label, ...validateLayout(source, parsed.data) }
      const result = await executeReport(context, source, layout)
      return { tenantId: context.tenantId, data: { ...result, rows: result.rows.slice(0, previewRows) } }
    }, false, true)
    return reply.header("cache-control", "no-store").send(body)
  })

  app.get<{ Params: { id: string } }>("/api/v1/reports/definitions/:id/run", async (request, reply) => {
    const id = guid(request.params.id)
    const query = formatQuery.safeParse(request.query)
    if (!query.success) invalid("Formato inválido: use json, csv, xlsx ou pdf")
    const outcome = await authorizeRequest(request, deps, async context => {
      const { source, layout } = await loadEngineDefinition(context, id)
      const result = await executeReport(context, source, layout)
      if (query.data.format === "json") return { json: { tenantId: context.tenantId, data: { ...result, rows: result.rows.slice(0, previewRows) } } }
      return { file: await renderReport(result, query.data.format as ExportFormat, await documentMailCompany(context)) }
    }, false, true)
    if (outcome.file) return sendFile(reply, outcome.file)
    return reply.header("cache-control", "no-store").send(outcome.json)
  })

  app.get<{ Params: { id: string } }>("/api/v1/reports/definitions/:id/schedules", async (request, reply) => {
    const id = guid(request.params.id)
    const body = await authorizeRequest(request, deps, async context => {
      await loadEngineDefinition(context, id)
      const schedules = await context.client.query(`SELECT ${scheduleFields} FROM report_schedules WHERE tenant_id=$1 AND definition_id=$2 ORDER BY created_at,id`, [context.tenantId, id])
      const runs = await context.client.query(`SELECT ${runFields} FROM report_runs WHERE tenant_id=$1 AND definition_id=$2 ORDER BY scheduled_for DESC,id LIMIT 50`, [context.tenantId, id])
      return { tenantId: context.tenantId, data: schedules.rows.map(schedule), runs: runs.rows.map(run), formats: Object.keys(exportFormats), canEdit: context.permissions.includes("system.reports.manage") }
    })
    return reply.header("cache-control", "no-store").send(body)
  })

  app.post<{ Params: { id: string } }>("/api/v1/reports/definitions/:id/schedules", async (request, reply) => {
    const id = guid(request.params.id)
    const key = commandKey(request.headers["idempotency-key"])
    const body = await authorizeRequest(request, deps, async context => {
      requirePermission(context, "system.reports.manage")
      const input = parseSchedule(request.body)
      const saved = await replay(context, key, "report_schedule.create:" + id, input)
      if (saved) return saved as { tenantId: string; data: ReturnType<typeof schedule> }
      await loadEngineDefinition(context, id)
      const scheduleId = randomUUID()
      const next = nextRunAt({ frequency: input.frequency, weekday: input.weekday, monthDay: input.monthDay, hour: input.hour }, new Date())
      const inserted = await context.client.query(`INSERT INTO report_schedules(tenant_id,id,definition_id,owner_identity_id,frequency,weekday,month_day,hour,format,recipients,active,next_run_at)
        SELECT $1,$2,$3,i.id,$5,$6,$7,$8,$9,$10,$11,$12 FROM identities i JOIN tenant_memberships m ON m.identity_id=i.id AND m.tenant_id=$1 AND m.status='active'
        WHERE i.auth_subject=$4 RETURNING id`, [context.tenantId, scheduleId, id, context.authSubject, input.frequency, input.weekday, input.monthDay, input.hour, input.format, input.recipients, input.active, next])
      if (!inserted.rows.length) throw new Problem(403, "forbidden", "Acesso não autorizado para esta empresa")
      await record(context, request.headers, "report_schedule", scheduleId, "report_schedule.created", { definitionId: id, frequency: input.frequency, format: input.format, recipients: input.recipients.length })
      const result = { tenantId: context.tenantId, data: await loadSchedule(context, scheduleId) }
      await remember(context, key, "report_schedule.create:" + id, input, result)
      return result
    })
    return reply.code(201).header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })

  app.put<{ Params: { id: string } }>("/api/v1/reports/schedules/:id", async (request, reply) => {
    const id = guid(request.params.id, "Agenda não encontrada nesta empresa")
    const expected = parseRevision(request.headers["if-match"])
    const body = await authorizeRequest(request, deps, async context => {
      requirePermission(context, "system.reports.manage")
      const input = parseSchedule(request.body)
      const current = await loadSchedule(context, id)
      await loadEngineDefinition(context, current.definitionId as string)
      const next = nextRunAt({ frequency: input.frequency, weekday: input.weekday, monthDay: input.monthDay, hour: input.hour }, new Date())
      const changed = await context.client.query(`UPDATE report_schedules SET frequency=$3,weekday=$4,month_day=$5,hour=$6,format=$7,recipients=$8,active=$9,next_run_at=$10,revision=revision+1
        WHERE tenant_id=$1 AND id=$2 AND revision=$11 RETURNING id`, [context.tenantId, id, input.frequency, input.weekday, input.monthDay, input.hour, input.format, input.recipients, input.active, next, expected])
      if (!changed.rows.length) throw new Problem(412, "revision_conflict", "Outra pessoa alterou a agenda. Recarregue e tente de novo")
      const data = await loadSchedule(context, id)
      await record(context, request.headers, "report_schedule", id, "report_schedule.updated", { revision: data.revision, active: input.active, frequency: input.frequency })
      return { tenantId: context.tenantId, data }
    })
    return reply.header("cache-control", "no-store").header("etag", `"${body.data.revision}"`).send(body)
  })

  app.get<{ Params: { id: string } }>("/api/v1/reports/runs/:id/file", async (request, reply) => {
    const id = guid(request.params.id, "Execução não encontrada nesta empresa")
    const file = await authorizeRequest(request, deps, async context => {
      requirePermission(context, "system.reports.read")
      const row = (await context.client.query<{ content: Buffer | null; content_type: string | null; file_name: string | null; definition_id: string }>(
        "SELECT content,content_type,file_name,definition_id FROM report_runs WHERE tenant_id=$1 AND id=$2", [context.tenantId, id])).rows[0]
      if (!row) throw new Problem(404, "not_found", "Execução não encontrada nesta empresa")
      if (!row.content || !row.content_type || !row.file_name) throw new Problem(409, "file_unavailable", "Esta execução não gerou arquivo")
      return { content: row.content, contentType: row.content_type, fileName: row.file_name }
    }, false, true)
    return sendFile(reply, file)
  })
}
