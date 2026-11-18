"use client"

import Link from "next/link"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { RequestError } from "@/components/feedback/session-recovery"
import { useCommand, useResource } from "@/hooks/use-operation"

export const brl = (cents: string) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(cents) / 100)
export async function readBankFile(file: File) {
  if (file.size > 2_000_000) throw new Error("Selecione um arquivo de até 2 MB")
  const bytes = await file.arrayBuffer()
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder("windows-1252").decode(bytes)
  }
}
type Line = {
  id: string
  fitId: string
  bookedOn: string
  cents: string
  description: string
  state: string
  reason: string | null
  suggestions: string[]
  entryIds: string[]
}
type Entry = { id: string; description: string; occurredOn: string; cents: string; reference: string | null }
type Closing = {
  throughDate: string
  reason: string
  closedBy: string
  reopenedAt: string | null
  reopenedBy: string | null
  reopenReason: string | null
}
type Result = {
  tenantId: string
  canEdit: boolean
  data: {
    lines: Line[]
    entries: Entry[]
    periods: Closing[]
    bank: { throughDate: string; cents: string } | null
    sessions: { id: string; register: string; status: string }[]
    canClose: boolean
    canReopen: boolean
  }
}
export function TreasuryReconciliation({
  accountId,
  tenantId,
  type,
}: {
  accountId: string
  tenantId: string
  type: string
}) {
  const [offset, setOffset] = useState(0),
    [entryOffset, setEntryOffset] = useState(0)
  const resource = useResource<Result>(
    `/api/erp/finance-treasury/reconciliation?accountId=${accountId}&offset=${offset}&entryOffset=${entryOffset}`,
  )
  const [selected, setSelected] = useState(""),
    [ids, setIds] = useState<string[]>([]),
    [reason, setReason] = useState(""),
    [end, setEnd] = useState("")
  const [file, setFile] = useState<File | null>(null),
    [format, setFormat] = useState("import-ofx"),
    [notice, setNotice] = useState("")
  const command = useCommand(),
    result = resource.value?.tenantId === tenantId ? resource.value : null,
    data = result?.data
  const disabled = command.busy || command.stale || command.uncertain
  const line = data?.lines.find((l) => l.id === selected)
  async function send(action: string, body: object) {
    const response = await command.send<{ tenantId: string; data: { imported?: number } }>(
      `/api/erp/finance-treasury/${action}`,
      tenantId,
      { accountId, ...body },
    )
    if (response?.tenantId === tenantId) {
      setNotice(
        response.data.imported === undefined
          ? "Operação registrada."
          : `${response.data.imported} lançamento(s) importado(s).`,
      )
      setSelected("")
      setIds([])
      setReason("")
      resource.reload()
    }
  }
  if (resource.error) return <RequestError message={resource.error} status={resource.status} />
  if (!data) return <p role="status">Carregando conciliação…</p>
  return (
    <section className="space-y-4 rounded-2xl border p-5">
      <h2 className="font-semibold">{type === "bank" ? "Conciliação bancária" : "Controle da conta"}</h2>
      {data.bank && (
        <p>
          Saldo bancário em {data.bank.throughDate} • <strong>{brl(data.bank.cents)}</strong>
        </p>
      )}
      {type === "bank" && (
        <>
          {result.canEdit && (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={async (e) => {
                e.preventDefault()
                if (file)
                  try {
                    await send(format, { content: await readBankFile(file) })
                  } catch (err) {
                    setNotice(String(err))
                  }
              }}
            >
              <label className="grid gap-1 text-sm">
                Formato
                <select
                  disabled={disabled}
                  className="h-9 rounded-md border bg-background px-2"
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                >
                  <option value="import-ofx">Extrato OFX</option>
                  <option value="import-cnab">Extrato Efí • CNAB 240</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Arquivo do banco
                <Input
                  disabled={disabled}
                  type="file"
                  required
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <Button type="submit" disabled={!file || disabled}>Importar extrato</Button>
            </form>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Linhas do banco</h3>
              {!data.lines.length && <p className="text-sm text-muted-foreground">Nenhuma linha nesta página.</p>}
              {data.lines.map((l) => (
                <label key={l.id} className="flex items-start gap-2 rounded-md border p-2 text-sm">
                  <input
                    type="radio"
                    name="bank-line"
                    disabled={disabled || l.state === "matched" || !result.canEdit}
                    checked={selected === l.id}
                    onChange={() => {
                      setSelected(l.id)
                      setIds([])
                      setReason("")
                    }}
                  />
                  <span>
                    {l.bookedOn} • {brl(l.cents)} • {l.description}
                    <small className="block text-muted-foreground">
                      {l.fitId} •{" "}
                      {l.state === "matched"
                        ? "Conciliado"
                        : l.state === "exception"
                          ? "Exceção justificada"
                          : "Pendente"}
                      {l.reason ? " • " + l.reason : ""}
                    </small>
                  </span>
                </label>
              ))}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!offset || disabled}
                  onClick={() => setOffset(offset - 50)}
                >
                  Anteriores
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={data.lines.length < 50 || disabled}
                  onClick={() => setOffset(offset + 50)}
                >
                  Próximas linhas
                </Button>
              </div>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">Movimentos do ERP disponíveis</h3>
              {!data.entries.length && (
                <p className="text-sm text-muted-foreground">Nenhum movimento disponível nesta página.</p>
              )}
              {data.entries.map((entry) => (
                <label key={entry.id} className="flex items-start gap-2 rounded-md border p-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={disabled || !line || !result.canEdit}
                    checked={ids.includes(entry.id)}
                    onChange={(e) => setIds(e.target.checked ? [...ids, entry.id] : ids.filter((i) => i !== entry.id))}
                  />
                  <span>
                    {entry.occurredOn} • {brl(entry.cents)} • {entry.description}
                    {entry.reference && <small className="block">{entry.reference}</small>}
                    {line?.suggestions.includes(entry.id) && (
                      <small className="block text-muted-foreground">Sugestão • mesma data e valor</small>
                    )}
                  </span>
                </label>
              ))}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!entryOffset || disabled}
                  onClick={() => setEntryOffset(entryOffset - 100)}
                >
                  Anteriores
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={data.entries.length < 100 || disabled}
                  onClick={() => setEntryOffset(entryOffset + 100)}
                >
                  Próximos movimentos
                </Button>
              </div>
            </section>
          </div>
          {line && result.canEdit && (
            <div className="space-y-2">
              <label className="grid gap-1 text-sm">
                Justificativa da diferença ou exceção
                <Input maxLength={500} value={reason} disabled={disabled} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!ids.length || disabled}
                  onClick={() => send("match", { lineId: line.id, entryIds: ids, reason: reason || null })}
                >
                  Conciliar {ids.length} movimento(s)
                </Button>
                <Button
                  variant="outline"
                  disabled={reason.trim().length < 3 || disabled}
                  onClick={() => send("exception", { lineId: line.id, reason })}
                >
                  Justificar exceção
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      {!!data.sessions.length && (
        <section className="space-y-2">
          <h3 className="font-semibold">Sessões do PDV</h3>
          {data.sessions.map((s) => (
            <Link className="block underline" key={s.id} href={`/vendas/pdv/fechamento?caixa=${s.id}`}>
              {s.register} • {s.status === "open" ? "Aberto" : "Fechado"}
            </Link>
          ))}
        </section>
      )}
      {(data.canClose || data.canReopen) && (
        <section className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-semibold">Fechamento por conta</h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-sm">
              Bloquear até
              <Input type="date" value={end} disabled={disabled} onChange={(e) => setEnd(e.target.value)} />
            </label>
            <label className="grid gap-1 text-sm">
              Motivo
              <Input maxLength={500} disabled={disabled} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            {data.canClose && (
              <Button
                disabled={!end || reason.trim().length < 3 || disabled}
                onClick={() => send("close-period", { throughDate: end, reason })}
              >
                Fechar período
              </Button>
            )}
            {data.canReopen && (
              <Button
                variant="outline"
                disabled={!end || reason.trim().length < 3 || disabled}
                onClick={() => send("reopen-period", { throughDate: end, reason })}
              >
                Reabrir período
              </Button>
            )}
          </div>
        </section>
      )}
      {data.periods.map((p, i) => (
        <p className="text-sm" key={p.throughDate + i}>
          {p.throughDate} • {p.reopenedAt ? "Reaberto" : "Fechado"} • {p.reopenedBy ?? p.closedBy} •{" "}
          {p.reopenReason ?? p.reason}
        </p>
      ))}
      {notice && <p role="status">{notice}</p>}
      {command.error && <RequestError message={command.error} status={command.status} />}
      {command.uncertain && (
        <Button variant="outline" disabled={command.busy} onClick={() => send("", {})}>
          Conferir última operação
        </Button>
      )}
    </section>
  )
}
