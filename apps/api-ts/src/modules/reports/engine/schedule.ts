import { randomUUID } from "node:crypto"
import type { DatabasePool } from "../../../platform/database.js"
import { withTenantTransaction } from "../../../platform/database.js"
import { documentMailCompany, renderDocumentEmail } from "../../../platform/document-mail-template.js"
import { sendDocumentMail, type DocumentMail, type MailOutcome } from "../../../platform/document-mail.js"
import { Problem } from "../../../platform/problem.js"
import { renderReport, type ExportFormat } from "./export.js"
import { loadEngineDefinition } from "./store.js"
import { executeReport } from "./run.js"

/** Envio do e-mail do relatório. Produção usa o n8n de `document-mail`; testes injetam um stub. */
export type ReportMailer = { send(mail: DocumentMail): Promise<MailOutcome> }
export const documentReportMailer: ReportMailer = { send: mail => sendDocumentMail(mail) }

export type Frequency = "daily" | "weekly" | "monthly"
export type ScheduleTiming = { frequency: Frequency; weekday: number | null; monthDay: number | null; hour: number }

// Horário de Brasília sem horário de verão (Decreto 9.772/2019): UTC−3 fixo.
const offsetHours = 3
/** Próxima ocorrência estritamente posterior a `after`. */
export function nextRunAt(timing: ScheduleTiming, after: Date) {
  const local = new Date(after.getTime() - offsetHours * 3_600_000)
  for (let day = 0; day <= 62; day++) {
    const candidate = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, timing.hour + offsetHours))
    const localDate = new Date(candidate.getTime() - offsetHours * 3_600_000)
    if (candidate <= after) continue
    if (timing.frequency === "weekly" && localDate.getUTCDay() !== timing.weekday) continue
    if (timing.frequency === "monthly" && localDate.getUTCDate() !== timing.monthDay) continue
    return candidate
  }
  throw new Error("Agenda sem próxima ocorrência")
}

type Claimed = { runId: string; scheduledFor: Date; definitionId: string; format: ExportFormat; recipients: string[] }

/** Transação do job sem identidade de usuário (descoberta e registro da execução). */
async function systemTransaction<T>(pool: DatabasePool, tenant: string, run: (client: Awaited<ReturnType<DatabasePool["connect"]>>) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.auth_subject','report-scheduler',true),set_config('app.discover_report_schedules','on',true)", [tenant])
    const result = await run(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    try { await client.query("ROLLBACK") } catch { /* mantém o erro original */ }
    throw error
  } finally { client.release() }
}

/** Reivindica a ocorrência devida: grava a execução (chave única) e avança a agenda. */
async function claim(pool: DatabasePool, tenant: string, scheduleId: string, now: Date): Promise<Claimed | null> {
  return systemTransaction(pool, tenant, async client => {
    const { rows: [schedule] } = await client.query<{ definition_id: string; frequency: Frequency; weekday: number | null; month_day: number | null; hour: number; format: ExportFormat; recipients: string[]; next_run_at: Date }>(
      `SELECT definition_id,frequency,weekday,month_day,hour,format,recipients,next_run_at FROM report_schedules
       WHERE tenant_id=$1 AND id=$2 AND active AND next_run_at<=$3 FOR UPDATE SKIP LOCKED`, [tenant, scheduleId, now])
    if (!schedule) return null
    const scheduledFor = new Date(schedule.next_run_at)
    // Uma ocorrência perdida é executada uma vez; as seguintes voltam ao calendário.
    const next = nextRunAt({ frequency: schedule.frequency, weekday: schedule.weekday, monthDay: schedule.month_day, hour: schedule.hour }, now > scheduledFor ? now : scheduledFor)
    await client.query("UPDATE report_schedules SET next_run_at=$3 WHERE tenant_id=$1 AND id=$2", [tenant, scheduleId, next])
    const runId = randomUUID()
    const inserted = await client.query(`INSERT INTO report_runs(tenant_id,id,schedule_id,definition_id,scheduled_for,status,format,recipients)
      VALUES($1,$2,$3,$4,$5,'sending',$6,$7) ON CONFLICT (tenant_id,schedule_id,scheduled_for) DO NOTHING RETURNING id`,
      [tenant, runId, scheduleId, schedule.definition_id, scheduledFor, schedule.format, schedule.recipients])
    if (!inserted.rows.length) return null
    return { runId, scheduledFor, definitionId: schedule.definition_id, format: schedule.format, recipients: schedule.recipients }
  })
}

type Outcome = { status: "sent" | "failed" | "unknown"; rowCount?: number; file?: { fileName: string; contentType: string; content: Buffer }; error?: string; deactivate?: boolean }

/** Executa uma ocorrência devida. Idempotente: a mesma ocorrência nunca é enviada duas vezes. */
export async function runSchedule(pool: DatabasePool, mailer: ReportMailer, tenant: string, scheduleId: string, ownerSubject: string, now: Date) {
  const claimed = await claim(pool, tenant, scheduleId, now)
  if (!claimed) return null
  let outcome: Outcome
  let mail: DocumentMail | undefined
  try {
    // Executa como o responsável: as mesmas permissões e a mesma visibilidade da tela.
    const prepared = await withTenantTransaction(pool, tenant, ownerSubject, async ctx => {
      const { definition, source, layout } = await loadEngineDefinition({ ...ctx, identity: { subject: ownerSubject, name: "", email: "", emailVerified: false } }, claimed.definitionId)
      const result = await executeReport({ ...ctx, identity: { subject: ownerSubject, name: "", email: "", emailVerified: false } }, source, layout)
      const company = await documentMailCompany(ctx)
      const file = await renderReport(result, claimed.format, company)
      return { definition, result, company, file }
    }, false, true)
    const { result, company, file } = prepared
    const email = renderDocumentEmail({
      company, title: result.title, attachments: [{ filename: file.fileName }],
      message: `Segue o relatório agendado "${result.title}".`,
      details: [{ label: "Fonte", value: result.sourceLabel }, ...result.filters.map(f => ({ label: f.label, value: f.value })), { label: "Linhas", value: String(result.rowCount) }],
    })
    mail = { id: claimed.runId, to: claimed.recipients, subject: `${result.title} • ${company}`.slice(0, 250), text: email.text, html: email.html,
      attachments: [{ filename: file.fileName, contentType: file.contentType, content: file.content }] }
    outcome = { status: "unknown", rowCount: result.rowCount, file }
  } catch (error) {
    if (!(error instanceof Problem)) throw error
    const lost = error.status === 403 || error.status === 404
    outcome = { status: "failed", error: lost ? "Relatório indisponível para o responsável (acesso, permissão ou definição removida). Agenda desativada." : error.message.slice(0, 500), deactivate: lost }
  }
  if (mail) outcome.status = await mailer.send(mail)
  await systemTransaction(pool, tenant, async client => {
    await client.query(`UPDATE report_runs SET status=$3,row_count=$4,file_name=$5,content_type=$6,content=$7,error=$8,finished_at=now()
      WHERE tenant_id=$1 AND id=$2`, [tenant, claimed.runId, outcome.status, outcome.rowCount ?? null, outcome.file?.fileName ?? null,
      outcome.file?.contentType ?? null, outcome.file?.content ?? null, outcome.error ?? (outcome.status === "failed" ? "O serviço de e-mail recusou o envio" : outcome.status === "unknown" ? "Envio sem confirmação do serviço de e-mail" : null)])
    if (outcome.deactivate) await client.query("UPDATE report_schedules SET active=false,revision=revision+1 WHERE tenant_id=$1 AND id=$2", [tenant, scheduleId])
  })
  return { runId: claimed.runId, status: outcome.status }
}

/** Uma rodada do job: descobre ocorrências devidas e executa cada uma. */
export async function processDueReports(pool: DatabasePool, mailer: ReportMailer, now = new Date(), failed: (error: unknown, tenant: string) => void = () => {}) {
  const discovery = await pool.connect()
  let due: { tenant_id: string; schedule_id: string; auth_subject: string }[]
  try {
    due = (await discovery.query<{ tenant_id: string; schedule_id: string; auth_subject: string }>("SELECT tenant_id,schedule_id,auth_subject FROM report_due_schedules($1)", [now])).rows
    // Execuções interrompidas (processo reiniciado) ficam marcadas como incertas; nunca são reenviadas.
  } finally { discovery.release() }
  const results = []
  for (const row of due) {
    try { results.push(await runSchedule(pool, mailer, String(row.tenant_id), String(row.schedule_id), row.auth_subject, now)) }
    catch (error) { failed(error, String(row.tenant_id)) }
  }
  return results.filter(Boolean)
}

export function startReportScheduler(pool: DatabasePool, mailer: ReportMailer = documentReportMailer, log: (error: unknown, tenant?: string) => void = () => {}) {
  let running: Promise<unknown> | undefined
  const tick = () => {
    if (running) return
    running = processDueReports(pool, mailer, new Date(), log).catch(error => log(error)).finally(() => { running = undefined })
  }
  const timer = setInterval(tick, 60_000)
  timer.unref()
  tick()
  return async () => { clearInterval(timer); await running }
}
