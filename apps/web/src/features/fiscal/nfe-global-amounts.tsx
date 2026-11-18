"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { allocateAmount, amountFields, amountTotal, type AmountKey } from "./nfe-amount-allocation"
import type { DraftInput, DraftItem } from "./nfe-draft-model"

export function NfeGlobalAmounts({ draft, change, onPendingChange }: { draft: DraftInput; change: (items: DraftItem[], totals: Partial<Record<AmountKey, string>>) => void; onPendingChange: (pending: boolean) => void }) {
  const [pending, setPending] = useState<Partial<Record<AmountKey, string>>>({})
  const [message, setMessage] = useState("")
  const [error, setError] = useState(false)
  function apply() {
    try {
      let items = draft.items
      for (const [key] of amountFields) if (pending[key] !== undefined) items = allocateAmount(items, key, pending[key]!)
      change(items, pending)
      setPending({})
      onPendingChange(false)
      setError(false)
      setMessage("Totais distribuídos proporcionalmente ao valor dos produtos.")
    } catch (reason) {
      setError(true)
      setMessage(reason instanceof Error ? reason.message : "Confira os valores.")
    }
  }
  return <section className="rounded-lg border bg-muted/10 p-3 space-y-3" aria-label="Frete e descontos da nota">
    <h3 className="text-sm font-semibold">Frete e descontos da nota</h3>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{amountFields.map(([key, label]) => <label className="grid gap-1 text-xs" key={key}>{label} total (R$)<Input className="h-8" inputMode="decimal" maxLength={17} value={pending[key] ?? (() => { try { return amountTotal(draft.items, key) } catch { return "" } })()} onChange={event => { setPending(previous => ({ ...previous, [key]: event.target.value })); setMessage(""); onPendingChange(true) }} /></label>)}</div>
    <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" disabled={!Object.keys(pending).length} onClick={apply}>Aplicar totais aos itens</Button>{!!Object.keys(pending).length && <Button type="button" variant="ghost" onClick={() => { setPending({}); onPendingChange(false); setMessage("") }}>Descartar totais digitados</Button>}<p className="text-xs text-muted-foreground">Nesta edição, o rateio acompanha alterações nos produtos e preserva ajustes individuais. Ao reabrir, os valores salvos são mantidos; aplique um total para reativar o rateio. Revise o frete por conta no transporte.</p></div>
    {!!Object.keys(pending).length && <p role="status" className="text-xs">Aplique os totais para atualizar os valores da nota.</p>}
    {message && <p role={error ? "alert" : "status"} className="text-xs">{message}</p>}
  </section>
}
