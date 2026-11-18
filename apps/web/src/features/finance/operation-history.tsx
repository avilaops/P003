"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useCommand } from "@/hooks/use-operation"
import { dateLabel, fieldStyle, localDay, reais } from "./finance-insights-model"

export type OperationReview = {
  id: string
  status: "pending" | "approved" | "rejected"
  reason: string
  requestedAt: string
  schedule: { amount: string; dueOn: string }[]
  mayDecide: boolean
}
const labels = { pending: "Aguardando aprovação", approved: "Aprovada", rejected: "Recusada" }

export function OperationAction({
  id,
  tenantId,
  review,
  onSaved,
}: {
  id: string
  tenantId: string
  review?: boolean
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false),
    [day, setDay] = useState(localDay),
    [reason, setReason] = useState("")
  const [decision, setDecision] = useState<"approved" | "rejected">("approved")
  const command = useCommand()
  if (!open)
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {review ? "Decidir solicitação" : "Estornar operação"}
      </Button>
    )
  return (
    <form
      className="my-2 flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        const body = review ? { id, decision, reason } : { id, occurredOn: day, reason }
        const answer = await command.send(
          review ? "/api/erp/finance/operation-decisions" : "/api/erp/finance/operation-reversals",
          tenantId,
          body,
        )
        if (answer) {
          setOpen(false)
          onSaved()
        }
      }}
    >
      <fieldset disabled={command.busy || command.uncertain} className="flex flex-wrap items-end gap-2">
        {review ? (
          <label className="grid gap-1">
            Decisão
            <select className={fieldStyle} value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)}>
              <option value="approved">Aprovar</option>
              <option value="rejected">Recusar</option>
            </select>
          </label>
        ) : (
          <label className="grid gap-1">
            Data do estorno
            <input className={fieldStyle} type="date" value={day} onChange={(e) => setDay(e.target.value)} required />
          </label>
        )}
        <label className="grid gap-1">
          Justificativa
          <input
            className={fieldStyle}
            value={reason}
            minLength={3}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
            required
          />
        </label>
      </fieldset>
      <Button type="submit" disabled={command.busy}>
        {command.uncertain ? "Repetir confirmação" : review ? "Confirmar decisão" : "Confirmar estorno"}
      </Button>
      <Button type="button" variant="outline" disabled={command.busy || command.uncertain} onClick={() => setOpen(false)}>
        Cancelar
      </Button>
      {command.error && <span role="alert">{command.error}</span>}
    </form>
  )
}
export function ReviewHistory({
  reviews,
  tenantId,
  onSaved,
}: {
  reviews: OperationReview[]
  tenantId: string
  onSaved: () => void
}) {
  if (!reviews.length) return null
  return (
    <section className="space-y-2">
      <h3 className="font-semibold">Aprovações de renegociações</h3>
      {reviews.map((r) => (
        <article key={r.id} className="space-y-2 rounded-lg border p-3">
          <strong>{labels[r.status]}</strong>
          <p>
            {dateLabel(r.requestedAt.slice(0, 10))} • {r.reason}
          </p>
          <ul>
            {r.schedule.map((p, i) => (
              <li key={i}>
                Parcela {i + 1} • {dateLabel(p.dueOn)} • {reais(p.amount)}
              </li>
            ))}
          </ul>
          {r.mayDecide && <OperationAction id={r.id} review tenantId={tenantId} onSaved={onSaved} />}
        </article>
      ))}
    </section>
  )
}
