"use client"

import Link from "next/link"
import { useState } from "react"
import { PageHeader } from "@/components/page-header"
import { Button, buttonVariants } from "@/components/ui/button"
import { DataTable } from "@/components/workspace/data-table"
import { ErrorState, LoadingState } from "@/components/workspace/resource-state"
import { useCommand, useResource } from "@/hooks/use-operation"
import { field, formatLabels, frequencyLabels, runStatusLabels, scheduleLabel, weekdays, type ReportResult, type Run, type Schedule } from "./engine-model"
import { ReportTable } from "./report-table"

type RunReply = { tenantId: string; data: ReportResult }
type Schedules = { tenantId: string; data: Schedule[]; runs: Run[]; canEdit: boolean }
type ScheduleDraft = { frequency: Schedule["frequency"]; weekday: number; monthDay: number; hour: number; format: Schedule["format"]; recipients: string }
const emptySchedule: ScheduleDraft = { frequency: "weekly", weekday: 1, monthDay: 1, hour: 7, format: "xlsx", recipients: "" }
function payload(draft: ScheduleDraft, active = true) {
  return { frequency: draft.frequency, hour: draft.hour, format: draft.format, active, recipients: draft.recipients.split(/[\s,;]+/).filter(Boolean),
    ...(draft.frequency === "weekly" ? { weekday: draft.weekday } : {}), ...(draft.frequency === "monthly" ? { monthDay: draft.monthDay } : {}) }
}
const dateTime = (value: string) => new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })

export function SavedReportDetail({ id }: { id: string }) {
  const result = useResource<RunReply>(`/api/erp/reports/definitions/${id}/run`)
  const schedules = useResource<Schedules>(`/api/erp/reports/definitions/${id}/schedules`)
  const [draft, setDraft] = useState<ScheduleDraft>(emptySchedule)
  const [notice, setNotice] = useState("")
  const command = useCommand()
  const tenant = schedules.value?.tenantId ?? result.value?.tenantId ?? ""

  async function create() {
    const reply = await command.send<{ data: Schedule }>(`/api/erp/reports/definitions/${id}/schedules`, tenant, payload(draft))
    if (reply) { setNotice(`Agenda criada. Próximo envio: ${dateTime(reply.data.nextRunAt)}.`); setDraft(emptySchedule); schedules.reload() }
  }
  async function toggle(schedule: Schedule) {
    const base: ScheduleDraft = { frequency: schedule.frequency, weekday: schedule.weekday ?? 1, monthDay: schedule.monthDay ?? 1, hour: schedule.hour, format: schedule.format, recipients: schedule.recipients.join(",") }
    const reply = await command.send<{ data: Schedule }>(`/api/erp/reports/schedules/${schedule.id}`, tenant, payload(base, !schedule.active), `"${schedule.revision}"`, "PUT")
    if (reply) { setNotice(reply.data.active ? "Agenda reativada." : "Agenda pausada."); schedules.reload() }
  }

  const title = result.value?.data.title ?? "Relatório salvo"
  return <div className="workspace-page-frame space-y-4">
    <PageHeader eyebrow="Relatórios configuráveis" title={title} back={{ href: "/relatorios/configuraveis", label: "Relatórios configuráveis" }}
      actions={result.value ? <div className="flex flex-wrap gap-1.5">{(["csv", "xlsx", "pdf"] as const).map(format => <a key={format} className={buttonVariants({ size: "sm", variant: "outline" })} href={`/api/erp/reports/definitions/${id}/run?format=${format}`} download>{formatLabels[format]}</a>)}</div> : undefined} />
    {result.loading && !result.value && <LoadingState>Gerando relatório…</LoadingState>}
    {result.error && <ErrorState title="Relatório indisponível" message={result.error} status={result.status} onRetry={result.reload} />}
    {result.value && <ReportTable result={result.value.data} limit={500} />}

    <section aria-labelledby="schedule" className="space-y-2 rounded-lg border p-3">
      <h2 id="schedule" className="text-sm font-semibold">Envio agendado por e-mail</h2>
      {schedules.error && <p role="alert" className="text-xs text-destructive">{schedules.error}</p>}
      {schedules.value?.data.length ? <ul className="divide-y text-xs">{schedules.value.data.map(s => <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
        <span><strong className="font-medium">{scheduleLabel(s)}</strong> • {formatLabels[s.format]} • {s.recipients.join(", ")} • {s.active ? `próximo ${dateTime(s.nextRunAt)}` : "pausada"}</span>
        {schedules.value?.canEdit && <Button size="xs" variant="outline" disabled={command.busy} onClick={() => toggle(s)}>{s.active ? "Pausar" : "Reativar"}</Button>}
      </li>)}</ul> : schedules.value && <p className="text-xs text-muted-foreground">Nenhuma agenda para este relatório.</p>}
      {schedules.value?.canEdit && <div className="flex flex-wrap items-end gap-2 border-t pt-2 text-xs">
        <label className="grid gap-1 font-medium">Periodicidade<select className={field} value={draft.frequency} onChange={e => setDraft({ ...draft, frequency: e.target.value as ScheduleDraft["frequency"] })}>{Object.entries(frequencyLabels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {draft.frequency === "weekly" && <label className="grid gap-1 font-medium">Dia<select className={field} value={draft.weekday} onChange={e => setDraft({ ...draft, weekday: Number(e.target.value) })}>{weekdays.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>}
        {draft.frequency === "monthly" && <label className="grid gap-1 font-medium">Dia do mês<select className={field} value={draft.monthDay} onChange={e => setDraft({ ...draft, monthDay: Number(e.target.value) })}>{Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></label>}
        <label className="grid gap-1 font-medium">Horário<select className={field} value={draft.hour} onChange={e => setDraft({ ...draft, hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}h</option>)}</select></label>
        <label className="grid gap-1 font-medium">Formato<select className={field} value={draft.format} onChange={e => setDraft({ ...draft, format: e.target.value as ScheduleDraft["format"] })}>{Object.entries(formatLabels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="grid min-w-56 flex-1 gap-1 font-medium">E-mails (separe por vírgula)<input className={field} type="text" inputMode="email" value={draft.recipients} onChange={e => setDraft({ ...draft, recipients: e.target.value })} /></label>
        <Button size="sm" disabled={command.busy || !draft.recipients.trim()} onClick={create}>{command.busy ? "Salvando…" : "Agendar envio"}</Button>
      </div>}
      {command.error && <p role="alert" className="text-xs text-destructive">{command.error}</p>}
      {notice && <p role="status" className="text-xs">{notice}</p>}
    </section>

    <section aria-labelledby="runs" className="space-y-2">
      <h2 id="runs" className="text-sm font-semibold">Histórico de execução</h2>
      {schedules.value && !schedules.value.runs.length ? <p className="text-xs text-muted-foreground">Nenhum envio realizado ainda.</p> : schedules.value && <div className="overflow-x-auto rounded-md border"><DataTable className="text-xs">
        <thead><tr><th className="px-2 py-1.5">Ocorrência</th><th className="px-2 py-1.5">Situação</th><th className="px-2 py-1.5">Destinatários</th><th className="px-2 py-1.5 text-right">Linhas</th><th className="px-2 py-1.5">Arquivo</th></tr></thead>
        <tbody>{schedules.value.runs.map(run => <tr key={run.id} className="border-t">
          <td className="px-2 py-1">{dateTime(run.scheduledFor)}</td>
          <td className="px-2 py-1">{runStatusLabels[run.status]}{run.error ? <span className="block text-muted-foreground">{run.error}</span> : null}</td>
          <td className="px-2 py-1">{run.recipients.join(", ")}</td>
          <td className="px-2 py-1 text-right tabular-nums">{run.rowCount ?? "—"}</td>
          <td className="px-2 py-1">{run.fileName ? <a className="text-primary underline" href={`/api/erp/reports/runs/${run.id}/file`} download>{run.fileName}</a> : "—"}</td>
        </tr>)}</tbody>
      </DataTable></div>}
    </section>
    <p className="text-xs text-muted-foreground"><Link className="underline" href="/relatorios/configuraveis">Montar outro relatório</Link></p>
  </div>
}
