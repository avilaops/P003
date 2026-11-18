"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useCommand, useResource } from "@/hooks/use-operation"
import { dateLabel, fieldStyle, localDay, reais, sideLabels, type PortfolioRow, type Side } from "./finance-insights-model"

export const operationNames = {
  advance: "Adiantamento",
  allocation: "Aplicar adiantamento",
  offset: "Compensar entre carteiras",
  restructure: "Renegociar títulos",
  billing_group: "Agrupar cobrança",
}
type Kind = keyof typeof operationNames
export type FinancialOperation = {
  id: string
  kind: Kind
  reason: string
  side: Side
  occurredOn: string
  reversedOn: string | null
  reversalReason: string | null
  dueOn: string | null
  amount: string
  available: string
  items: { id: string; side: Side; amount: string }[]
}
type Props = {
  tenantId: string
  partyId: string
  writable: Side[]
  orders: { id: string; number: string; amount: string }[]
  group: boolean
  selected: PortfolioRow[]
  history: FinancialOperation[]
  onSaved: () => void
}
export function PartnerOperations({ tenantId, partyId, writable, orders, group, selected, history, onSaved }: Props) {
  const [kind, setKind] = useState<Kind>(group ? "billing_group" : "advance")
  const [side, setSide] = useState<Side>(group ? "receivable" : writable[0]!)
  const [date, setDate] = useState(localDay),
    [due, setDue] = useState(localDay),
    [reason, setReason] = useState("")
  const [amount, setAmount] = useState(""),
    [account, setAccount] = useState(""),
    [advance, setAdvance] = useState(""),
    [order, setOrder] = useState("")
  const [interest, setInterest] = useState("0,00"),
    [parts, setParts] = useState([{ dueOn: localDay(), amount: "" }])
  const [overrides, setOverrides] = useState<Record<string, string>>({}),
    [notice, setNotice] = useState("")
  const cmd = useCommand(),
    accounts = useResource<{ data: { id: string; name: string }[] }>(
      kind === "advance" ? "/api/erp/financial-accounts?status=active&limit=100" : "",
    )
  const selectedHere = selected.filter((r) => kind === "offset" || r.side === side)
  const locked = cmd.busy || cmd.uncertain || cmd.stale
  const options = (Object.keys(operationNames) as Kind[]).filter((k) =>
    group ? k === "billing_group" : k !== "billing_group" && (k !== "offset" || writable.length === 2),
  )
  const field = (label: string, value: string, change: (v: string) => void, type = "text") => (
    <label className="grid gap-1 text-sm">
      {label}
      <input className={fieldStyle} value={value} type={type} required onChange={(e) => change(e.target.value)} />
    </label>
  )
  async function save() {
    const base = { kind, side, partyId, occurredOn: date, reason }
    const targets = selectedHere.map((r) => ({
      id: r.id,
      side: r.side,
      revision: r.revision,
      amount: (overrides[r.id] ?? r.outstanding).replace(",", "."),
    }))
    let body: object
    switch (kind) {
      case "advance":
        body = { ...base, amount: amount.replace(",", "."), accountId: account, ...(order ? { orderId: order } : {}) }
        break
      case "allocation":
        body = { ...base, advanceId: advance, targets }
        break
      case "offset":
        body = { ...base, targets }
        break
      case "billing_group":
        body = { ...base, targets, dueOn: due }
        break
      case "restructure":
        body = {
          ...base,
          targets,
          schedule: parts.map((p) => ({ ...p, amount: p.amount.replace(",", ".") })),
          interest: interest.replace(",", "."),
        }
        break
    }
    const result = await cmd.send<{ tenantId: string; data: { id: string; kind: Kind; status?: string } }>(
      "/api/erp/finance/operations",
      tenantId,
      body,
    )
    if (result?.tenantId === tenantId) {
      setNotice(
        result.data.status === "pending" ? "Solicitação encaminhada para aprovação." : operationNames[kind] + " • registrada.",
      )
      setOverrides({})
      setReason("")
      onSaved()
    }
  }
  return (
    <form
      className="space-y-3 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <h3 className="font-semibold">{group ? "Nova cobrança agrupada" : "Nova operação"}</h3>
      <fieldset disabled={locked} className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          {!group && (
            <>
              <label className="grid gap-1 text-sm">
                Operação
                <select
                  className={fieldStyle}
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as Kind)
                    setOverrides({})
                    setNotice("")
                  }}
                >
                  {options.map((k) => (
                    <option value={k} key={k}>
                      {operationNames[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Carteira
                <select
                  className={fieldStyle}
                  value={side}
                  onChange={(e) => {
                    setSide(e.target.value as Side)
                    setOrder("")
                    setAdvance("")
                  }}
                >
                  {writable.map((w) => (
                    <option value={w} key={w}>
                      {sideLabels[w]}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {field("Data da operação", date, setDate, "date")}
          {field("Referência ou motivo", reason, setReason)}
        </div>
        {kind === "advance" ? (
          <div className="flex flex-wrap items-end gap-3">
            {field("Valor do adiantamento (R$)", amount, setAmount)}
            <label className="grid gap-1 text-sm">
              Conta movimentada
              <select className={fieldStyle} required value={account} onChange={(e) => setAccount(e.target.value)}>
                <option value="">Selecione</option>
                {accounts.value?.data.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            {side === "receivable" && orders.length > 0 && (
              <label className="grid gap-1 text-sm">
                Pedido do adiantamento
                <select className={fieldStyle} value={order} onChange={(e) => setOrder(e.target.value)}>
                  <option value="">Sem pedido</option>
                  {orders.map((o) => (
                    <option key={o.id} value={o.id}>
                      Pedido {o.number} • {reais(o.amount)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {accounts.error && <p role="alert">{accounts.error}</p>}
          </div>
        ) : (
          <>
            {kind === "allocation" && (
              <label className="grid max-w-md gap-1">
                Adiantamento disponível
                <select className={fieldStyle} required value={advance} onChange={(e) => setAdvance(e.target.value)}>
                  <option value="">Selecione</option>
                  {history
                    .filter((h) => h.kind === "advance" && h.side === side && h.available !== "0.00")
                    .map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.reason} • {dateLabel(h.occurredOn)} • {reais(h.available)}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {selectedHere.length === 0 ? (
              <p>Selecione os títulos na carteira acima.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {selectedHere.map((row) => (
                  <label key={row.id} className="grid gap-1 text-sm">
                    {sideLabels[row.side]} • {dateLabel(row.dueDate)} • valor aplicado (R$)
                    <input
                      className={fieldStyle}
                      inputMode="decimal"
                      required
                      readOnly={group}
                      value={overrides[row.id] ?? row.outstanding}
                      onChange={(e) => setOverrides({ ...overrides, [row.id]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
            )}
            {group && field("Vencimento da cobrança", due, setDue, "date")}
            {kind === "restructure" && (
              <div className="space-y-2">
                {field("Juros da renegociação (R$)", interest, setInterest)}
                <h4 className="font-medium">Novas parcelas</h4>
                {parts.map((p, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    {field(
                      "Vencimento • parcela " + (i + 1),
                      p.dueOn,
                      (v) => setParts(parts.map((x, n) => (n === i ? { ...x, dueOn: v } : x))),
                      "date",
                    )}
                    {field("Valor (R$)", p.amount, (v) => setParts(parts.map((x, n) => (n === i ? { ...x, amount: v } : x))))}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={parts.length === 1}
                      onClick={() => setParts(parts.filter((_, n) => n !== i))}
                    >
                      Remover parcela
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" onClick={() => setParts([...parts, { dueOn: date, amount: "" }])}>
                  Adicionar parcela
                </Button>
              </div>
            )}
          </>
        )}
      </fieldset>
      <Button type="submit" disabled={cmd.busy || cmd.stale || (kind !== "advance" && !selectedHere.length)}>
        {cmd.uncertain ? "Repetir confirmação" : "Confirmar operação"}
      </Button>
      {cmd.error && <p role="alert">{cmd.error}</p>}
      {notice && <p role="status">{notice}</p>}
    </form>
  )
}
