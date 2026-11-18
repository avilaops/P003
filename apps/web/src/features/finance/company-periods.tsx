"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useCommand, useResource } from "@/hooks/use-operation"
import { dateLabel, fieldStyle, localDay } from "./finance-insights-model"

type Periods = {
  tenantId: string
  cutoff: string | null
  canClose: boolean
  canReopen: boolean
  history: { throughDate: string; action: "close" | "reopen"; actor: string; reason: string }[]
}
const endpoint = "/api/erp/finance/company-periods"
export function CompanyPeriods() {
  const resource = useResource<Periods>(endpoint),
    value = resource.value
  const command = useCommand(),
    [action, setAction] = useState("close"),
    [date, setDate] = useState(localDay),
    [reason, setReason] = useState("")
  if (resource.error) return resource.status === 403 ? null : <p role="alert">{resource.error}</p>
  if (!value) return null
  const canClose = value.canClose,
    canReopen = value.canReopen && Boolean(value.cutoff)
  const selected = canClose ? action : "reopen",
    day = selected === "close" ? date : (value.cutoff ?? "")
  return (
    <section className="mx-auto my-4 max-w-7xl space-y-3 rounded-md border p-4">
      <h2 className="font-semibold">Data limite financeira da empresa</h2>
      <p>
        {value.cutoff
          ? "Baixas e movimentos bloqueados até " + dateLabel(value.cutoff) + ", inclusive."
          : "Nenhum período fechado para toda a empresa."}
      </p>
      {(canClose || canReopen) && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault()
            const answer = await command.send(endpoint, value.tenantId, { action: selected, throughDate: day, reason })
            if (answer) {
              setReason("")
              setAction("close")
              resource.reload()
            }
          }}
        >
          <fieldset className="flex flex-wrap items-end gap-3" disabled={command.busy || command.uncertain}>
            <label className="grid gap-1">
              Ação
              <select className={fieldStyle} value={selected} onChange={(e) => setAction(e.target.value)}>
                {canClose && <option value="close">Fechar período da empresa</option>}
                {canReopen && <option value="reopen">Reabrir último período</option>}
              </select>
            </label>
            <label className="grid gap-1">
              Data limite
              <input
                className={fieldStyle}
                type="date"
                value={day}
                max={localDay()}
                required
                readOnly={selected === "reopen"}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label className="grid gap-1">
              Motivo
              <input
                className={fieldStyle}
                required
                minLength={3}
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </fieldset>
          <Button type="submit" disabled={command.busy}>
            {command.uncertain ? "Repetir confirmação" : "Confirmar " + (selected === "close" ? "fechamento" : "reabertura")}
          </Button>
        </form>
      )}
      {command.error && <p role="alert">{command.error}</p>}
      {value.history.length > 0 && (
        <details>
          <summary>Histórico de fechamentos da empresa</summary>
          <ul>
            {value.history.map((item, i) => (
              <li key={i}>
                {dateLabel(item.throughDate)} • {item.action === "close" ? "Fechado" : "Reaberto"} • {item.reason} • {item.actor}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
