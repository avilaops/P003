"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCommand, useResource } from "@/hooks/use-operation"
import { useSuggestedPaymentMethod } from "./settings/use-suggested-payment-method"
import type { WalletName } from "./wallet-controls"

type Title = {
  id: string
  revision: number
  status: string
  dueDate: string
  outstandingAmount: string
  customerName?: string
  supplierName?: string
}
export function WalletBatch({
  wallet,
  tenantId,
  rows,
  reload,
}: {
  wallet: WalletName
  tenantId: string
  rows: Title[]
  reload: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">Baixa em lote</summary>
      {open && <BatchForm wallet={wallet} tenantId={tenantId} rows={rows} reload={reload} />}
    </details>
  )
}
function BatchForm({
  wallet,
  tenantId,
  rows,
  reload,
}: {
  wallet: WalletName
  tenantId: string
  rows: Title[]
  reload: () => void
}) {
  const accounts = useResource<{ data: { id: string; code: string; name: string }[] }>(
    "/api/erp/financial-accounts?status=active&limit=100",
  )
  const settings = useResource<{ accounts?: { id: string; code: string; name: string }[] }>(
    "/api/erp/financial-wallet-settings",
  )
  const command = useCommand(),
    suggested = useSuggestedPaymentMethod()
  const [message, setMessage] = useState(""),
    [selected, setSelected] = useState<string[]>([])
  const current = rows.filter((r) => r.status === "open")
  if (!current.length) return <p>Nenhum título em aberto nesta página.</p>
  return (
    <form
      className="form-section mt-2 space-y-4"
      onSubmit={async (e) => {
        e.preventDefault()
        const fields = new FormData(e.currentTarget)
        const items = current
          .filter((r) => selected.includes(r.id))
          .map((r) => ({
            id: r.id,
            revision: r.revision,
            payment: {
              amount: r.outstandingAmount,
              reference: String(fields.get("reference")),
              occurredOn: String(fields.get("day")),
              financialAccountId: String(fields.get("account")),
              method: suggested.method,
            },
          }))
        if (!items.length) return
        const saved = await command.send("/api/erp/" + wallet + "/payment-batches", tenantId, { items })
        if (saved) {
          setMessage(items.length + " baixa(s) confirmada(s).")
          setSelected([])
          reload()
        }
      }}
    >
      <fieldset disabled={command.busy || command.uncertain || command.stale} className="space-y-3">
        <legend>Selecione os títulos para liquidar o saldo integral na mesma conta e data.</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {current.map((r) => (
            <label key={r.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={selected.includes(r.id)}
                onChange={(e) =>
                  setSelected(e.target.checked ? [...selected, r.id] : selected.filter((id) => id !== r.id))
                }
              />
              {r.customerName ?? r.supplierName} • {r.dueDate} • R$ {r.outstandingAmount.replace(".", ",")}
            </label>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label>
            Conta financeira
            <select required className="block w-full rounded-md border p-2" name="account" defaultValue="">
              <option value="">Selecione</option>
              {(settings.value?.accounts ?? accounts.value?.data)?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} • {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Meio declarado
            <select
              className="block w-full rounded-md border p-2"
              value={suggested.method}
              onChange={(e) => suggested.setMethod(e.target.value)}
            >
              <option value="bank_transfer">Transferência</option>
              <option value="cash">Dinheiro</option>
              <option value="card">Cartão</option>
              <option value="other">Outro</option>
            </select>
          </label>
          <label>
            Data da baixa
            <Input required type="date" name="day" />
          </label>
          <label>
            Referência
            <Input required name="reference" minLength={3} maxLength={200} />
          </label>
        </div>
        <p className="text-sm text-muted-foreground">
          O lote aplica os juros e a multa configurados para cada vencimento. Um título que exige aprovação deve ser
          confirmado pela sua ficha.
        </p>
      </fieldset>
      {command.error && <p role="alert">{command.error}</p>}
      {message && <p role="status">{message}</p>}
      <Button type="submit" disabled={!selected.length || command.busy || command.stale}>
        {command.uncertain ? "Repetir confirmação do lote" : "Confirmar baixas selecionadas"}
      </Button>
      {command.stale && (
        <Button
          type="button"
          onClick={() => {
            command.reset()
            reload()
          }}
        >
          Recarregar títulos
        </Button>
      )}
    </form>
  )
}
